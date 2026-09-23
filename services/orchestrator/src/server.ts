import express from "express";
import type { NextFunction, Request, Response } from "express";
import {
  findAnswerInBank,
  findRelevantExercises,
  getAnswersForGrading,
  getExerciseForGrading,
  recordAnswer,
} from "./answerBank.js";
import { validateAnswerForStorage } from "./answerValidation.js";
import {
  findArchetypesForTopic,
  recordArchetypeProgress,
  recordArchetypeAttemptResult,
} from "./archetypeExercises.js";
import { findConceptContent, findConceptsForTopic } from "./chunkConcepts.js";
import { gradeExerciseAnswer } from "./exerciseGrading.js";
import {
  deleteCachedAnswer,
  deleteCachedTopicSummary,
  getCachedAnswer,
  getCachedTopicSummary,
  setCachedAnswer,
  setCachedTopicSummary,
} from "./cache.js";
import {
  chunkText,
  embedAndStoreChapterDocument,
  embedAndStorePrechunkedDocument,
  getStoredChapterSummary,
} from "./chapterDocuments.js";
import { findRelevantChapterChunks } from "./chapterRag.js";
import { detectContentLanguage } from "./contentLanguage.js";
import { parseGeneratedExercises } from "./exerciseParser.js";
import { getChatReply, getGradingReply } from "./llm.js";
import { recordChatEvent } from "./observabilityClient.js";
import { buildPracticeBlueprint } from "./practiceBlueprint.js";
import { parsePracticePaperGrading } from "./practicePaperGrading.js";
import { restateQuestionForStorage } from "./questionRewrite.js";
import {
  buildChapterDocumentEmphasisPrompt,
  buildConceptExerciseGenerationPrompt,
  buildExerciseGenerationPrompt,
  buildPracticePaperGradingPrompt,
  buildStaffSystemPrompt,
  buildTopicSummaryPrompt,
  buildTopicSummaryTranslationPrompt,
  buildTutorSystemPrompt,
} from "./prompts.js";
import type { ExerciseArchetype } from "./prompts.js";
import {
  isQuestionInSyllabus,
  SYLLABUS_REJECTION_MESSAGE,
} from "./syllabusGate.js";
import { bestMatchingTopic } from "./syllabusFilter.js";
import { getStoredTopicSummary, upsertTopicSummary } from "./topicSummary.js";
import type {
  AnswerScope,
  ChapterDocumentEmbedRequest,
  ChapterDocumentEmbedResponse,
  ChapterDocumentEmphasisRequest,
  ChapterDocumentEmphasisResponse,
  ChapterDocumentImportChunksRequest,
  ChatOrchestrationRequest,
  ChatOrchestrationResponse,
  DifficultyLevel,
  EvaluatePracticePaperRequest,
  EvaluatePracticePaperResponse,
  ExerciseItem,
  ExerciseType,
  GenerateConceptExercisesRequest,
  GenerateConceptExercisesResponse,
  GeneratePracticePaperRequest,
  GeneratePracticePaperResponse,
  GenerateTopicExerciseRequest,
  GenerateTopicExerciseResponse,
  GradeExerciseRequest,
  GradeExerciseResponse,
  ImageAttachment,
  ImageMediaType,
  Medium,
  PracticePaperQuestion,
  PracticePaperTopic,
  TopicConceptsRequest,
  TopicConceptsResponse,
  TopicExercisesRequest,
  TopicExercisesResponse,
  TopicPatternsRequest,
  TopicPatternsResponse,
  TopicSubtopicsRequest,
  TopicSubtopicsResponse,
  TopicSummaryRequest,
  TopicSummaryResponse,
} from "./types.js";

const PORT = Number(process.env.PORT) || 4000;
const MAX_TOKENS = 1536;
const SUMMARY_MAX_TOKENS = 700;
// Sized for buildTopicSummaryTranslationPrompt specifically, not
// buildTopicSummaryPrompt's own "a few short paragraphs" -- that prompt
// FAITHFULLY REPRODUCES whatever real chapter_documents content exists for
// a topic, which can be substantially longer than a quick revision summary
// (e.g. several field-type documents -- overview, characters, vocabulary,
// grammar, composition -- concatenated together by getStoredChapterSummary
// for one topic). Reported live: the plain SUMMARY_MAX_TOKENS budget cut a
// real translation off mid-way through, well before its own vocabulary/
// grammar/composition sections.
const SUMMARY_TRANSLATION_MAX_TOKENS = 4000;
// /v1/chapter-documents/add-emphasis processes a document in windows this
// big (characters), not the whole thing in one call -- chapterDocuments.ts's
// own TARGET_CHUNK_CHARS=1500 is sized for RAG retrieval granularity, far
// finer than an efficient formatting pass needs (that would mean many more
// round trips, and more chances for one small chunk to lose its own
// paragraph's context); this is sized instead so a single real chapter
// document usually fits in one or two calls, while still keeping each
// call's own output comfortably inside EMPHASIS_MAX_TOKENS below.
const EMPHASIS_CHUNK_CHARS = 4000;
// This pass only ever ADDS a handful of short ** / * markers -- the output
// is never meaningfully longer than the input -- so this just needs to
// comfortably clear EMPHASIS_CHUNK_CHARS's own character count with margin
// for a script that tokenizes less efficiently than English, not room for
// genuinely new content the way SUMMARY_TRANSLATION_MAX_TOKENS needs.
const EMPHASIS_MAX_TOKENS = 4000;
// Shared by every exercise-generation call (batch, on-demand single, and
// concept-scoped multi) regardless of how many exercises that call asks
// for. Raised from the original 2048: reported directly with real WBBSE
// Bengali content -- a worked solution "showing steps" for a numerical or
// long-answer physics problem, in Bengali (which tokenizes less
// efficiently than English, see EMPHASIS_MAX_TOKENS's own comment on the
// same point), is verbose enough that 2-3 of them in one response could
// plausibly hit 2048 and get cut off mid-generation -- the LLM call would
// still return 200 OK with whatever it managed to write so far, but the
// parser correctly finds only the exercises that finished cleanly,
// silently dropping a truncated trailing one rather than erroring.
// Raising the ceiling costs nothing when a response was already well
// under it, and removes this as a cause when it wasn't.
const EXERCISE_MAX_TOKENS = 4096;
const EXERCISE_GENERATION_COUNT = 5;
// findArchetypesForTopic's own default limit (5, matching
// EXERCISE_GENERATION_COUNT above) is right for grounding a batch of
// generated exercises, but wrong for the picker/on-demand-generate routes
// below, which need to see (and be able to pick) any of a chapter's real
// mined patterns, not just an arbitrary first few -- see that function's
// own comment for the production bug this fixes. Effectively "no cap" for
// any realistic topic's mined-pattern count while still bounding a truly
// pathological case.
const PATTERN_PICKER_LIMIT = 200;
// Tier D: validates a client-supplied requestedDifficulty on
// /v1/topic-exercises/generate -- see that route's own comment.
const VALID_DIFFICULTIES: DifficultyLevel[] = ["Easy", "Medium", "Hard"];
// Validates a client-supplied requestedType on /v1/topic-exercises/generate
// and /v1/topic-exercises/generate-for-concept -- see ExerciseType's own
// comment.
const VALID_TYPES: ExerciseType[] = [
  "MCQ",
  "short_answer",
  "long_answer",
  "numerical",
];
const SHARED_SECRET = process.env.ORCHESTRATOR_SHARED_SECRET;

const ALLOWED_IMAGE_TYPES = new Set<ImageMediaType>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
// ~4.3MB decoded (base64 runs ~37% larger than raw bytes) -- comfortably
// under the JSON body limit below, which also has to fit the rest of the
// request (history, syllabus topics, etc).
const MAX_IMAGE_BASE64_LENGTH = 6_000_000;
// /v1/practice-paper/evaluate's own cap -- a photographed answer sheet
// commonly spans a few pages. Kept in sync by hand with the web app's own
// copy of this constant, same "mirrored constant" convention used
// throughout this file.
const MAX_IMAGES_PER_SUBMISSION = 4;

if (!SHARED_SECRET) {
  console.warn(
    "WARNING: ORCHESTRATOR_SHARED_SECRET is not set. This service will accept requests from " +
      "anyone who can reach it on the network. Set it before exposing this service beyond a " +
      "trusted internal network (e.g. the docker-compose network).",
  );
}

const app = express();
// Raised from the original 1mb (to fit a base64-encoded screenshot/photo),
// then again from 8mb: /v1/practice-paper/evaluate can carry up to
// MAX_IMAGES_PER_SUBMISSION images at up to MAX_IMAGE_BASE64_LENGTH each,
// which alone can approach ~24mb of base64. Raising the one shared global
// limit rather than trying to scope a bigger limit to just that route --
// Express parses the body before a route handler ever runs, so a per-route
// override only works if that route's own body-parser middleware is
// registered ahead of this app-wide one in the file, which is fragile
// (silently breaks if a future edit reorders routes) for no real benefit,
// since a larger ceiling costs nothing for every other route.
app.use(express.json({ limit: "26mb" }));

