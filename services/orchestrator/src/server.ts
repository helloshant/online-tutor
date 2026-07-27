import express from "express";
import type { NextFunction, Request, Response } from "express";
import { findAnswerInBank, findRelevantExercises, recordAnswer } from "./answerBank.js";
import { validateAnswerForStorage } from "./answerValidation.js";
import { deleteCachedAnswer, getCachedAnswer, setCachedAnswer } from "./cache.js";
import { parseGeneratedExercises } from "./exerciseParser.js";
import { getActiveLlmProvider, getChatReply } from "./llm.js";
import { recordChatEvent } from "./observabilityClient.js";
import {
  buildExerciseGenerationPrompt,
  buildStaffSystemPrompt,
  buildTopicSummaryPrompt,
  buildTutorSystemPrompt,
} from "./prompts.js";
import { isQuestionInSyllabus, SYLLABUS_REJECTION_MESSAGE } from "./syllabusGate.js";
import { getStoredTopicSummary, storeTopicSummary } from "./topicSummary.js";
import type {
  AnswerScope,
  ChatOrchestrationRequest,
  ChatOrchestrationResponse,
  Medium,
  TopicExercisesRequest,
  TopicExercisesResponse,
  TopicSummaryRequest,
  TopicSummaryResponse,
} from "./types.js";

const PORT = Number(process.env.PORT) || 4000;
const MAX_TOKENS = 1536;
const SUMMARY_MAX_TOKENS = 700;
const EXERCISE_MAX_TOKENS = 2048;
const EXERCISE_GENERATION_COUNT = 5;
const SHARED_SECRET = process.env.ORCHESTRATOR_SHARED_SECRET;

