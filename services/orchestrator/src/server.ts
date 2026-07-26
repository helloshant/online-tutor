import express from "express";
import type { NextFunction, Request, Response } from "express";
import { findAnswerInBank, recordAnswer } from "./answerBank.js";
import { validateAnswerForStorage } from "./answerValidation.js";
import { deleteCachedAnswer, getCachedAnswer, setCachedAnswer } from "./cache.js";
import { getActiveLlmProvider, getChatReply } from "./llm.js";
import { recordChatEvent } from "./observabilityClient.js";
import { buildStaffSystemPrompt, buildTutorSystemPrompt } from "./prompts.js";
import { isQuestionInSyllabus, SYLLABUS_REJECTION_MESSAGE } from "./syllabusGate.js";
import type { AnswerScope, ChatOrchestrationRequest, ChatOrchestrationResponse } from "./types.js";

const PORT = Number(process.env.PORT) || 4000;
const MAX_TOKENS = 1536;
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

app.listen(PORT, () => {
  console.log(`Orchestration service listening on port ${PORT}`);
});
