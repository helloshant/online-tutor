import express from "express";
import type { NextFunction, Request, Response } from "express";
import { calculateCostUsd } from "./pricing.js";
import { getSupabaseClient } from "./supabaseClient.js";
import type { ChatEventInput } from "./types.js";

const PORT = Number(process.env.PORT) || 4100;
const SHARED_SECRET = process.env.OBSERVABILITY_SHARED_SECRET;

if (!SHARED_SECRET) {
  console.warn(
    "WARNING: OBSERVABILITY_SHARED_SECRET is not set. This service will accept requests from " +
      "anyone who can reach it on the network. Set it before exposing this service beyond a " +
      "trusted internal network (e.g. the docker-compose network)."
  );
}

const app = express();
app.use(express.json({ limit: "256kb" }));

// Mirrors the orchestrator's own /health diagnostics (non-secret config
// presence only) -- this service has its own separate SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY env vars, distinct from the orchestrator's, so
// "the orchestrator is configured" says nothing about whether this service
// is too. Checkable independently instead of only via container logs.
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    storage: {
      supabaseUrl: process.env.SUPABASE_URL || null,
      configured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
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

// Called by the orchestrator, fire-and-forget, after every /v1/chat request
// -- never blocks or affects a student's reply. Any failure here (bad
// Supabase connection, insert error) is logged and reported to the caller,
// but the orchestrator treats it as best-effort and never surfaces it to
// the student.
app.post("/v1/events", requireSharedSecret, async (req: Request, res: Response) => {
  const body = req.body as Partial<ChatEventInput> | undefined;

  if (
    !body ||
    typeof body.userId !== "string" ||
    !body.userId ||
    (body.mode !== "student" && body.mode !== "staff") ||
    typeof body.subjectId !== "string" ||
    !body.subjectId ||
    typeof body.question !== "string" ||
    !body.question ||
    !body.source ||
    !["cache", "database", "llm", "rejected", "chapter_notes"].includes(body.source)
  ) {
    res.status(400).json({
      error: "userId, mode, subjectId, question, and a valid source are required",
    });
    return;
  }

  let costUsd: number | null = null;
  if (body.source === "llm") {
    if (
      typeof body.provider !== "string" ||
      !body.provider ||
      typeof body.model !== "string" ||
      !body.model ||
      typeof body.promptTokens !== "number" ||
      typeof body.completionTokens !== "number"
    ) {
      res.status(400).json({
        error: "provider, model, promptTokens, and completionTokens are required for source='llm'",
      });
      return;
    }
    costUsd = calculateCostUsd(body.provider, body.model, body.promptTokens, body.completionTokens);
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    res.json({ ok: true, recorded: false });
    return;
  }

  const { error } = await supabase.from("chat_events").insert({
    user_id: body.userId,
    mode: body.mode,
    board_id: body.boardId ?? null,
    grade_id: body.gradeId ?? null,
    subject_id: body.subjectId,
    medium: body.medium ?? null,
    question: body.question,
    source: body.source,
    provider: body.provider ?? null,
    model: body.model ?? null,
    prompt_tokens: body.promptTokens ?? null,
    completion_tokens: body.completionTokens ?? null,
    total_tokens:
      typeof body.promptTokens === "number" && typeof body.completionTokens === "number"
        ? body.promptTokens + body.completionTokens
        : null,
    cost_usd: costUsd,
    answer_bank_id: body.answerBankId ?? null,
    latency_ms: body.latencyMs ?? null,
  });

  if (error) {
    console.error("Failed to record chat event:", error);
    res.status(502).json({ error: "Failed to record event" });
    return;
  }

  res.json({ ok: true, recorded: true });
});

app.listen(PORT, () => {
  console.log(`Observability service listening on port ${PORT}`);
});
