import express from "express";
import type { NextFunction, Request, Response } from "express";
import { getChatReply } from "./llm.js";
import { buildStaffSystemPrompt, buildTutorSystemPrompt } from "./prompts.js";
import type { ChatOrchestrationRequest, ChatOrchestrationResponse } from "./types.js";

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

  let systemPrompt: string;
  if (body.mode === "staff") {
    systemPrompt = buildStaffSystemPrompt(body.subjectName);
  } else {
    const studentBody = body as Extract<ChatOrchestrationRequest, { mode: "student" }>;
    if (
      typeof studentBody.boardName !== "string" ||
      typeof studentBody.gradeName !== "string" ||
      typeof studentBody.medium !== "string" ||
      !Array.isArray(studentBody.topics)
    ) {
      res
        .status(400)
        .json({ error: "boardName, gradeName, medium, and topics are required for mode='student'" });
      return;
    }
    systemPrompt = buildTutorSystemPrompt({
      subjectName: studentBody.subjectName,
      boardName: studentBody.boardName,
      gradeName: studentBody.gradeName,
      medium: studentBody.medium,
      topics: studentBody.topics,
      message: studentBody.message,
    });
  }

  try {
    const reply = await getChatReply({
      systemPrompt,
      history,
      message: body.message,
      maxTokens: MAX_TOKENS,
    });
    const response: ChatOrchestrationResponse = { reply };
    res.json(response);
  } catch (err) {
    console.error("LLM chat completion failed:", err);
    res.status(502).json({ error: "The tutor is temporarily unavailable. Please try again shortly." });
  }
});

app.listen(PORT, () => {
  console.log(`Orchestration service listening on port ${PORT}`);
});
