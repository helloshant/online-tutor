import express from "express";
import type { NextFunction, Request, Response } from "express";
import { getSupabaseClient } from "./supabaseClient.js";
import { submitRun, type SubmitRunParams } from "./pipelineRunner.js";
import type { EducationContext, PreSegmentedInput, RawPaperInput } from "./types.js";

const PORT = Number(process.env.PORT) || 4400;
const SHARED_SECRET = process.env.ARCHETYPE_MINER_SHARED_SECRET;

if (!SHARED_SECRET) {
  console.warn(
    "WARNING: ARCHETYPE_MINER_SHARED_SECRET is not set. This service will accept requests from " +
      "anyone who can reach it on the network. Set it before exposing this service beyond a " +
      "trusted internal network (e.g. the docker-compose network)."
  );
}

const app = express();
// Larger than the other services' 256kb: a single raw_papers submission can
// legitimately carry many full exam papers' worth of text in one request.
app.use(express.json({ limit: "20mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    storage: {
      supabaseUrl: process.env.SUPABASE_URL || null,
      configured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
    llmProvider: process.env.LLM_PROVIDER === "azure-openai" ? "azure-openai" : "anthropic",
    embeddingsConfigured: Boolean(process.env.VOYAGE_API_KEY),
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

function isValidEducationContext(value: unknown): value is EducationContext {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const src = v.curriculum_source as Record<string, unknown> | undefined;
  return (
    typeof v.education_stage === "string" &&
    ["secondary", "senior_secondary", "undergraduate"].includes(v.education_stage) &&
    typeof v.grade_or_year === "string" &&
    typeof v.subject_or_course === "string" &&
    typeof src === "object" &&
    src !== null &&
    typeof src.type === "string" &&
    ["school_board", "university_program"].includes(src.type) &&
    typeof src.name === "string" &&
    typeof src.taxonomy_supplied === "boolean"
  );
}

// Submits a new pipeline run. Returns immediately with the run's id once
// it's created (status: "pending") -- the actual segment/analyze/cluster/
// mine/critique work happens in the background (see pipelineRunner.ts);
// poll GET /v1/pipeline/runs/:id for progress.
app.post("/v1/pipeline/runs", requireSharedSecret, async (req: Request, res: Response) => {
  const body = req.body as Partial<{
    education_context: unknown;
    curriculum_taxonomy_text: string;
    input_kind: string;
    papers: RawPaperInput[];
    questions: PreSegmentedInput[];
    created_by: string;
  }>;

  if (!isValidEducationContext(body.education_context)) {
    res.status(400).json({ error: "education_context is required and must match the EducationContext shape" });
    return;
  }

  if (body.input_kind === "raw_papers") {
    if (!Array.isArray(body.papers) || body.papers.length === 0) {
      res.status(400).json({ error: "papers must be a non-empty array when input_kind is 'raw_papers'" });
      return;
    }
    const params: SubmitRunParams = {
      educationContext: body.education_context,
      curriculumTaxonomyText: body.curriculum_taxonomy_text,
      createdBy: body.created_by ?? null,
      inputKind: "raw_papers",
      papers: body.papers,
    };
    try {
      const runId = await submitRun(params);
      res.status(201).json({ runId });
    } catch (err) {
      console.error("Failed to submit pipeline run:", err);
      res.status(502).json({ error: "Failed to submit pipeline run" });
    }
    return;
  }

  if (body.input_kind === "pre_segmented") {
    if (!Array.isArray(body.questions) || body.questions.length === 0) {
      res.status(400).json({ error: "questions must be a non-empty array when input_kind is 'pre_segmented'" });
      return;
    }
    const params: SubmitRunParams = {
      educationContext: body.education_context,
      curriculumTaxonomyText: body.curriculum_taxonomy_text,
      createdBy: body.created_by ?? null,
      inputKind: "pre_segmented",
      questions: body.questions,
    };
    try {
      const runId = await submitRun(params);
      res.status(201).json({ runId });
    } catch (err) {
      console.error("Failed to submit pipeline run:", err);
      res.status(502).json({ error: "Failed to submit pipeline run" });
    }
    return;
  }

  res.status(400).json({ error: "input_kind must be 'raw_papers' or 'pre_segmented'" });
});

app.get("/v1/pipeline/runs/:id", requireSharedSecret, async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("archetype_pipeline_runs")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) {
    res.status(502).json({ error: "Failed to load run" });
    return;
  }
  if (!data) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json({ run: data });
});

// The catalogue mined so far for one run -- includes every status
// (candidate/reviewed/final) and every critic_decision, not just a
// filtered "final" view, since a caller inspecting an in-progress or just-
// completed run usually wants to see everything, including what got
// REMOVEd/MERGEd and why. `status` and `critic_decision` query params
// narrow it down when that's not what's wanted.
app.get("/v1/pipeline/runs/:id/archetypes", requireSharedSecret, async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  let query = supabase.from("archetypes").select("*").eq("run_id", req.params.id);
  if (typeof req.query.status === "string") query = query.eq("status", req.query.status);
  if (typeof req.query.critic_decision === "string") query = query.eq("critic_decision", req.query.critic_decision);

  const { data, error } = await query.order("created_at", { ascending: true });
  if (error) {
    res.status(502).json({ error: "Failed to load archetypes" });
    return;
  }
  res.json({ archetypes: data ?? [] });
});

// Pending review-queue items, optionally scoped to one run. This is where
// every "I'm not sure" escalation from the pipeline actually lands -- see
// reviewQueue.ts and the design doc's §6.
app.get("/v1/review-queue", requireSharedSecret, async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  let query = supabase.from("archetype_review_queue").select("*");
  if (typeof req.query.run_id === "string") query = query.eq("run_id", req.query.run_id);
  query = query.eq("status", req.query.status === "resolved" ? "resolved" : "pending");

  const { data, error } = await query.order("created_at", { ascending: true }).limit(500);
  if (error) {
    res.status(502).json({ error: "Failed to load review queue" });
    return;
  }
  res.json({ items: data ?? [] });
});

// Marks one review-queue item resolved. Called by the web app's admin
// action (once built) after a human has actually made the call -- resolved_by
// should be the acting admin's own user id, passed through from that
// session, not asserted by this service.
app.post("/v1/review-queue/:id/resolve", requireSharedSecret, async (req: Request, res: Response) => {
  const body = req.body as Partial<{ resolution: string; resolved_by: string }>;
  if (typeof body.resolution !== "string" || !body.resolution.trim()) {
    res.status(400).json({ error: "resolution is required" });
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("archetype_review_queue")
    .update({
      status: "resolved",
      resolution: body.resolution,
      resolved_by: body.resolved_by ?? null,
      resolved_at: new Date().toISOString(),
    })
    .eq("queue_item_id", req.params.id)
    .select("*")
    .maybeSingle();

  if (error) {
    res.status(502).json({ error: "Failed to resolve review-queue item" });
    return;
  }
  if (!data) {
    res.status(404).json({ error: "Review-queue item not found" });
    return;
  }
  res.json({ item: data });
});

app.listen(PORT, () => {
  console.log(`Archetype-miner service listening on port ${PORT}`);
});