// Returns `undefined` when no image was sent (valid -- most requests have
// none), an ImageAttachment when one was and it's valid, or throws-shaped
// via the returned `error` string when one was sent but malformed.
function parseImageField(raw: unknown): {
  image?: ImageAttachment;
  error?: string;
} {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object") return { error: "image must be an object" };

  const { mediaType, base64 } = raw as {
    mediaType?: unknown;
    base64?: unknown;
  };
  if (
    typeof mediaType !== "string" ||
    !ALLOWED_IMAGE_TYPES.has(mediaType as ImageMediaType)
  ) {
    return {
      error:
        "image.mediaType must be one of image/jpeg, image/png, image/gif, image/webp",
    };
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
      configured: Boolean(
        process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
      ),
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

app.post(
  "/v1/chat",
  requireSharedSecret,
  async (req: Request, res: Response) => {
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
    const { image, error: imageError } = parseImageField(
      (body as { image?: unknown }).image,
    );
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
        const { text } = await getChatReply({
          systemPrompt: buildStaffSystemPrompt(
            body.subjectName,
            Boolean(image),
          ),
          history,
          message: body.message,
          image,
          maxTokens: MAX_TOKENS,
          event: {
            loggable: true,
            userId: body.userId,
            mode: "staff",
            subjectId: body.subjectId,
            question: body.message.trim() || "[Image question]",
          },
        });
        const response: ChatOrchestrationResponse = {
          reply: text,
          source: "llm",
        };
        res.json(response);
      } catch (err) {
        console.error("LLM chat completion failed:", err);
        res.status(502).json({
          error:
            "The tutor is temporarily unavailable. Please try again shortly.",
        });
      }
      return;
    }

    const studentBody = body as Extract<
      ChatOrchestrationRequest,
      { mode: "student" }
    >;
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
        error:
          "boardId, gradeId, boardName, gradeName, medium, and topics are required for mode='student'",
      });
      return;
    }

    // Defaults to `medium` (the ordinary case, true for every subject but
    // English) -- only differs when the web app's English-subject toggle is
    // on, or when `medium` itself is the English subject's always-English
    // content scope while the student's own default reply language is their
    // native medium (see the web app's contentMedium/syllabusMediumFor).
    // `medium` drives topics/gate/RAG scope below -- what's actually in
    // scope to ask about -- and is never substituted for responseLanguage;
    // responseLanguage only ever decides what language the reply is written
    // in (see types.ts's own comment).
    const responseLanguage: Medium =
      studentBody.responseLanguage ?? studentBody.medium;

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
        medium: responseLanguage,
        question: studentBody.message.trim() || "[Image question]",
        source: "rejected",
        latencyMs: Date.now() - startedAt,
      });
      const response: ChatOrchestrationResponse = {
        reply: SYLLABUS_REJECTION_MESSAGE,
        source: "rejected",
      };
      res.json(response);
      return;
    }

    // Powers the "Practice a specific pattern" picker on this reply,
    // regardless of which of the three response paths below actually serves
    // it (cache/database/llm all answer the SAME question against the SAME
    // topics, so the same best-guess topic applies to all three) -- computed
    // once here rather than duplicated in each branch. A pure, cheap
    // (keyword-only, no I/O) lookup, so there's no cost reason to skip it on
    // the cache/database hit paths the way an LLM call would be.
    const matchedTopic = bestMatchingTopic(
      studentBody.topics,
      studentBody.message,
    );

    // Stages 2-3 (cache, then the Postgres answer bank) only apply to a fresh,
    // text-only question, not a follow-up ("explain more", "why?") -- those
    // depend on conversation context that a scope-only lookup key can't
    // capture, so serving one from cache/db risks answering the wrong thing.
    // An image-bearing question is excluded the same way: the lookup key is
    // the message text, which doesn't represent what's actually in the image,
    // so a text match here would be coincidental at best and wrong at worst.
    //
    // The scope's own `medium` is deliberately `responseLanguage`, not
    // `studentBody.medium` -- the cached/banked *text* is a function of what
    // language it was written in, not what content-scope it was asked
    // against, and for the English subject those two are no longer always
    // the same value (medium is always "English" there; responseLanguage
    // defaults to the student's own native medium and only becomes
    // "English" when the toggle is on). Keying on responseLanguage means a
    // Bengali-medium and an English-medium student's identical question
    // about the English subject correctly share a cache entry when both get
    // a Bengali/English answer respectively -- and, for every other subject,
    // responseLanguage always equals medium anyway (no toggle exists), so
    // this is a no-op there.
    const isFreshQuestion = history.length === 0;
    const scope: AnswerScope | null =
      isFreshQuestion && !image
        ? {
            boardId: studentBody.boardId,
            gradeId: studentBody.gradeId,
            subjectId: studentBody.subjectId,
            medium: responseLanguage,
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
        const response: ChatOrchestrationResponse = {
          reply: cached,
          source: "cache",
          matchedTopic,
        };
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
        const response: ChatOrchestrationResponse = {
          reply: fromBank.answer,
          source: "database",
          matchedTopic,
        };
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
          studentBody.message,
        )
      : [];

    const systemPrompt = buildTutorSystemPrompt({
      subjectName: studentBody.subjectName,
      boardName: studentBody.boardName,
      gradeName: studentBody.gradeName,
      medium: studentBody.medium,
      responseLanguage,
      topics: studentBody.topics,
      message: studentBody.message,
      hasImage: Boolean(image),
      referenceChunks,
    });

    try {
      const { text } = await getChatReply({
        systemPrompt,
        history,
        message: studentBody.message,
        image,
        maxTokens: MAX_TOKENS,
        event: {
          loggable: true,
          userId: studentBody.userId,
          mode: "student",
          boardId: studentBody.boardId,
          gradeId: studentBody.gradeId,
          subjectId: studentBody.subjectId,
          medium: responseLanguage,
          question: studentBody.message.trim() || "[Image question]",
          grounded: referenceChunks.length > 0,
        },
      });

      if (scope) {
        const validation = validateAnswerForStorage(text);
        if (validation.store) {
          // The answer bank is a durable, cross-student-reusable store -- a
          // student's own question text can legitimately be a verbatim copy
          // of something from a copyrighted guide book (typed out, or pasted
          // on desktop), and writing that exact text into a table every other
          // student's queries get matched against is a different, riskier
          // kind of copy than answering it live already was. Restate it in
          // the model's own words first -- see buildQuestionRestatementPrompt
          // for what that does and doesn't remove. Deliberately fails closed,
          // not open: a failed restatement skips this write entirely rather
          // than falling back to the original text, since storing exactly
          // what this step exists to avoid storing would defeat the point.
          void (async () => {
            const restatedQuestion = await restateQuestionForStorage(
              scope.question,
              {
                loggable: true,
                userId: studentBody.userId,
                mode: "student",
                boardId: studentBody.boardId,
                gradeId: studentBody.gradeId,
                subjectId: studentBody.subjectId,
                medium: responseLanguage,
                question: `restate-for-storage: ${scope.question}`,
              },
            );
            if (!restatedQuestion) {
              console.error(
                "Skipping answer-bank write -- question restatement failed for this question.",
              );
              return;
            }
            const saved = await recordAnswer(
              { ...scope, question: restatedQuestion },
              text,
              validation.status,
              studentBody.userId,
            );
            if (!saved)
              console.error(
                "Failed to store this chat answer in the answer bank.",
              );
          })();
          // Only cache (i.e. let it be replayed to other students) once it's
          // confident enough to auto-approve -- a pending_review answer stays
          // out of both the cache and the servable side of the answer bank
          // until an admin confirms it. Cached under the student's own
          // original question text, not the restated one written to the
          // answer bank above -- Redis entries are short-TTL, fast-repeat
          // lookups rather than a durable cross-student corpus, so the
          // stricter storage safeguard above doesn't need to apply here, and
          // keeping the exact original text preserves precise-match accuracy
          // for a genuine repeat of the same wording (a more generalized
          // restatement risks a wrong cache hit against a different specific
          // problem that merely shares the same underlying concept).
          if (validation.status === "auto_approved") {
            void setCachedAnswer(scope, text);
          }
        }
      }

      const response: ChatOrchestrationResponse = {
        reply: text,
        source: "llm",
        matchedTopic,
      };
      res.json(response);
    } catch (err) {
      console.error("LLM chat completion failed:", err);
      res.status(502).json({
        error:
          "The tutor is temporarily unavailable. Please try again shortly.",
      });
    }
  },
);

// Called by the web app's admin answer-bank review page when an entry is
// rejected or deleted, so the demoted/removed answer stops being served
// from cache right away instead of surviving until its TTL runs out. The
// web app has the full scope (it's rendering the row already), so it's
// passed through directly rather than looked up here.
app.post(
  "/v1/cache/invalidate",
  requireSharedSecret,
  async (req: Request, res: Response) => {
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
      res.status(400).json({
        error: "boardId, gradeId, subjectId, medium, and question are required",
      });
      return;
    }

    await deleteCachedAnswer(body as AnswerScope);
    res.json({ ok: true });
  },
);

