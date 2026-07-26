import express from "express";
import type { NextFunction, Request, Response } from "express";
import { findAnswerInBank, recordAnswer } from "./answerBank.js";
import { getCachedAnswer, setCachedAnswer } from "./cache.js";
import { getChatReply } from "./llm.js";
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
  const body = req.body as Partial<ChatOrchestrationRequest> | undefined;

  if (!body || (body.mode !== "student" && body.mode !== "staff")) {
    res.status(400).json({ error: "mode must be 'student' or 'staff'" });
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
  if (body.mode === "staff") {
    try {
      const reply = await getChatReply({
        systemPrompt: buildStaffSystemPrompt(body.subjectName),
        history,
        message: body.message,
        maxTokens: MAX_TOKENS,
      });
      const response: ChatOrchestrationResponse = { reply, source: "llm" };
      res.json(response);
    } catch (err) {
      console.error("LLM chat completion failed:", err);
      res.status(502).json({ error: "The tutor is temporarily unavailable. Please try again shortly." });
    }
    return;
  }

  const studentBody = body as Extract<ChatOrchestrationRequest, { mode: "student" }>;
  if (
    typeof studentBody.subjectId !== "string" ||
    !studentBody.subjectId ||
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
        "subjectId, boardId, gradeId, boardName, gradeName, medium, and topics are required for mode='student'",
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
      const response: ChatOrchestrationResponse = { reply: cached, source: "cache" };
      res.json(response);
      return;
    }

    const fromBank = await findAnswerInBank(scope);
    if (fromBank) {
      // Cache missed but the database had it -- populate cache so the next
      // ask of this same question is an L1 hit.
      void setCachedAnswer(scope, fromBank);
      const response: ChatOrchestrationResponse = { reply: fromBank, source: "database" };
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
    const reply = await getChatReply({
      systemPrompt,
      history,
      message: studentBody.message,
      maxTokens: MAX_TOKENS,
    });

    if (scope) {
      void setCachedAnswer(scope, reply);
      void recordAnswer(scope, reply);
    }

    const response: ChatOrchestrationResponse = { reply, source: "llm" };
    res.json(response);
  } catch (err) {
    console.error("LLM chat completion failed:", err);
    res.status(502).json({ error: "The tutor is temporarily unavailable. Please try again shortly." });
  }
});

app.listen(PORT, () => {
  console.log(`Orchestration service listening on port ${PORT}`);
});
