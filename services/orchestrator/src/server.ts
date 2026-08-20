import express from "express";
import type { NextFunction, Request, Response } from "express";
import { findAnswerInBank, findRelevantExercises, recordAnswer } from "./answerBank.js";
import { validateAnswerForStorage } from "./answerValidation.js";
import {
  deleteCachedAnswer,
  deleteCachedTopicSummary,
  getCachedAnswer,
  getCachedTopicSummary,
  setCachedAnswer,
  setCachedTopicSummary,
} from "./cache.js";
import {
  embedAndStoreChapterDocument,
  embedAndStorePrechunkedDocument,
  getStoredChapterSummary,
} from "./chapterDocuments.js";
import { findRelevantChapterChunks } from "./chapterRag.js";
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
import { getStoredTopicSummary, upsertTopicSummary } from "./topicSummary.js";
import type {
  AnswerScope,
  ChapterDocumentEmbedRequest,
  ChapterDocumentEmbedResponse,
  ChapterDocumentImportChunksRequest,
  ChatOrchestrationRequest,
  ChatOrchestrationResponse,
  ImageAttachment,
  ImageMediaType,
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

const ALLOWED_IMAGE_TYPES = new Set<ImageMediaType>(["image/jpeg", "image/png", "image/gif", "image/webp"]);
// ~4.3MB decoded (base64 runs ~37% larger than raw bytes) -- comfortably
// under the JSON body limit below, which also has to fit the rest of the
// request (history, syllabus topics, etc).
const MAX_IMAGE_BASE64_LENGTH = 6_000_000;

if (!SHARED_SECRET) {
  console.warn(
    "WARNING: ORCHESTRATOR_SHARED_SECRET is not set. This service will accept requests from " +
      "anyone who can reach it on the network. Set it before exposing this service beyond a " +
      "trusted internal network (e.g. the docker-compose network)."
  );
}

const app = express();
// Raised from the original 1mb to fit a base64-encoded screenshot/photo.
app.use(express.json({ limit: "8mb" }));

// Returns `undefined` when no image was sent (valid -- most requests have
// none), an ImageAttachment when one was and it's valid, or throws-shaped
// via the returned `error` string when one was sent but malformed.
function parseImageField(raw: unknown): { image?: ImageAttachment; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object") return { error: "image must be an object" };

  const { mediaType, base64 } = raw as { mediaType?: unknown; base64?: unknown };
  if (typeof mediaType !== "string" || !ALLOWED_IMAGE_TYPES.has(mediaType as ImageMediaType)) {
    return { error: "image.mediaType must be one of image/jpeg, image/png, image/gif, image/webp" };
  }
  if (typeof base64 !== "string" || !base64) {
    return { error: "image.base64 is required" };
  }
  if (base64.length > MAX_IMAGE_BASE64_LENGTH) {
    return { error: "image is too large" };
  }
  return { image: { mediaType: mediaType as ImageMediaType, base64 } };
}

// Includes non-secret configuration presence (never the keys themselves) so
// a deployment where LLM calls succeed but nothing lands in Postgres --
// exactly the failure mode of a missing/misconfigured SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY -- can be diagnosed with a single request
// instead of having to dig through container logs or guess at env vars.
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    answerBank: {
      // The URL itself isn't secret and is the fastest way to spot "pointed
      // at the wrong Supabase project" from outside the container.
      supabaseUrl: process.env.SUPABASE_URL || null,
      configured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
    cache: { configured: Boolean(process.env.REDIS_URL) },
    observability: { configured: Boolean(process.env.OBSERVABILITY_URL) },
  });
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
  if (typeof body.message !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }
  const { image, error: imageError } = parseImageField((body as { image?: unknown }).image);
  if (imageError) {
    res.status(400).json({ error: imageError });
    return;
  }
  // A screenshot/photo carries its own content -- an empty caption is only
  // invalid when there's nothing else attached.
  if (!body.message.trim() && !image) {
    res.status(400).json({ error: "message or image is required" });
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
        systemPrompt: buildStaffSystemPrompt(body.subjectName, Boolean(image)),
        history,
        message: body.message,
        image,
        maxTokens: MAX_TOKENS,
      });
      void recordChatEvent({
        userId: body.userId,
        mode: "staff",
        subjectId: body.subjectId,
        question: body.message.trim() || "[Image question]",
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
      question: studentBody.message.trim() || "[Image question]",
      source: "rejected",
      latencyMs: Date.now() - startedAt,
    });
    const response: ChatOrchestrationResponse = { reply: SYLLABUS_REJECTION_MESSAGE, source: "rejected" };
    res.json(response);
    return;
  }

  // Stages 2-3 (cache, then the Postgres answer bank) only apply to a fresh,
  // text-only question, not a follow-up ("explain more", "why?") -- those
  // depend on conversation context that a scope-only lookup key can't
  // capture, so serving one from cache/db risks answering the wrong thing.
  // An image-bearing question is excluded the same way: the lookup key is
  // the message text, which doesn't represent what's actually in the image,
  // so a text match here would be coincidental at best and wrong at worst.
  // Both cases go straight to the LLM and are never written back into
  // cache/db.
  const isFreshQuestion = history.length === 0;
  const scope: AnswerScope | null =
    isFreshQuestion && !image
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

  // Stage 4: LLM fallback. Semantic retrieval against admin-authored
  // chapter documents (see chapterRag.ts) runs here, not alongside the
  // cache/answer-bank stages above -- those need an exact-enough question
  // match to short-circuit the LLM call entirely, while this only ever
  // *augments* the prompt the LLM is about to see, so it applies to any
  // text question reaching this point (including a follow-up like "explain
  // more", unlike the fresh-question-only cache/database stages) rather
  // than being gated on isFreshQuestion. Skipped for an image-only message
  // (nothing to embed) and, same as the syllabus gate, has nothing to do in
  // staff mode (unrestricted, no single subject's chapter notes to ground
  // it in).
  const referenceChunks = studentBody.message.trim()
    ? await findRelevantChapterChunks(
        {
          boardId: studentBody.boardId,
          gradeId: studentBody.gradeId,
          subjectId: studentBody.subjectId,
          medium: studentBody.medium,
        },
        studentBody.message
      )
    : [];

  const systemPrompt = buildTutorSystemPrompt({
    subjectName: studentBody.subjectName,
    boardName: studentBody.boardName,
    gradeName: studentBody.gradeName,
    medium: studentBody.medium,
    topics: studentBody.topics,
    message: studentBody.message,
    hasImage: Boolean(image),
    referenceChunks,
  });

  try {
    const { text, model, usage } = await getChatReply({
      systemPrompt,
      history,
      message: studentBody.message,
      image,
      maxTokens: MAX_TOKENS,
    });

    if (scope) {
      const validation = validateAnswerForStorage(text);
      if (validation.store) {
        void recordAnswer(scope, text, validation.status).then((saved) => {
          if (!saved) console.error("Failed to store this chat answer in the answer bank.");
        });
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
      question: studentBody.message.trim() || "[Image question]",
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

// Called by the web app's admin Chapter Notes action right after it writes
// or updates a chapter_documents row -- this service holds the only Voyage
// credentials in the whole app (same reasoning ANTHROPIC_API_KEY never
// reaches the web app), so embedding has to happen here even though the raw
// document itself is written directly by the web app's own service-role
// client, not through this service.
app.post("/v1/chapter-documents/embed", requireSharedSecret, async (req: Request, res: Response) => {
  const body = req.body as Partial<ChapterDocumentEmbedRequest> | undefined;

  if (
    !body ||
    typeof body.documentId !== "string" ||
    !body.documentId ||
    typeof body.topicId !== "string" ||
    !body.topicId ||
    typeof body.boardId !== "string" ||
    !body.boardId ||
    typeof body.gradeId !== "string" ||
    !body.gradeId ||
    typeof body.subjectId !== "string" ||
    !body.subjectId ||
    typeof body.medium !== "string" ||
    !body.medium ||
    typeof body.content !== "string"
  ) {
    res.status(400).json({
      error: "documentId, topicId, boardId, gradeId, subjectId, medium, and content are required",
    });
    return;
  }

  const result = await embedAndStoreChapterDocument(
    body.documentId,
    {
      topicId: body.topicId,
      boardId: body.boardId,
      gradeId: body.gradeId,
      subjectId: body.subjectId,
      medium: body.medium as Medium,
    },
    body.content
  );

  const response: ChapterDocumentEmbedResponse = result;
  res.json(response);
});

// Sibling of /v1/chapter-documents/embed above, for the pre-chunked JSON
// import path (src/app/admin/chapter-notes/import-chunks-form.tsx) --
// `chunks` are already split along real structural boundaries by whoever
// prepared the JSON, so this skips chunkText() entirely and embeds each
// piece as given, preserving its own field_type/citation.
app.post("/v1/chapter-documents/import-chunks", requireSharedSecret, async (req: Request, res: Response) => {
  const body = req.body as Partial<ChapterDocumentImportChunksRequest> | undefined;

  if (
    !body ||
    typeof body.documentId !== "string" ||
    !body.documentId ||
    typeof body.topicId !== "string" ||
    !body.topicId ||
    typeof body.boardId !== "string" ||
    !body.boardId ||
    typeof body.gradeId !== "string" ||
    !body.gradeId ||
    typeof body.subjectId !== "string" ||
    !body.subjectId ||
    typeof body.medium !== "string" ||
    !body.medium ||
    !Array.isArray(body.chunks) ||
    body.chunks.some((c) => typeof c?.content !== "string" || !c.content.trim())
  ) {
    res.status(400).json({
      error:
        "documentId, topicId, boardId, gradeId, subjectId, medium, and a non-empty chunks array (each with a content string) are required",
    });
    return;
  }

  const result = await embedAndStorePrechunkedDocument(
    body.documentId,
    {
      topicId: body.topicId,
      boardId: body.boardId,
      gradeId: body.gradeId,
      subjectId: body.subjectId,
      medium: body.medium as Medium,
    },
    body.chunks
  );

  const response: ChapterDocumentEmbedResponse = result;
  res.json(response);
});

// Reached when a student clicks a topic in the syllabus panel. Four stages,
// each a fallback for the one before it:
//
//   1. Chapter notes (RAG): admin-authored/imported content for this exact
//      topic (chapter_documents, the same store chat grounding reads from)
//      -- already curated by a human, so it's shown as-is with no review
//      gate and without ever touching the LLM.
//   2. Cache (Redis): a summary generated earlier and already
//      admin-approved -- see stage 3's caching rule below for why a
//      pending_review summary never reaches here.
//   3. Database (topic_summaries): a summary generated earlier. Only an
//      'approved' row counts as a hit here -- a 'pending_review' row is
//      still returned to *this* request (no reason to regenerate identical
//      content, or leave the student with nothing, while it awaits review)
//      but is deliberately not cached and not treated as a hit for a
//      *later* lookup, mirroring exactly how the answer bank keeps a
//      pending_review answer out of both search_answer_bank and the Redis
//      cache until an admin confirms it (see server.ts's /v1/chat stage 4).
//      A 'rejected' row is treated as a miss -- falls through to stage 4 --
//      so the topic self-heals on the next click rather than staying dead
//      until someone notices and manually clears it.
//   4. LLM: generates fresh, upserts into topic_summaries as
//      'pending_review' (never auto-approved, unlike answer-bank entries --
//      see 0026_topic_summary_review.sql), and is returned to this request
//      but not cached, for the same reason as stage 3's pending case.
app.post("/v1/topic-summary", requireSharedSecret, async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const body = req.body as Partial<TopicSummaryRequest> | undefined;

  if (
    !body ||
    typeof body.userId !== "string" ||
    !body.userId ||
    typeof body.topicId !== "string" ||
    !body.topicId ||
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
        "userId, topicId, subjectId, subjectName, boardName, gradeName, medium, chapter, and topic are required",
    });
    return;
  }

  function respond(summary: string, source: TopicSummaryResponse["source"]) {
    void recordChatEvent({
      userId: body!.userId!,
      mode: "student",
      subjectId: body!.subjectId!,
      question: `topic-summary: ${body!.chapter} / ${body!.topic}`,
      source,
      latencyMs: Date.now() - startedAt,
    });
    const response: TopicSummaryResponse = { summary, source };
    res.json(response);
  }

  const fromChapterNotes = await getStoredChapterSummary(body.topicId);
  if (fromChapterNotes) {
    respond(fromChapterNotes, "chapter_notes");
    return;
  }

  const cached = await getCachedTopicSummary(body.topicId);
  if (cached) {
    respond(cached, "cache");
    return;
  }

  const stored = await getStoredTopicSummary(body.topicId);
  if (stored && stored.status !== "rejected") {
    if (stored.status === "approved") {
      // Cache missed but the database had an approved summary -- populate
      // cache so the next click of this topic is an L1 hit.
      void setCachedTopicSummary(body.topicId, stored.summary);
    }
    respond(stored.summary, "database");
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

    await upsertTopicSummary(body.topicId, text);

    void recordChatEvent({
      userId: body.userId,
      mode: "student",
      subjectId: body.subjectId,
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

// Called by the web app's admin topic-summaries review page when a summary
// is rejected or deleted, so a demoted/removed summary stops being served
// from cache right away instead of surviving until its TTL runs out. Mirrors
// /v1/cache/invalidate above exactly, just against the topic-summary cache
// namespace (see cache.ts).
app.post("/v1/topic-summary-cache/invalidate", requireSharedSecret, async (req: Request, res: Response) => {
  const body = req.body as { topicId?: string } | undefined;
  if (!body || typeof body.topicId !== "string" || !body.topicId) {
    res.status(400).json({ error: "topicId is required" });
    return;
  }
  await deleteCachedTopicSummary(body.topicId);
  res.json({ ok: true });
});

// Reached when a student clicks "Relevant Exercises" under a topic summary.
// Searches the answer bank for exercises already generated for this exact
// topic (by anyone -- exact topic_id match, see 0015_answer_bank_topic_id.sql)
// before generating fresh ones -- same fall-through-to-LLM philosophy as the
// chat pipeline's cache/database/LLM stages.
app.post("/v1/topic-exercises", requireSharedSecret, async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const body = req.body as Partial<TopicExercisesRequest> | undefined;

  if (
    !body ||
    typeof body.userId !== "string" ||
    !body.userId ||
    typeof body.topicId !== "string" ||
    !body.topicId ||
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
        "userId, topicId, boardId, gradeId, subjectId, subjectName, boardName, gradeName, medium, chapter, and topic are required",
    });
    return;
  }

  const scope = {
    boardId: body.boardId,
    gradeId: body.gradeId,
    subjectId: body.subjectId,
    medium: body.medium as Medium,
  };

  const found = await findRelevantExercises(scope, body.topicId);
  if (found.length > 0) {
    void recordChatEvent({
      userId: body.userId,
      mode: "student",
      boardId: scope.boardId,
      gradeId: scope.gradeId,
      subjectId: scope.subjectId,
      medium: scope.medium,
      question: `topic-exercises: ${body.chapter} / ${body.topic}`,
      source: "database",
      latencyMs: Date.now() - startedAt,
    });
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
    // Shown to the student regardless of whether the write below succeeds --
    // a storage failure shouldn't cost them the exercises they just asked
    // for, only get logged so it doesn't go unnoticed (see recordAnswer).
    const stored: { question: string; answer: string }[] = [];
    for (const exercise of parsed) {
      const validation = validateAnswerForStorage(exercise.answer);
      if (!validation.store) continue;
      stored.push(exercise);

      // The topic-level search above (findRelevantExercises) only tells us
      // this exact topic has nothing banked yet -- a specific generated
      // question can still coincide with one already banked under a
      // *different* topic (e.g. the same exercise regenerated after a
      // syllabus edit moved it), so check per-exercise before writing rather
      // than trusting the topic-level miss to mean every exercise is new.
      const existing = await findAnswerInBank({ ...scope, question: exercise.question });
      if (existing) continue;

      const saved = await recordAnswer(
        { ...scope, question: exercise.question, topicId: body.topicId },
        exercise.answer,
        validation.status
      );
      if (!saved) {
        console.error(
          `Failed to store generated exercise in the answer bank: "${exercise.question.slice(0, 80)}"`
        );
      }
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