// Called by the web app's admin Chapter Notes action right after it writes
// or updates a chapter_documents row -- this service holds the only Voyage
// credentials in the whole app (same reasoning ANTHROPIC_API_KEY never
// reaches the web app), so embedding has to happen here even though the raw
// document itself is written directly by the web app's own service-role
// client, not through this service.
app.post(
  "/v1/chapter-documents/embed",
  requireSharedSecret,
  async (req: Request, res: Response) => {
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
        error:
          "documentId, topicId, boardId, gradeId, subjectId, medium, and content are required",
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
      body.content,
    );

    const response: ChapterDocumentEmbedResponse = result;
    res.json(response);
  },
);

// Sibling of /v1/chapter-documents/embed above, for the pre-chunked JSON
// import path (src/app/admin/chapter-notes/import-chunks-form.tsx) --
// `chunks` are already split along real structural boundaries by whoever
// prepared the JSON, so this skips chunkText() entirely and embeds each
// piece as given, preserving its own field_type/citation.
app.post(
  "/v1/chapter-documents/import-chunks",
  requireSharedSecret,
  async (req: Request, res: Response) => {
    const body = req.body as
      | Partial<ChapterDocumentImportChunksRequest>
      | undefined;

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
      body.chunks.some(
        (c) => typeof c?.content !== "string" || !c.content.trim(),
      )
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
      body.chunks,
    );

    const response: ChapterDocumentEmbedResponse = result;
    res.json(response);
  },
);

// Strips exactly what buildChapterDocumentEmphasisPrompt is allowed to add
// (** / * markers) and collapses all whitespace, so two texts that differ
// only in emphasis markup and incidental spacing/line-wrapping compare
// equal -- anything else different (a reworded sentence, a dropped clause,
// a changed number) still fails this comparison. This is the actual safety
// boundary for /v1/chapter-documents/add-emphasis below, not the prompt --
// a prompt is an instruction the model can still get wrong.
function stripEmphasisForComparison(text: string): string {
  return text.replace(/\*+/g, "").replace(/\s+/g, " ").trim();
}

// Retrofits markdown emphasis onto already-saved chapter_documents content
// (see chapterDocuments.ts's getStoredChapterSummary) -- the one summary
// "source" that SUMMARY_EMPHASIS_RULE can never reach, since it's served to
// students completely verbatim with no LLM step of its own. Never called
// from the student-facing path; only from the web app's admin Chapter
// Notes action, on demand.
//
// Processes the document in EMPHASIS_CHUNK_CHARS-sized windows (chunkText,
// the same paragraph-boundary-aware splitter the naive embedding path
// uses) rather than one LLM call over the whole document -- keeps each
// call's output comfortably within budget and means one bad chunk doesn't
// take the rest of a long document down with it. Every chunk's own LLM
// output is verified independently (stripEmphasisForComparison against
// that same chunk's original text) before being used -- a chunk that fails
// this check is returned completely UNCHANGED, from its own original text,
// never from whatever the model produced for it. This fails closed on
// purpose: content that stays exactly as it was is always an acceptable
// outcome here, content that silently drifts from what an admin actually
// vouched for is not.
app.post(
  "/v1/chapter-documents/add-emphasis",
  requireSharedSecret,
  async (req: Request, res: Response) => {
    const body = req.body as
      | Partial<ChapterDocumentEmphasisRequest>
      | undefined;

    if (!body || typeof body.content !== "string" || !body.content.trim()) {
      res.status(400).json({ error: "content is required" });
      return;
    }

    const systemPrompt = buildChapterDocumentEmphasisPrompt();
    const chunks = chunkText(body.content, EMPHASIS_CHUNK_CHARS);

    let verifiedChunks = 0;
    let failedChunks = 0;
    const processedChunks: string[] = [];

    for (const chunk of chunks) {
      try {
        const { text } = await getChatReply({
          systemPrompt,
          history: [],
          message: chunk,
          maxTokens: EMPHASIS_MAX_TOKENS,
          // An admin content-authoring pass over arbitrary document text --
          // no student/subject to attribute this to at all (the request is
          // just `{ content }`, see this route's own validation above).
          event: { loggable: false },
        });
        if (
          stripEmphasisForComparison(text) === stripEmphasisForComparison(chunk)
        ) {
          processedChunks.push(text.trim());
          verifiedChunks++;
        } else {
          // Verification failed -- keep this chunk exactly as it started
          // rather than risk the model's rewrite (see this route's own top
          // comment).
          processedChunks.push(chunk);
          failedChunks++;
        }
      } catch (err) {
        console.error(
          "Chapter document emphasis pass failed for one chunk:",
          err,
        );
        processedChunks.push(chunk);
        failedChunks++;
      }
    }

    const response: ChapterDocumentEmphasisResponse = {
      content: processedChunks.join("\n\n"),
      verifiedChunks,
      failedChunks,
    };
    res.json(response);
  },
);

// Reached when a student clicks a topic in the syllabus panel. Four stages,
// each a fallback for the one before it:
//
//   1. Chapter notes (RAG): admin-authored/imported content for this exact
//      topic (chapter_documents, the same store chat grounding reads from)
//      -- always looked up, regardless of responseLanguage. When it's
//      ALREADY written in responseLanguage, it's shown as-is -- already
//      curated by a human, no review gate, without ever touching the LLM.
//      When it isn't, the same real content still goes through stage 4's
//      LLM call as grounding to translate/adapt (see that stage's own
//      comment). Only when NO chapter_documents content exists for this
//      topic at all does this stage contribute nothing.
//
//      Whether the stored content is "already written in responseLanguage"
//      is decided by detectContentLanguage (contentLanguage.ts) reading
//      the content's OWN characters -- deliberately NOT by comparing
//      responseLanguage against this topic's `medium` column, which means
//      "which student COHORT this content serves" (see the web app's own
//      studentScope.ts top comment), not "what script this text is
//      written in." Those two readings coincide for a single-cohort
//      subject (CBSE English's own content really is in English, matching
//      medium=English) but genuinely diverge the moment they don't (West
//      Bengal Board's own English-Second-Language course: medium=Bengali
//      is the COHORT it serves, but its real chapter_documents text was
//      authored in English) -- confirmed live, TWICE: first when comparing
//      against `medium` skipped this stage's real content entirely for any
//      responseLanguage but the literal tag string (a Bengali-medium
//      student's own DEFAULT English view of it fell to a fully ungrounded
//      stage 4); then again, after that fix, when a Bengali-TOGGLED
//      request came back as the SAME unmodified English content, because
//      responseLanguage("Bengali") happened to equal the row's own
//      medium("Bengali") tag even though not one real character of the
//      text ever was Bengali.
//   2. Cache (Redis): a summary generated earlier for this exact
//      (topicId, responseLanguage) pair and already admin-approved -- see
//      stage 3's caching rule below for why a pending_review summary never
//      reaches here.
//   3. Database (topic_summaries): a summary generated earlier for this
//      (topicId, responseLanguage) pair (see 0027_topic_summary_language.sql
//      -- one row per topic *per language*, not one row per topic, so a
//      topic's own-medium summary and a native-language translation of it
//      are independently stored and reviewed). Only an 'approved' row
//      counts as a hit here -- a 'pending_review' row is still returned to
//      *this* request (no reason to regenerate identical content, or leave
//      the student with nothing, while it awaits review) but is
//      deliberately not cached and not treated as a hit for a *later*
//      lookup, mirroring exactly how the answer bank keeps a pending_review
//      answer out of both search_answer_bank and the Redis cache until an
//      admin confirms it (see server.ts's /v1/chat stage 4). A 'rejected'
//      row is treated as a miss -- falls through to stage 4 -- so the topic
//      self-heals on the next click rather than staying dead until someone
//      notices and manually clears it.
//   4. LLM: generates fresh (buildTopicSummaryPrompt, the model's own
//      general knowledge of the chapter/topic by NAME only, SUMMARY_MAX_TOKENS)
//      when stage 1 found nothing at all for this topic; otherwise
//      TRANSLATES/adapts the real stage-1 content into responseLanguage
//      (buildTopicSummaryTranslationPrompt, SUMMARY_TRANSLATION_MAX_TOKENS
//      -- a larger budget, since faithfully reproducing real content that
//      can span several concatenated field-type documents needs more room
//      than a quick "few short paragraphs" summary) rather than inventing
//      a fresh one. Either way, upserts into topic_summaries (keyed on
//      this responseLanguage) as 'pending_review' (never auto-approved,
//      unlike answer-bank entries -- see 0026_topic_summary_review.sql),
//      and is returned to this request but not cached, for the same
//      reason as stage 3's pending case.
app.post(
  "/v1/topic-summary",
  requireSharedSecret,
  async (req: Request, res: Response) => {
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

    const medium = body.medium as Medium;
    const responseLanguage: Medium =
      (body.responseLanguage as Medium | undefined) ?? medium;

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

    // Always looked up now, regardless of language -- see this route's own
    // top comment for why. fromChapterNotes is real content ("what does
    // this topic actually say") whenever it exists at all.
    const fromChapterNotes = await getStoredChapterSummary(body.topicId);
    // Whether it can be shown completely as-is (no LLM call at all) depends
    // on what language it's ACTUALLY written in -- detected from its own
    // real characters (see contentLanguage.ts's own comment on why this,
    // never the topic's `medium` column, which means "which cohort this
    // serves," not "what script this text is in"; the two genuinely
    // diverge for content like West Bengal Board's own English-Second-
    // Language reader). Reported live: comparing against `medium` directly
    // made a Bengali-toggled request return this exact content completely
    // UNCHANGED -- still English prose -- because the row's own medium tag
    // happened to already equal "Bengali", even though not one character of
    // the real text ever was.
    const isAlreadyInResponseLanguage =
      fromChapterNotes !== null &&
      detectContentLanguage(fromChapterNotes) === responseLanguage;
    if (fromChapterNotes && isAlreadyInResponseLanguage) {
      respond(fromChapterNotes, "chapter_notes");
      return;
    }

    const cached = await getCachedTopicSummary(body.topicId, responseLanguage);
    if (cached) {
      respond(cached, "cache");
      return;
    }

    const stored = await getStoredTopicSummary(body.topicId, responseLanguage);
    if (stored && stored.status !== "rejected") {
      if (stored.status === "approved") {
        // Cache missed but the database had an approved summary -- populate
        // cache so the next click of this topic+language is an L1 hit.
        void setCachedTopicSummary(
          body.topicId,
          responseLanguage,
          stored.summary,
        );
      }
      respond(stored.summary, "database");
      return;
    }

    try {
      // Grounded (real content, translated) whenever fromChapterNotes exists
      // at all -- only when this topic has NO chapter_documents content of
      // its own does this fall back to buildTopicSummaryPrompt's fully
      // ungrounded "write from general knowledge" prompt. See this route's
      // own top comment for the live report that motivated this branch.
      const systemPrompt = fromChapterNotes
        ? buildTopicSummaryTranslationPrompt({
            subjectName: body.subjectName,
            boardName: body.boardName,
            gradeName: body.gradeName,
            responseLanguage,
            chapter: body.chapter,
            topic: body.topic,
            sourceContent: fromChapterNotes,
          })
        : buildTopicSummaryPrompt({
            subjectName: body.subjectName,
            boardName: body.boardName,
            gradeName: body.gradeName,
            medium,
            responseLanguage,
            chapter: body.chapter,
            topic: body.topic,
          });
      const { text } = await getChatReply({
        systemPrompt,
        history: [],
        message: "Write the summary now.",
        // The translation prompt faithfully reproduces potentially much
        // longer real content than a quick "few short paragraphs" summary --
        // see SUMMARY_TRANSLATION_MAX_TOKENS's own comment.
        maxTokens: fromChapterNotes
          ? SUMMARY_TRANSLATION_MAX_TOKENS
          : SUMMARY_MAX_TOKENS,
        event: {
          loggable: true,
          userId: body.userId,
          mode: "student",
          subjectId: body.subjectId,
          question: `topic-summary: ${body.chapter} / ${body.topic}`,
        },
      });

      await upsertTopicSummary(body.topicId, responseLanguage, text);

      const response: TopicSummaryResponse = { summary: text, source: "llm" };
      res.json(response);
    } catch (err) {
      console.error("Topic summary generation failed:", err);
      res.status(502).json({
        error:
          "Could not generate a summary right now. Please try again shortly.",
      });
    }
  },
);