if (!SHARED_SECRET) {
  console.warn(
    "WARNING: ORCHESTRATOR_SHARED_SECRET is not set. This service will accept requests from " +
      "anyone who can reach it on the network. Set it before exposing this service beyond a " +
      "trusted internal network (e.g. the docker-compose network)."
  );
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

function requireSharedSecret(req: Request, res: Response, next: NextFunction) {
  if (!SHARED_SECRET) {
    next();
    return;
  }
  if (req.header("x-internal-api-key") !== SHARED_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.post("/v1/chat", requireSharedSecret, async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const body = req.body as Partial<ChatOrchestrationRequest> | undefined;

  if (!body || (body.mode !== "student" && body.mode !== "staff")) {
    res.status(400).json({ error: "mode must be 'student' or 'staff'" });
    return;
  }
  if (typeof body.userId !== "string" || !body.userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  if (typeof body.subjectId !== "string" || !body.subjectId) {
    res.status(400).json({ error: "subjectId is required" });
    return;
  }
  if (typeof body.subjectName !== "string" || !body.subjectName.trim()) {
    res.status(400).json({ error: "subjectName is required" });
    return;
  }
  if (typeof body.message !== "string" || !body.message.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  const history = Array.isArray(body.history) ? body.history : [];

  // Staff chat is deliberately unrestricted (no board/grade/syllabus) and
  // isn't tied to a subscription, so it sits outside the whole
  // gate/cache/database pipeline below -- straight to the LLM, as before.
  // It still gets reported to observability, since staff LLM calls consume
  // real tokens and cost real money too.
  if (body.mode === "staff") {
    try {
      const { text, model, usage } = await getChatReply({
        systemPrompt: buildStaffSystemPrompt(body.subjectName),
        history,
        message: body.message,
        maxTokens: MAX_TOKENS,
      });
      void recordChatEvent({
        userId: body.userId,
        mode: "staff",
        subjectId: body.subjectId,
        question: body.message,
        source: "llm",
        provider: getActiveLlmProvider(),
        model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        latencyMs: Date.now() - startedAt,
      });
      const response: ChatOrchestrationResponse = { reply: text, source: "llm" };
      res.json(response);
    } catch (err) {
      console.error("LLM chat completion failed:", err);
      res.status(502).json({ error: "The tutor is temporarily unavailable. Please try again shortly." });
    }
    return;
  }

  const studentBody = body as Extract<ChatOrchestrationRequest, { mode: "student" }>;
  if (
    typeof studentBody.boardId !== "string" ||
    !studentBody.boardId ||
    typeof studentBody.gradeId !== "string" ||
    !studentBody.gradeId ||
    typeof studentBody.boardName !== "string" ||
    typeof studentBody.gradeName !== "string" ||
    typeof studentBody.medium !== "string" ||
    !Array.isArray(studentBody.topics)
  ) {
    res.status(400).json({
      error: "boardId, gradeId, boardName, gradeName, medium, and topics are required for mode='student'",
    });
    return;
  }

  // Stage 1: syllabus scope gate. Only judged on the opening message of a
  // topic (see syllabusGate.ts) -- reject before spending a cache lookup, a
  // database query, or an LLM call on an obviously out-of-syllabus question.
  if (
    !isQuestionInSyllabus({
      subjectName: studentBody.subjectName,
      topics: studentBody.topics,
      message: studentBody.message,
      history,
    })
  ) {
    void recordChatEvent({
      userId: studentBody.userId,
      mode: "student",
      boardId: studentBody.boardId,
      gradeId: studentBody.gradeId,
      subjectId: studentBody.subjectId,
      medium: studentBody.medium,
      question: studentBody.message,
      source: "rejected",
      latencyMs: Date.now() - startedAt,
    });
    const response: ChatOrchestrationResponse = { reply: SYLLABUS_REJECTION_MESSAGE, source: "rejected" };
    res.json(response);
    return;
  }

  // Stages 2-3 (cache, then the Postgres answer bank) only apply to a fresh
  // question, not a follow-up ("explain more", "why?") -- those depend on
  // conversation context that a scope-only lookup key can't capture, so
  // serving one from cache/db risks answering the wrong thing. Follow-ups go
  // straight to the LLM and are never written back into cache/db.
  const isFreshQuestion = history.length === 0;
  const scope: AnswerScope | null = isFreshQuestion
    ? {
        boardId: studentBody.boardId,
        gradeId: studentBody.gradeId,
        subjectId: studentBody.subjectId,
        medium: studentBody.medium,
        question: studentBody.message,
      }
    : null;

  if (scope) {
    const cached = await getCachedAnswer(scope);
    if (cached) {
      void recordChatEvent({
        userId: studentBody.userId,
        mode: "student",
        boardId: scope.boardId,
        gradeId: scope.gradeId,
        subjectId: scope.subjectId,
        medium: scope.medium,
        question: scope.question,
        source: "cache",
        latencyMs: Date.now() - startedAt,
      });
      const response: ChatOrchestrationResponse = { reply: cached, source: "cache" };
      res.json(response);
      return;
    }

    const fromBank = await findAnswerInBank(scope);
    if (fromBank) {
      // Cache missed but the database had it -- populate cache so the next
      // ask of this same question is an L1 hit.
      void setCachedAnswer(scope, fromBank.answer);
      void recordChatEvent({
        userId: studentBody.userId,
        mode: "student",
        boardId: scope.boardId,
        gradeId: scope.gradeId,
        subjectId: scope.subjectId,
        medium: scope.medium,
        question: scope.question,
        source: "database",
        answerBankId: fromBank.id,
        latencyMs: Date.now() - startedAt,
      });
      const response: ChatOrchestrationResponse = { reply: fromBank.answer, source: "database" };
      res.json(response);
      return;
    }
  }

  // Stage 4: LLM fallback.
  const systemPrompt = buildTutorSystemPrompt({
    subjectName: studentBody.subjectName,
    boardName: studentBody.boardName,
    gradeName: studentBody.gradeName,
    medium: studentBody.medium,
    topics: studentBody.topics,
    message: studentBody.message,
  });

  try {
    const { text, model, usage } = await getChatReply({
      systemPrompt,
      history,
      message: studentBody.message,
      maxTokens: MAX_TOKENS,
    });

    if (scope) {
      const validation = validateAnswerForStorage(text);
      if (validation.store) {
        void recordAnswer(scope, text, validation.status);
        // Only cache (i.e. let it be replayed to other students) once it's
        // confident enough to auto-approve -- a pending_review answer stays
        // out of both the cache and the servable side of the answer bank
        // until an admin confirms it.
        if (validation.status === "auto_approved") {
          void setCachedAnswer(scope, text);
        }
      }
    }

    void recordChatEvent({
      userId: studentBody.userId,
      mode: "student",
      boardId: studentBody.boardId,
      gradeId: studentBody.gradeId,
      subjectId: studentBody.subjectId,
      medium: studentBody.medium,
      question: studentBody.message,
      source: "llm",
      provider: getActiveLlmProvider(),
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      latencyMs: Date.now() - startedAt,
    });

    const response: ChatOrchestrationResponse = { reply: text, source: "llm" };
    res.json(response);
  } catch (err) {
    console.error("LLM chat completion failed:", err);
    res.status(502).json({ error: "The tutor is temporarily unavailable. Please try again shortly." });
  }
});

// Called by the web app's admin answer-bank review page when an entry is
// rejected or deleted, so the demoted/removed answer stops being served
// from cache right away instead of surviving until its TTL runs out. The
// web app has the full scope (it's rendering the row already), so it's
// passed through directly rather than looked up here.
app.post("/v1/cache/invalidate", requireSharedSecret, async (req: Request, res: Response) => {
  const body = req.body as Partial<AnswerScope> | undefined;

  if (
    !body ||
    typeof body.boardId !== "string" ||
    !body.boardId ||
    typeof body.gradeId !== "string" ||
    !body.gradeId ||
    typeof body.subjectId !== "string" ||
    !body.subjectId ||
    typeof body.medium !== "string" ||
    !body.medium ||
    typeof body.question !== "string" ||
    !body.question
  ) {
    res.status(400).json({ error: "boardId, gradeId, subjectId, medium, and question are required" });
    return;
  }

  await deleteCachedAnswer(body as AnswerScope);
  res.json({ ok: true });
});

// Reached when a student clicks a topic in the syllabus panel. Checks the
// durable store first (one summary per topic, reused by every student who
// clicks that same topic); only calls the LLM on a miss, and stores the
// result so the next click of this topic -- by anyone -- is a database hit.
app.post("/v1/topic-summary", requireSharedSecret, async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const body = req.body as Partial<TopicSummaryRequest> | undefined;

  if (
    !body ||
    typeof body.userId !== "string" ||
    !body.userId ||
    typeof body.topicId !== "string" ||
    !body.topicId ||
    typeof body.subjectName !== "string" ||
    typeof body.boardName !== "string" ||
    typeof body.gradeName !== "string" ||
    typeof body.medium !== "string" ||
    typeof body.chapter !== "string" ||
    typeof body.topic !== "string"
  ) {
    res.status(400).json({
      error: "userId, topicId, subjectName, boardName, gradeName, medium, chapter, and topic are required",
    });
    return;
  }

  const existing = await getStoredTopicSummary(body.topicId);
  if (existing) {
    const response: TopicSummaryResponse = { summary: existing, source: "database" };
    res.json(response);
    return;
  }

  try {
    const systemPrompt = buildTopicSummaryPrompt({
      subjectName: body.subjectName,
      boardName: body.boardName,
      gradeName: body.gradeName,
      medium: body.medium as Medium,
      chapter: body.chapter,
      topic: body.topic,
    });
    const { text, model, usage } = await getChatReply({
      systemPrompt,
      history: [],
      message: "Write the summary now.",
      maxTokens: SUMMARY_MAX_TOKENS,
    });

    await storeTopicSummary(body.topicId, text);

    void recordChatEvent({
      userId: body.userId,
      mode: "student",
      subjectId: "",
      question: `topic-summary: ${body.chapter} / ${body.topic}`,
      source: "llm",
      provider: getActiveLlmProvider(),
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      latencyMs: Date.now() - startedAt,
    });

    const response: TopicSummaryResponse = { summary: text, source: "llm" };
    res.json(response);
  } catch (err) {
    console.error("Topic summary generation failed:", err);
    res.status(502).json({ error: "Could not generate a summary right now. Please try again shortly." });
  }
});

// Reached when a student clicks "Relevant Exercises" under a topic summary.
// Searches the answer bank for exercises already generated for this topic
// (by anyone) before generating fresh ones -- same fall-through-to-LLM
// philosophy as the chat pipeline's cache/database/LLM stages.
app.post("/v1/topic-exercises", requireSharedSecret, async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const body = req.body as Partial<TopicExercisesRequest> | undefined;

  if (
    !body ||
    typeof body.userId !== "string" ||
    !body.userId ||
    typeof body.boardId !== "string" ||
    !body.boardId ||
    typeof body.gradeId !== "string" ||
    !body.gradeId ||
    typeof body.subjectId !== "string" ||
    !body.subjectId ||
    typeof body.subjectName !== "string" ||
    typeof body.boardName !== "string" ||
    typeof body.gradeName !== "string" ||
    typeof body.medium !== "string" ||
    typeof body.chapter !== "string" ||
    typeof body.topic !== "string"
  ) {
    res.status(400).json({
      error:
        "userId, boardId, gradeId, subjectId, subjectName, boardName, gradeName, medium, chapter, and topic are required",
    });
    return;
  }

  const scope = {
    boardId: body.boardId,
    gradeId: body.gradeId,
    subjectId: body.subjectId,
    medium: body.medium as Medium,
  };
  const query = `${body.chapter} ${body.topic}`;

  const found = await findRelevantExercises(scope, query);
  if (found.length > 0) {
    const response: TopicExercisesResponse = {
      exercises: found.map(({ question, answer }) => ({ question, answer })),
      source: "database",
    };
    res.json(response);
    return;
  }

  try {
    const systemPrompt = buildExerciseGenerationPrompt({
      subjectName: body.subjectName,
      boardName: body.boardName,
      gradeName: body.gradeName,
      medium: scope.medium,
      chapter: body.chapter,
      topic: body.topic,
      count: EXERCISE_GENERATION_COUNT,
    });
    const { text, model, usage } = await getChatReply({
      systemPrompt,
      history: [],
      message: "Generate the exercises now.",
      maxTokens: EXERCISE_MAX_TOKENS,
    });

    const parsed = parseGeneratedExercises(text);
    const stored: { question: string; answer: string }[] = [];
    for (const exercise of parsed) {
      const validation = validateAnswerForStorage(exercise.answer);
      if (!validation.store) continue;
      await recordAnswer({ ...scope, question: exercise.question }, exercise.answer, validation.status);
      stored.push(exercise);
    }

    void recordChatEvent({
      userId: body.userId,
      mode: "student",
      boardId: scope.boardId,
      gradeId: scope.gradeId,
      subjectId: scope.subjectId,
      medium: scope.medium,
      question: `topic-exercises: ${body.chapter} / ${body.topic}`,
      source: "llm",
      provider: getActiveLlmProvider(),
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      latencyMs: Date.now() - startedAt,
    });

    const response: TopicExercisesResponse = { exercises: stored, source: "llm" };
    res.json(response);
  } catch (err) {
    console.error("Exercise generation failed:", err);
    res.status(502).json({ error: "Could not generate exercises right now. Please try again shortly." });
  }
});

app.listen(PORT, () => {
  console.log(`Orchestration service listening on port ${PORT}`);
});
