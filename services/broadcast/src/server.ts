import express from "express";
import type { NextFunction, Request, Response } from "express";
import { sendBroadcast } from "./audience.js";
import { gradeAnswer, submitTest } from "./grading.js";
import type { Medium } from "./types.js";

const PORT = Number(process.env.PORT) || 4300;
const SHARED_SECRET = process.env.BROADCAST_SHARED_SECRET;

// Fail closed, same reasoning as services/payment: this service fans out
// who receives a broadcast and records test scores, so refusing to run
// unauthenticated is a better default than a warning that's easy to miss
// in container logs.
if (!SHARED_SECRET) {
  console.error(
    "FATAL: BROADCAST_SHARED_SECRET is not set. This service refuses to start without it -- see " +
      "services/broadcast/.env.example."
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "64kb" }));

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
  if (req.header("x-internal-api-key") !== SHARED_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// Every route below must return through res.json -- this top-level catch is
// the backstop so an unexpected throw never reaches the caller as a
// hung/empty response. Same pattern as services/payment/orchestrator.
function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((err) => {
      console.error(`Unexpected error in ${req.method} ${req.path}:`, err);
      res.status(500).json({ error: err instanceof Error ? err.message : "Something went wrong. Please try again." });
    });
  };
}

// Called by the web app's "Send" admin action right after it's confirmed
// (via requireAdminPage) the caller is an admin/superadmin and the
// broadcast is still a draft -- this service doesn't re-check either of
// those (there's no student-facing trust boundary being crossed here the
// way test scoring has), it just does the actual audience resolution +
// fan-out, which is the part worth a single source of truth.
app.post(
  "/v1/broadcasts/:id/send",
  requireSharedSecret,
  asyncRoute(async (req, res) => {
    const body = req.body as Partial<{
      boardId: string | null;
      gradeId: string | null;
      subjectId: string | null;
      medium: Medium | null;
    }>;
    const result = await sendBroadcast(req.params.id, {
      boardId: body.boardId ?? null,
      gradeId: body.gradeId ?? null,
      subjectId: body.subjectId ?? null,
      medium: body.medium ?? null,
    });
    res.json(result);
  })
);

// Called by the web app's POST /api/broadcasts/[id]/test/submit proxy
// route, which has already confirmed the caller is authenticated and is a
// recipient of this broadcast -- this service re-verifies the attempt
// itself (see submitTest) rather than trusting either check, since it's
// the actual trust boundary for what score gets recorded.
app.post(
  "/v1/broadcasts/:id/test/submit",
  requireSharedSecret,
  asyncRoute(async (req, res) => {
    const body = req.body as Partial<{ userId: string; answers: unknown }>;
    if (typeof body.userId !== "string" || !body.userId || !Array.isArray(body.answers)) {
      res.status(400).json({ error: "userId and an answers array are required" });
      return;
    }
    const result = await submitTest(req.params.id, body.userId, body.answers);
    res.json(result);
  })
);

// Called by the admin test-results page when grading one short_answer
// response. Re-derives the attempt's total/status from every answer row
// rather than trusting an incremental patch -- see grading.ts.
app.post(
  "/v1/test-answers/:id/grade",
  requireSharedSecret,
  asyncRoute(async (req, res) => {
    const body = req.body as Partial<{ score: number }>;
    if (typeof body.score !== "number" || !Number.isFinite(body.score)) {
      res.status(400).json({ error: "score (a number) is required" });
      return;
    }
    const result = await gradeAnswer(req.params.id, body.score);
    res.json(result);
  })
);

app.listen(PORT, () => {
  console.log(`Broadcast service listening on port ${PORT}`);
});