// Called by the web app's admin topic-summaries review page when a summary
// is rejected or deleted, so a demoted/removed summary stops being served
// from cache right away instead of surviving until its TTL runs out. Mirrors
// /v1/cache/invalidate above exactly, just against the topic-summary cache
// namespace (see cache.ts).
app.post(
  "/v1/topic-summary-cache/invalidate",
  requireSharedSecret,
  async (req: Request, res: Response) => {
    const body = req.body as
      | { topicId?: string; language?: string }
      | undefined;
    if (
      !body ||
      typeof body.topicId !== "string" ||
      !body.topicId ||
      typeof body.language !== "string" ||
      !body.language
    ) {
      res.status(400).json({ error: "topicId and language are required" });
      return;
    }
    await deleteCachedTopicSummary(body.topicId, body.language as Medium);
    res.json({ ok: true });
  },
);

// Shared by /v1/topic-exercises' batch generation loop and
// /v1/topic-exercises/generate's single on-demand generation (Tier C):
// validates, dedupes against the bank, and persists one freshly-
// generated exercise, returning the ExerciseItem to send back to the
// student -- or null if the answer wasn't storable (validateAnswerFor
// Storage rejected it) or the bank write itself failed, in which case
// the caller just has one fewer exercise to show rather than a hard
// error.
async function storeGeneratedExercise(
  scope: Omit<AnswerScope, "question" | "topicId">,
  topicId: string,
  userId: string,
  exercise: { question: string; answer: string; type?: ExerciseType },
  archetypeAttribution: { runId: string; archetypeId: string } | null,
): Promise<ExerciseItem | null> {
  const validation = validateAnswerForStorage(exercise.answer);
  if (!validation.store) return null;

  // A specific generated question can coincide with one already banked
  // under a *different* topic (e.g. the same exercise regenerated after a
  // syllabus edit moved it) -- checked per-exercise rather than trusting
  // a topic-level miss to mean every exercise here is new.
  const existing = await findAnswerInBank({
    ...scope,
    question: exercise.question,
  });
  const exerciseId =
    existing?.id ??
    (await recordAnswer(
      { ...scope, question: exercise.question, topicId },
      exercise.answer,
      validation.status,
      userId,
      archetypeAttribution,
    ));

  if (!exerciseId) {
    console.error(
      `Failed to store generated exercise in the answer bank: "${exercise.question.slice(0, 80)}"`,
    );
    return null;
  }

  return {
    id: exerciseId,
    question: exercise.question,
    answer: exercise.answer,
    archetypeRunId: archetypeAttribution?.runId ?? null,
    archetypeId: archetypeAttribution?.archetypeId ?? null,
    type: exercise.type ?? null,
  };
}

// Reached when a student clicks "Relevant Exercises" under a topic summary.
// Searches the answer bank for exercises already generated for this exact
// topic (by anyone -- exact topic_id match, see 0015_answer_bank_topic_id.sql)
// before generating fresh ones -- same fall-through-to-LLM philosophy as the
// chat pipeline's cache/database/LLM stages.
app.post(
  "/v1/topic-exercises",
  requireSharedSecret,
  async (req: Request, res: Response) => {
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

    const medium = body.medium as Medium;
    const responseLanguage: Medium =
      (body.responseLanguage as Medium | undefined) ?? medium;

    // The scope's own `medium` is deliberately `responseLanguage`, not
    // `medium` -- exactly the same reasoning as the /v1/chat and
    // /v1/topic-summary scopes: the banked *text* is a function of what
    // language it's written in, not what content-scope it was asked against.
    // Keying on responseLanguage means every language a topic's exercises are
    // ever requested in (the topic's own real medium, or a native-language
    // translation of it) gets its own independently searchable/bankable slice
    // of answered_questions, tagged to this exact topicId -- no schema change
    // needed, since answered_questions.medium was already a free-form scoping
    // dimension, not derived from the topic's own medium.
    const scope = {
      boardId: body.boardId,
      gradeId: body.gradeId,
      subjectId: body.subjectId,
      medium: responseLanguage,
    };

    // Set only when a student picked a sub-topic pill (see
    // /v1/topic-exercises/subtopics) rather than "all exercises for this
    // chapter" -- narrows BOTH the bank-lookup and the generation-grounding
    // steps below down to just this sub-topic's own archetypes. The
    // archetype lookup has to happen up front here (rather than only after a
    // bank miss, as the unscoped path below still does) because even a bank
    // HIT needs filtering: a plain topic-scoped bank match could easily
    // belong to a different sub-topic of the same chapter. limit:
    // PATTERN_PICKER_LIMIT (not the default MAX_ARCHETYPES=5) so filtering
    // by subTopic afterward sees every mined archetype, not an arbitrary
    // first-5 slice that might not even contain a match for this sub-topic.
    const subTopicFilter = body.subTopic?.trim().toLowerCase();
    let scopedArchetypeIds: Set<string> | null = null;
    let scopedArchetypes: ExerciseArchetype[] = [];
    if (subTopicFilter) {
      const allArchetypes = await findArchetypesForTopic({
        boardName: body.boardName,
        gradeName: body.gradeName,
        subjectName: body.subjectName,
        chapter: body.chapter,
        topic: body.topic,
        limit: PATTERN_PICKER_LIMIT,
      });
      scopedArchetypes = allArchetypes.filter(
        (a) => a.subTopic?.trim().toLowerCase() === subTopicFilter,
      );
      scopedArchetypeIds = new Set(scopedArchetypes.map((a) => a.archetypeId));
    }

    const found = await findRelevantExercises(scope, body.topicId);
    const relevantFound = scopedArchetypeIds
      ? found.filter(
          (f) =>
            f.archetype_id !== null && scopedArchetypeIds!.has(f.archetype_id),
        )
      : found;
    if (relevantFound.length > 0) {
      void recordChatEvent({
        userId: body.userId,
        mode: "student",
        boardId: scope.boardId,
        gradeId: scope.gradeId,
        subjectId: scope.subjectId,
        medium: scope.medium,
        question: `topic-exercises: ${body.chapter} / ${body.topic}${subTopicFilter ? ` (${body.subTopic})` : ""}`,
        source: "database",
        latencyMs: Date.now() - startedAt,
      });
      const response: TopicExercisesResponse = {
        exercises: relevantFound.map((f) => ({
          id: f.id,
          question: f.question,
          answer: f.answer,
          archetypeRunId: f.archetype_run_id,
          archetypeId: f.archetype_id,
        })),
        source: "database",
      };
      res.json(response);
      return;
    }

    try {
      // Grounds the generated set in real, historically-mined exam patterns
      // for this exact chapter/topic when any exist -- see
      // archetypeExercises.ts. Empty (the common case today, most chapters
      // have nothing mined yet) just means buildExerciseGenerationPrompt
      // falls back to its original ungrounded instruction, same as before
      // this existed -- fails open, never blocks exercise generation.
      //
      // Reuses the already-fetched, already-filtered scopedArchetypes above
      // when a sub-topic was requested, rather than looking archetypes up a
      // second time -- the unscoped path is untouched, still looked up here
      // for the first time on a genuine bank miss, exactly as before this
      // sub-topic feature existed.
      const archetypes = subTopicFilter
        ? scopedArchetypes
        : await findArchetypesForTopic({
            boardName: body.boardName,
            gradeName: body.gradeName,
            subjectName: body.subjectName,
            chapter: body.chapter,
            topic: body.topic,
          });
      // Visibility into how often generation is actually archetype-grounded
      // versus falling back to the ungrounded prompt -- the only way to see
      // this from outside without it (a hit/miss ratio isn't reflected
      // anywhere else: same endpoint, same response shape, same "source:
      // llm" either way). One line per generation call, not per request --
      // this only runs on the "nothing banked yet" path to begin with.
      console.log(
        archetypes.length > 0
          ? `Archetype-grounded exercises: HIT (${archetypes.length} archetype(s)) for ` +
              `${body.boardName}/${body.gradeName}/${body.subjectName} -- "${body.chapter}" / "${body.topic}"`
          : `Archetype-grounded exercises: MISS for ` +
              `${body.boardName}/${body.gradeName}/${body.subjectName} -- "${body.chapter}" / "${body.topic}"`,
      );

      const systemPrompt = buildExerciseGenerationPrompt({
        subjectName: body.subjectName,
        boardName: body.boardName,
        gradeName: body.gradeName,
        medium,
        responseLanguage,
        chapter: body.chapter,
        topic: body.topic,
        count: EXERCISE_GENERATION_COUNT,
        archetypes,
      });
      const { text } = await getChatReply({
        systemPrompt,
        history: [],
        message: "Generate the exercises now.",
        maxTokens: EXERCISE_MAX_TOKENS,
        event: {
          loggable: true,
          userId: body.userId,
          mode: "student",
          boardId: scope.boardId,
          gradeId: scope.gradeId,
          subjectId: scope.subjectId,
          medium: scope.medium,
          question: `topic-exercises: ${body.chapter} / ${body.topic}${subTopicFilter ? ` (${body.subTopic})` : ""}`,
        },
      });

      const parsed = parseGeneratedExercises(text);

      // Only recorded once generation actually produced something -- if
      // parsing came back empty, the student wasn't shown anything despite
      // archetypes having been looked up, so there's nothing to credit as
      // "seen." Fire-and-forget, same posture as recordChatEvent below: a
      // write failure here is logged inside recordArchetypeProgress itself
      // and never affects the response already being sent to the student.
      if (archetypes.length > 0 && parsed.length > 0) {
        void recordArchetypeProgress({
          userId: body.userId,
          boardId: body.boardId,
          gradeId: body.gradeId,
          subjectId: body.subjectId,
          medium,
          chapter: body.chapter,
          topic: body.topic,
          archetypes,
        });
      }

      // Every exercise returned to the student now needs a real, stable
      // answered_questions row id (the hide-until-submitted grading flow --
      // see /v1/topic-exercises/grade below -- has to be able to look the
      // exercise back up later), not just best-effort storage the way this
      // used to work -- an exercise a storage failure couldn't get an id for
      // is skipped from the response entirely, rather than shown with
      // nothing to submit against. See storeGeneratedExercise above.
      const stored: ExerciseItem[] = [];
      for (const exercise of parsed) {
        // patternIndex (see exerciseParser.ts) is the model's own 1-based
        // reference into the SAME archetypes array the prompt was built
        // from -- out-of-range or absent (an ungrounded generation, or a
        // model that dropped the tag despite being asked for it) just means
        // this specific exercise isn't attributed to a pattern, not an error.
        const archetype =
          typeof exercise.patternIndex === "number"
            ? archetypes[exercise.patternIndex - 1]
            : undefined;
        const archetypeAttribution = archetype
          ? { runId: archetype.runId, archetypeId: archetype.archetypeId }
          : null;

        const item = await storeGeneratedExercise(
          scope,
          body.topicId,
          body.userId,
          exercise,
          archetypeAttribution,
        );
        if (item) stored.push(item);
      }

      const response: TopicExercisesResponse = {
        exercises: stored,
        source: "llm",
      };
      res.json(response);
    } catch (err) {
      console.error("Exercise generation failed:", err);
      res.status(502).json({
        error:
          "Could not generate exercises right now. Please try again shortly.",
      });
    }
  },
);

// Lists the curated, real exam patterns mined for this exact chapter/
// topic -- powers the on-demand "practice a specific pattern" picker
// under Relevant Exercises (Tier C). A thin wrapper over
// findArchetypesForTopic, stripped to just what the picker needs to
// display. Empty is the common case (most chapters have nothing mined
// yet) and isn't an error -- the picker just doesn't render.
app.post(
  "/v1/topic-exercises/patterns",
  requireSharedSecret,
  async (req: Request, res: Response) => {
    const body = req.body as Partial<TopicPatternsRequest> | undefined;

    if (
      !body ||
      typeof body.boardName !== "string" ||
      typeof body.gradeName !== "string" ||
      typeof body.subjectName !== "string" ||
      typeof body.chapter !== "string" ||
      typeof body.topic !== "string"
    ) {
      res.status(400).json({
        error:
          "boardName, gradeName, subjectName, chapter, and topic are required",
      });
      return;
    }

    const allArchetypes = await findArchetypesForTopic({
      boardName: body.boardName,
      gradeName: body.gradeName,
      subjectName: body.subjectName,
      chapter: body.chapter,
      topic: body.topic,
      // The whole point of this endpoint is listing every mined pattern for
      // a student to choose from -- see PATTERN_PICKER_LIMIT's own comment.
      limit: PATTERN_PICKER_LIMIT,
    });

    // Set only when this picker is being shown underneath an already-
    // selected sub-topic pill -- narrows the listed patterns down to just
    // that sub-topic's own archetypes, same case/whitespace-insensitive
    // match /v1/topic-exercises' own subTopicFilter uses. Without this, a
    // student who picked "Pollination" saw every OTHER pattern in the whole
    // chapter too ("Double Fertilization", "Seed Formation", ...) in this
    // picker, even though the exercises above it were already correctly
    // scoped -- the actual bug this parameter fixes.
    const subTopicFilter = body.subTopic?.trim().toLowerCase();
    const archetypes = subTopicFilter
      ? allArchetypes.filter(
          (a) => a.subTopic?.trim().toLowerCase() === subTopicFilter,
        )
      : allArchetypes;

    const response: TopicPatternsResponse = {
      patterns: archetypes.map((a) => ({
        runId: a.runId,
        archetypeId: a.archetypeId,
        name: a.name,
        studentExplanation: a.studentExplanation,
        difficulty: a.difficulty,
        difficultyDistribution: a.difficultyDistribution,
        yearsObserved: a.yearsObserved,
        questionCountByYear: a.questionCountByYear,
        subTopic: a.subTopic,
      })),
    };
    res.json(response);
  },
);

// Groups the same mined archetypes /v1/topic-exercises/patterns lists by
// their own real sub-topic label (ExerciseArchetype.subTopic) instead of
// listing every pattern flat -- powers the "pick a sub-topic" picker shown
// before a student drills into a chapter's exercises. Archetypes with no
// subTopic (no supporting question ever had a curriculum.topic) are
// dropped rather than lumped into an "Other" bucket -- there's nothing
// real to label that bucket with. Empty is the common case (most chapters
// have nothing mined at all) and isn't an error -- the frontend falls back
// to /v1/topic-exercises/concepts (Part B) or, failing that too, today's
// flat unscoped batch.
app.post(
  "/v1/topic-exercises/subtopics",
  requireSharedSecret,
  async (req: Request, res: Response) => {
    const body = req.body as Partial<TopicSubtopicsRequest> | undefined;

    if (
      !body ||
      typeof body.boardName !== "string" ||
      typeof body.gradeName !== "string" ||
      typeof body.subjectName !== "string" ||
      typeof body.chapter !== "string" ||
      typeof body.topic !== "string"
    ) {
      res.status(400).json({
        error:
          "boardName, gradeName, subjectName, chapter, and topic are required",
      });
      return;
    }

    const archetypes = await findArchetypesForTopic({
      boardName: body.boardName,
      gradeName: body.gradeName,
      subjectName: body.subjectName,
      chapter: body.chapter,
      topic: body.topic,
      // Same reasoning as PATTERN_PICKER_LIMIT above -- every mined
      // archetype needs to be visible to this grouping, not just the top 5
      // meant for batch-generation grounding.
      limit: PATTERN_PICKER_LIMIT,
    });

    const groups = new Map<
      string,
      { name: string; patternCount: number; questionCount: number }
    >();
    for (const a of archetypes) {
      if (!a.subTopic) continue;
      const key = a.subTopic.trim().toLowerCase();
      const questionCount = Object.values(a.questionCountByYear).reduce(
        (sum, n) => sum + n,
        0,
      );
      const existing = groups.get(key);
      if (existing) {
        existing.patternCount += 1;
        existing.questionCount += questionCount;
      } else {
        groups.set(key, { name: a.subTopic, patternCount: 1, questionCount });
      }
    }

    const response: TopicSubtopicsResponse = {
      subtopics: Array.from(groups.values()).sort(
        (a, b) => b.questionCount - a.questionCount,
      ),
    };
    res.json(response);
  },
);

// Sibling of /v1/topic-exercises/subtopics for a chapter with nothing
// mined at all (see chunkConcepts.ts -- WBBSE/ICSE) -- lists the chapter's
// own concept-eligible chunks (key_definitions/formulas_and_laws-style) as
// sub-topic picks instead. Empty is normal (a narrative/literature-style
// chapter with no such chunks) -- the frontend falls back to today's flat
// unscoped batch either way.
app.post(
  "/v1/topic-exercises/concepts",
  requireSharedSecret,
  async (req: Request, res: Response) => {
    const body = req.body as Partial<TopicConceptsRequest> | undefined;

    if (!body || typeof body.topicId !== "string" || !body.topicId) {
      res.status(400).json({ error: "topicId is required" });
      return;
    }

    const concepts = await findConceptsForTopic(body.topicId);
    const response: TopicConceptsResponse = { concepts };
    res.json(response);
  },
);

// On-demand generation scoped to ONE concept picked from
// /v1/topic-exercises/concepts -- grounded in that concept's own chunk
// content (see buildConceptExerciseGenerationPrompt), never the whole
// chapter. Deliberately skips the answer-bank lookup, same reasoning as
// /v1/topic-exercises/generate just above: this service has no column to
// disambiguate one concept from another within the same topic_id, so a
// bank check here couldn't safely tell "banked for this concept" apart
// from "banked for a different concept in the same chapter" -- always
// fresh generation instead, an acceptable v1 cost given WBBSE/ICSE traffic
// is far lower than CBSE's own archetype-grounded path above.
//
// Kept equal to PatternPicker's own per-click count (see its own comment
// in pattern-picker.tsx) -- reported directly: a student clicking "MCQ"
// (routed through /v1/topic-exercises/generate) got a visibly different
// number of new questions per click than clicking "Numerical" here, with
// no reason for the two to differ.
const CONCEPT_EXERCISE_COUNT = 2;

app.post(
  "/v1/topic-exercises/generate-for-concept",
  requireSharedSecret,
  async (req: Request, res: Response) => {
    const body = req.body as
      | Partial<GenerateConceptExercisesRequest>
      | undefined;

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
      typeof body.topic !== "string" ||
      typeof body.conceptId !== "string" ||
      !body.conceptId
    ) {
      res.status(400).json({
        error:
          "userId, topicId, boardId, gradeId, subjectId, subjectName, boardName, gradeName, medium, chapter, topic, and conceptId are required",
      });
      return;
    }

    const medium = body.medium as Medium;
    const responseLanguage: Medium =
      (body.responseLanguage as Medium | undefined) ?? medium;
    const scope = {
      boardId: body.boardId,
      gradeId: body.gradeId,
      subjectId: body.subjectId,
      medium: responseLanguage,
    };
    // Invalid/absent just means "Any type" -- never a 400, same posture as
    // requestedDifficulty on /v1/topic-exercises/generate.
    const requestedType = VALID_TYPES.includes(
      body.requestedType as ExerciseType,
    )
      ? (body.requestedType as ExerciseType)
      : undefined;

    const concept = await findConceptContent(body.topicId, body.conceptId);
    if (!concept) {
      // Stale picker (the chapter's content changed since it was shown) --
      // nothing to generate, not an error.
      const response: GenerateConceptExercisesResponse = { exercises: [] };
      res.json(response);
      return;
    }

    try {
      const systemPrompt = buildConceptExerciseGenerationPrompt({
        subjectName: body.subjectName,
        boardName: body.boardName,
        gradeName: body.gradeName,
        medium,
        responseLanguage,
        chapter: body.chapter,
        topic: body.topic,
        conceptTerm: concept.term,
        conceptContent: concept.content,
        count: CONCEPT_EXERCISE_COUNT,
        requestedType,
      });
      const { text } = await getChatReply({
        systemPrompt,
        history: [],
        message: "Generate the exercises now.",
        maxTokens: EXERCISE_MAX_TOKENS,
        event: {
          loggable: true,
          userId: body.userId,
          mode: "student",
          boardId: scope.boardId,
          gradeId: scope.gradeId,
          subjectId: scope.subjectId,
          medium: scope.medium,
          question: `topic-exercises/generate-for-concept: ${body.chapter} / ${body.topic} (${concept.term})`,
        },
      });

      const parsed = parseGeneratedExercises(text);
      const stored: ExerciseItem[] = [];
      for (const exercise of parsed) {
        // requestedType, when set, wins over the model's own self-reported
        // "Type: ..." tag -- confirmed directly: the model reliably WROTE
        // the requested type's actual content (a genuinely numerical
        // problem when asked for one), but its own self-classification
        // tag disagreed, mislabeling it short_answer/long_answer instead.
        // We already told it what to write; trusting that instruction
        // over a separate, apparently less reliable self-tag is strictly
        // more accurate. The self-tag is still the only signal available
        // when nothing specific was requested (the batch path, or "Any"),
        // so it's the fallback, not discarded.
        const item = await storeGeneratedExercise(
          scope,
          body.topicId,
          body.userId,
          { ...exercise, type: requestedType ?? exercise.type },
          null,
        );
        if (item) stored.push(item);
      }

      const response: GenerateConceptExercisesResponse = { exercises: stored };
      res.json(response);
    } catch (err) {
      console.error("Concept-scoped exercise generation failed:", err);
      res.status(502).json({
        error:
          "Could not generate exercises right now. Please try again shortly.",
      });
    }
  },
);

// On-demand generation for ONE specific mined pattern -- Tier C's
// "Generate" action on a pattern the student picked from
// /v1/topic-exercises/patterns (archetypeId + archetypeRunId set), or
// "Generate another" with neither set for a random one from whatever's
// available. Deliberately skips the answer-bank lookup
// /v1/topic-exercises does first (findRelevantExercises) -- the whole
// point of clicking this is a fresh question, not whatever's already
// banked for this topic.
app.post(
  "/v1/topic-exercises/generate",
  requireSharedSecret,
  async (req: Request, res: Response) => {
    const body = req.body as Partial<GenerateTopicExerciseRequest> | undefined;

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

    const medium = body.medium as Medium;
    const responseLanguage: Medium =
      (body.responseLanguage as Medium | undefined) ?? medium;
    const scope = {
      boardId: body.boardId,
      gradeId: body.gradeId,
      subjectId: body.subjectId,
      medium: responseLanguage,
    };
    // Invalid/absent just means "Any difficulty" -- never rejected as a bad
    // request, since this is the one optional refinement on an otherwise
    // already-valid request.
    const requestedDifficulty = VALID_DIFFICULTIES.includes(
      body.requestedDifficulty as DifficultyLevel,
    )
      ? (body.requestedDifficulty as DifficultyLevel)
      : undefined;
    // Invalid/absent just means "Any type" -- same posture as
    // requestedDifficulty above.
    const requestedType = VALID_TYPES.includes(
      body.requestedType as ExerciseType,
    )
      ? (body.requestedType as ExerciseType)
      : undefined;

    try {
      const allArchetypes = await findArchetypesForTopic({
        boardName: body.boardName,
        gradeName: body.gradeName,
        subjectName: body.subjectName,
        chapter: body.chapter,
        topic: body.topic,
        // Must see the SAME full set the picker (/v1/topic-exercises/patterns)
        // showed the student -- otherwise a requested archetypeId outside
        // an arbitrary first-N here would silently fall through to a random
        // pick below instead of the pattern actually clicked. See
        // PATTERN_PICKER_LIMIT's own comment.
        limit: PATTERN_PICKER_LIMIT,
      });

      // Same sub-topic scoping as /v1/topic-exercises/patterns above --
      // without this, "Generate another" (no archetypeId, a random pick from
      // `archetypes`) could draw a pattern from a completely different
      // sub-topic of the same chapter than the one the student is currently
      // practicing, the same scope leak the patterns list itself had.
      const subTopicFilter = body.subTopic?.trim().toLowerCase();
      const archetypes = subTopicFilter
        ? allArchetypes.filter(
            (a) => a.subTopic?.trim().toLowerCase() === subTopicFilter,
          )
        : allArchetypes;

      if (archetypes.length === 0) {
        // Nothing mined for this chapter/topic (or, when subTopicFilter is
        // set, nothing left after narrowing to that sub-topic -- a stale
        // picker, since a real one would never have offered a pattern this
        // filter now excludes) -- the picker itself wouldn't have shown
        // anything to click. Nothing to ground an on-demand generation in,
        // so there's nothing to do -- not an error, and deliberately never
        // falls back to the wider, unscoped archetype pool here (that would
        // silently reintroduce the same scope leak this parameter exists to
        // fix).
        const response: GenerateTopicExerciseResponse = { exercise: null };
        res.json(response);
        return;
      }

      // A requested archetypeId/archetypeRunId not present in this topic's
      // own current list (a stale picker, or a tampered request -- never
      // trusted blindly) just falls through to a random pick from what's
      // actually available here, same as "Generate another" with nothing
      // specified.
      const requested = body.archetypeId
        ? archetypes.find(
            (a) =>
              a.archetypeId === body.archetypeId &&
              a.runId === body.archetypeRunId,
          )
        : undefined;
      const chosen =
        requested ?? archetypes[Math.floor(Math.random() * archetypes.length)];

      const systemPrompt = buildExerciseGenerationPrompt({
        subjectName: body.subjectName,
        boardName: body.boardName,
        gradeName: body.gradeName,
        medium,
        responseLanguage,
        chapter: body.chapter,
        topic: body.topic,
        count: 1,
        archetypes: [chosen],
        requestedDifficulty,
        requestedType,
      });
      const { text } = await getChatReply({
        systemPrompt,
        history: [],
        message: "Generate the exercise now.",
        maxTokens: EXERCISE_MAX_TOKENS,
        event: {
          loggable: true,
          userId: body.userId,
          mode: "student",
          boardId: scope.boardId,
          gradeId: scope.gradeId,
          subjectId: scope.subjectId,
          medium: scope.medium,
          question: `topic-exercises/generate: ${body.chapter} / ${body.topic} (${chosen.name})`,
        },
      });

      const parsed = parseGeneratedExercises(text);
      const first = parsed[0];
      const archetypeAttribution = {
        runId: chosen.runId,
        archetypeId: chosen.archetypeId,
      };
      // requestedType wins over the model's own self-reported "Type: ..."
      // tag -- see the identical fix (and its own comment) in
      // /v1/topic-exercises/generate-for-concept above.
      const item = first
        ? await storeGeneratedExercise(
            scope,
            body.topicId,
            body.userId,
            { ...first, type: requestedType ?? first.type },
            archetypeAttribution,
          )
        : null;

      if (item) {
        void recordArchetypeProgress({
          userId: body.userId,
          boardId: body.boardId,
          gradeId: body.gradeId,
          subjectId: body.subjectId,
          medium,
          chapter: body.chapter,
          topic: body.topic,
          archetypes: [chosen],
        });
      }

      const response: GenerateTopicExerciseResponse = { exercise: item };
      res.json(response);
    } catch (err) {
      console.error("On-demand topic exercise generation failed:", err);
      res.status(502).json({
        error:
          "Could not generate a question right now. Please try again shortly.",
      });
    }
  },
);

// Grades a student's own attempt at ONE exercise, submitted before they've
// seen the worked solution (see topic-summary-message.tsx's own hide-
// until-submitted flow). question/expectedAnswer/scope are all re-derived
// from the exercise's own stored row (getExerciseForGrading), never
// trusted from the request -- a student grading their own attempt must
// never be able to supply their own "expected answer." The real solution
// is returned regardless of the verdict (or even if grading itself
// failed to parse) -- withholding it any further than "until the student
// has made an attempt" serves no purpose.
app.post(
  "/v1/topic-exercises/grade",
  requireSharedSecret,
  async (req: Request, res: Response) => {
    const body = req.body as Partial<GradeExerciseRequest> | undefined;

    if (
      !body ||
      typeof body.userId !== "string" ||
      !body.userId ||
      typeof body.exerciseId !== "string" ||
      !body.exerciseId ||
      typeof body.studentAnswer !== "string" ||
      !body.studentAnswer.trim()
    ) {
      res
        .status(400)
        .json({ error: "userId, exerciseId, and studentAnswer are required" });
      return;
    }

    const exercise = await getExerciseForGrading(body.exerciseId);
    if (!exercise) {
      res.status(404).json({ error: "Exercise not found." });
      return;
    }

    try {
      const graded = await gradeExerciseAnswer({
        subjectName: exercise.subjectName,
        medium: exercise.medium as Medium,
        question: exercise.question,
        expectedAnswer: exercise.answer,
        studentAnswer: body.studentAnswer,
        event: {
          loggable: true,
          userId: body.userId,
          mode: "student",
          boardId: exercise.boardId,
          gradeId: exercise.gradeId,
          subjectId: exercise.subjectId,
          medium: exercise.medium as Medium,
          question: `topic-exercises/grade: ${exercise.question.slice(0, 80)}`,
        },
      });

      // Only credited when grading actually produced a real verdict AND the
      // exercise itself was archetype-grounded AND that archetype's own
      // chapter/topic resolved (see getExerciseForGrading's own comment --
      // absent for a chat-originated bank entry, which can't reach this
      // endpoint's exerciseId in practice, but checked explicitly anyway
      // rather than assumed).
      if (
        graded &&
        exercise.archetypeRunId &&
        exercise.archetypeId &&
        exercise.chapter &&
        exercise.topic
      ) {
        void recordArchetypeAttemptResult({
          userId: body.userId,
          runId: exercise.archetypeRunId,
          archetypeId: exercise.archetypeId,
          boardId: exercise.boardId,
          gradeId: exercise.gradeId,
          subjectId: exercise.subjectId,
          medium: exercise.medium,
          chapter: exercise.chapter,
          topic: exercise.topic,
          result: graded.verdict,
        });
      }

      const response: GradeExerciseResponse = graded
        ? {
            verdict: graded.verdict,
            feedback: graded.feedback,
            answer: exercise.answer,
          }
        : {
            verdict: "partially_correct",
            feedback:
              "We couldn't automatically check this attempt -- compare it with the solution below.",
            answer: exercise.answer,
          };
      res.json(response);
    } catch (err) {
      console.error("Exercise grading failed:", err);
      res.status(502).json({
        error:
          "Could not grade this attempt right now. Please try again shortly.",
      });
    }
  },
);

// Fisher-Yates, in place on a shallow copy -- used by the practice-paper
// generate route to randomize which topics its round-robin draws from
// first, see that route's own comment on why.
function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Generates ONE practice-paper question grounded in one topic, following
// the same archetype -> concept -> ungrounded fallback chain
// /v1/topic-exercises (archetype-grounded, falls back to ungrounded) and
// /v1/topic-exercises/generate-for-concept (concept-grounded, reached only
// via its own separate picker) each cover HALF of on their own -- there is
// no single existing function that chains all three, since a student
// browsing the "Relevant Exercises" flow always resolves that choice
// themselves by which picker they land in. Null only when generation or
// storage genuinely failed for this one question -- the caller just skips
// it rather than failing the whole paper over one bad slot.
async function generatePracticePaperQuestion(params: {
  userId: string;
  scope: Omit<AnswerScope, "question" | "topicId">;
  subjectName: string;
  boardName: string;
  gradeName: string;
  medium: Medium;
  topic: PracticePaperTopic;
  type: ExerciseType;
}): Promise<{ id: string; question: string; type: ExerciseType } | null> {
  const {
    userId,
    scope,
    subjectName,
    boardName,
    gradeName,
    medium,
    topic,
    type,
  } = params;

  const archetypes = await findArchetypesForTopic({
    boardName,
    gradeName,
    subjectName,
    chapter: topic.chapter,
    topic: topic.topic,
  });

  let systemPrompt: string;
  if (archetypes.length > 0) {
    systemPrompt = buildExerciseGenerationPrompt({
      subjectName,
      boardName,
      gradeName,
      medium,
      chapter: topic.chapter,
      topic: topic.topic,
      count: 1,
      archetypes,
      requestedType: type,
    });
  } else {
    const concepts = await findConceptsForTopic(topic.id);
    const concept =
      concepts.length > 0
        ? await findConceptContent(topic.id, concepts[0].id)
        : null;
    systemPrompt = concept
      ? buildConceptExerciseGenerationPrompt({
          subjectName,
          boardName,
          gradeName,
          medium,
          chapter: topic.chapter,
          topic: topic.topic,
          conceptTerm: concept.term,
          conceptContent: concept.content,
          count: 1,
          requestedType: type,
        })
      : buildExerciseGenerationPrompt({
          subjectName,
          boardName,
          gradeName,
          medium,
          chapter: topic.chapter,
          topic: topic.topic,
          count: 1,
          archetypes: [],
          requestedType: type,
        });
  }

  const { text } = await getChatReply({
    systemPrompt,
    history: [],
    message: "Generate the exercises now.",
    maxTokens: EXERCISE_MAX_TOKENS,
    // Reported directly: this call -- fired once per practice-paper
    // question, up to 41 times per paper (see practiceBlueprint.ts) -- was
    // spending real tokens with nothing ever recorded into chat_events,
    // invisible both to the monthly usage-limit check and to
    // /admin/observability's cost reporting. See LlmCallContext's own
    // comment for the other two paths this same gap was found in.
    event: {
      loggable: true,
      userId,
      mode: "student",
      boardId: scope.boardId,
      gradeId: scope.gradeId,
      subjectId: scope.subjectId,
      medium: scope.medium,
      question: `practice-paper/generate: ${topic.chapter} / ${topic.topic} (${type})`,
    },
  });

  const [exercise] = parseGeneratedExercises(text);
  if (!exercise) return null;

  // Same patternIndex -> archetype resolution as /v1/topic-exercises'
  // batch handler above -- with count:1, a successfully-tagged exercise's
  // patternIndex should be 1, but resolved the same defensive way rather
  // than assumed.
  const archetype =
    typeof exercise.patternIndex === "number"
      ? archetypes[exercise.patternIndex - 1]
      : undefined;
  const archetypeAttribution = archetype
    ? { runId: archetype.runId, archetypeId: archetype.archetypeId }
    : null;

  // The requested type is always what every blueprint job asks for here
  // (never "Any" -- unlike the student-facing pickers, a practice-paper
  // job always has a specific type in mind), so it always wins over the
  // model's own self-tag -- same reasoning as
  // /v1/topic-exercises/generate-for-concept's identical override
  // (confirmed directly: the model reliably WRITES the requested type's
  // actual content, but its own self-classification tag is the less
  // reliable of the two signals).
  const stored = await storeGeneratedExercise(
    scope,
    topic.id,
    userId,
    { question: exercise.question, answer: exercise.answer, type },
    archetypeAttribution,
  );
  if (!stored) return null;

  return { id: stored.id, question: stored.question, type };
}

// A student can select any number of chapters, even the whole syllabus --
// no cap on the request itself (reported directly: an earlier version
// capped this at 4, which was unwanted). This builds a full, fixed
// 80-mark paper from buildPracticeBlueprint -- see its own comment on why
// this isn't student-configurable, and why it no longer scales with
// selection size (an earlier version did, which was the actual cause of a
// separate report that the paper's own total marks looked wrong/
// inconsistent). topics is shuffled once up front so the round-robin below
// draws a varied sample across a large selection instead of
// deterministically only ever reaching the first few chapters in array
// order -- the blueprint's own question count is fixed regardless of
// selection size, so without this, selecting the whole syllabus would
// silently only ever generate questions from whichever chapter happened to
// be resolved first.
app.post(
  "/v1/practice-paper/generate",
  requireSharedSecret,
  async (req: Request, res: Response) => {
    const body = req.body as Partial<GeneratePracticePaperRequest> | undefined;

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
      !Array.isArray(body.topics) ||
      body.topics.length === 0
    ) {
      res.status(400).json({
        error:
          "userId, boardId, gradeId, subjectId, subjectName, boardName, gradeName, medium, and a non-empty topics array are required",
      });
      return;
    }

    const userId = body.userId;
    const subjectName = body.subjectName;
    const boardName = body.boardName;
    const gradeName = body.gradeName;
    const medium = body.medium as Medium;
    // Shuffled (not the caller's own resolution order) -- see the route
    // comment above on why: the round-robin below only ever draws
    // `jobs.length` topics total, which is far fewer than a large/whole-
    // syllabus selection can contain.
    const topics = shuffle(body.topics as PracticePaperTopic[]);
    const scope = {
      boardId: body.boardId,
      gradeId: body.gradeId,
      subjectId: body.subjectId,
      medium,
    };

    const blueprint = buildPracticeBlueprint();
    const jobs: { type: ExerciseType; marks: number }[] = blueprint.flatMap(
      (section) =>
        Array.from({ length: section.count }, () => ({
          type: section.type,
          marks: section.marksEach,
        })),
    );

    try {
      const questions: PracticePaperQuestion[] = [];
      let topicCursor = 0;
      // Bounded concurrency -- not full parallelism (the fixed blueprint is
      // 41 LLM calls every time now, see practiceBlueprint.ts -- unnecessary
      // load on the provider all at once) and not sequential (too slow for a
      // student waiting on this request). Raised from 5 to 8 alongside the
      // blueprint's move to a fixed 80-mark/41-question paper, so this still
      // finishes in a similar number of batches (~5) as the old smaller
      // blueprint did at concurrency 5.
      const CONCURRENCY = 8;
      for (let i = 0; i < jobs.length; i += CONCURRENCY) {
        const chunk = jobs.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          chunk.map((job) => {
            const topic = topics[topicCursor % topics.length];
            topicCursor += 1;
            return generatePracticePaperQuestion({
              userId,
              scope,
              subjectName,
              boardName,
              gradeName,
              medium,
              topic,
              type: job.type,
            }).then((result) =>
              result ? { ...result, marks: job.marks } : null,
            );
          }),
        );
        for (const result of results) {
          if (!result) continue;
          questions.push({
            answeredQuestionId: result.id,
            question: result.question,
            type: result.type,
            marks: result.marks,
            sortOrder: questions.length,
          });
        }
      }

      const response: GeneratePracticePaperResponse = {
        questions,
        totalMarks: questions.reduce((sum, q) => sum + q.marks, 0),
      };
      res.json(response);
    } catch (err) {
      console.error("Practice-paper generation failed:", err);
      res.status(502).json({
        error:
          "Could not generate a practice paper right now. Please try again shortly.",
      });
    }
  },
);

// Grades an entire submitted practice paper from one or more photographed
// answer-sheet pages in a single vision call -- see
// buildPracticePaperGradingPrompt/practicePaperGrading.ts. Deliberately
// re-derives every question's own expected answer from answered_questions
// here rather than trusting it from the request body -- see
// EvaluatePracticePaperRequest's own comment on this trust boundary.
app.post(
  "/v1/practice-paper/evaluate",
  requireSharedSecret,
  async (req: Request, res: Response) => {
    const body = req.body as Partial<EvaluatePracticePaperRequest> | undefined;

    if (
      !body ||
      typeof body.userId !== "string" ||
      !body.userId ||
      typeof body.subjectId !== "string" ||
      !body.subjectId ||
      typeof body.subjectName !== "string" ||
      typeof body.medium !== "string" ||
      !Array.isArray(body.questions) ||
      body.questions.length === 0 ||
      !Array.isArray(body.images) ||
      body.images.length === 0 ||
      body.images.length > MAX_IMAGES_PER_SUBMISSION
    ) {
      res.status(400).json({
        error: `userId, subjectId, subjectName, medium, a non-empty questions array, and 1-${MAX_IMAGES_PER_SUBMISSION} images are required`,
      });
      return;
    }

    const medium = body.medium as Medium;
    const requestQuestions = body.questions;
    const images = body.images as ImageAttachment[];
    for (const image of images) {
      if (
        !image ||
        typeof image.base64 !== "string" ||
        !ALLOWED_IMAGE_TYPES.has(image.mediaType as ImageMediaType) ||
        image.base64.length > MAX_IMAGE_BASE64_LENGTH
      ) {
        res
          .status(400)
          .json({ error: "One or more images were invalid or too large" });
        return;
      }
    }

    try {
      const answers = await getAnswersForGrading(
        requestQuestions.map((q) => q.answeredQuestionId),
      );
      const gradingQuestions = requestQuestions
        .map((q) => {
          const answer = answers.get(q.answeredQuestionId);
          if (!answer) return null;
          return {
            id: q.id,
            question: answer.question,
            expectedAnswer: answer.answer,
            type: q.type,
            marks: q.marks,
          };
        })
        .filter((q): q is NonNullable<typeof q> => q !== null);

      if (gradingQuestions.length === 0) {
        res.status(502).json({
          error: "Could not load this paper's own questions for grading.",
        });
        return;
      }

      const systemPrompt = buildPracticePaperGradingPrompt({
        subjectName: body.subjectName as string,
        medium,
        questions: gradingQuestions,
      });
      const { text } = await getGradingReply({
        systemPrompt,
        images,
        maxTokens: EXERCISE_MAX_TOKENS,
        // Reported directly: this route (grading a photographed answer
        // sheet) had no scope at all, so it was spending real vision-model
        // tokens with nothing ever recorded into chat_events -- see
        // LlmCallContext's own comment for the other two paths this same
        // gap was found in.
        event: {
          loggable: true,
          userId: body.userId,
          mode: "student",
          boardId: body.boardId,
          gradeId: body.gradeId,
          subjectId: body.subjectId,
          medium,
          question: `practice-paper/evaluate: ${gradingQuestions.length} questions`,
        },
      });

      const parsed = parsePracticePaperGrading(
        text,
        gradingQuestions.map((q) => ({ id: q.id, marks: q.marks })),
      );
      if (!parsed) {
        res.status(502).json({
          error:
            "Could not grade this submission right now. Please try again shortly.",
        });
        return;
      }

      const results: EvaluatePracticePaperResponse["results"] = parsed.results;
      const response: EvaluatePracticePaperResponse = {
        results,
        totalScore: results.reduce((sum, r) => sum + r.score, 0),
        maxPossibleScore: gradingQuestions.reduce((sum, q) => sum + q.marks, 0),
        overallFeedback: parsed.overallFeedback,
      };
      res.json(response);
    } catch (err) {
      console.error("Practice-paper evaluation failed:", err);
      res.status(502).json({
        error:
          "Could not grade this submission right now. Please try again shortly.",
      });
    }
  },
);

app.listen(PORT, () => {
  console.log(`Orchestration service listening on port ${PORT}`);
});
