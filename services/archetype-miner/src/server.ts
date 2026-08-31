import express from "express";
import type { NextFunction, Request, Response } from "express";
import { getSupabaseClient } from "./supabaseClient.js";
import { submitRun, type SubmitRunParams } from "./pipelineRunner.js";
import { runFamilyMiner } from "./stage4FamilyMiner.js";
import { getActiveLlmProvider, type LlmProvider } from "./llm.js";
import type { Archetype, EducationContext, PreSegmentedInput, RawPaperInput } from "./types.js";

function isValidLlmProvider(value: unknown): value is LlmProvider {
  return value === "anthropic" || value === "azure-openai";
}

const PORT = Number(process.env.PORT) || 4400;
const SHARED_SECRET = process.env.ARCHETYPE_MINER_SHARED_SECRET;

if (!SHARED_SECRET) {
  console.warn(
    "WARNING: ARCHETYPE_MINER_SHARED_SECRET is not set. This service will accept requests from " +
      "anyone who can reach it on the network. Set it before exposing this service beyond a " +
      "trusted internal network (e.g. the docker-compose network)."
  );
}

// Logged once at startup, unconditionally -- LLM_PROVIDER selection has
// bitten real deployments silently (a value that doesn't exact-match
// "azure-openai" -- trailing whitespace, wrong case -- falls back to
// Anthropic with no indication that happened until an API call fails deep
// in a pipeline run; see getActiveLlmProvider's own comment in llm.ts).
// Printing the resolved value here means a misconfigured provider is
// visible in `docker logs` immediately, not just after a failed run.
console.log(`Active LLM provider: ${getActiveLlmProvider()}`);

const app = express();
// Larger than the other services' 256kb: a single raw_papers submission can
// legitimately carry many full exam papers' worth of text in one request --
// or several PDFs (base64 runs ~33% larger than the source bytes; the web
// app caps each PDF/DOCX file at 15MB and MAX_FILES files per submission,
// see admin/archetype-miner/actions.ts) -- matches that app's own
// serverActions.bodySizeLimit (next.config.ts) so neither side is the
// tighter constraint for the same multi-file submission.
app.use(express.json({ limit: "40mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    storage: {
      supabaseUrl: process.env.SUPABASE_URL || null,
      configured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
    llmProvider: getActiveLlmProvider(),
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
    llm_provider: string;
  }>;

  if (!isValidEducationContext(body.education_context)) {
    res.status(400).json({ error: "education_context is required and must match the EducationContext shape" });
    return;
  }

  // Undefined (not defaulted here) when the caller doesn't specify one --
  // submitRun resolves the actual default itself, and stamps whichever
  // value it lands on onto the run row (see pipelineRunner.ts). Rejected
  // outright, rather than silently falling back, when present but not one
  // of the two real values -- a typo here should never quietly run on the
  // wrong provider.
  let llmProvider: LlmProvider | undefined;
  if (body.llm_provider !== undefined) {
    if (!isValidLlmProvider(body.llm_provider)) {
      res.status(400).json({ error: "llm_provider must be 'anthropic' or 'azure-openai' when provided" });
      return;
    }
    llmProvider = body.llm_provider;
  }

  if (body.input_kind === "raw_papers") {
    if (!Array.isArray(body.papers) || body.papers.length === 0) {
      res.status(400).json({ error: "papers must be a non-empty array when input_kind is 'raw_papers'" });
      return;
    }
    // Exactly one of raw_text/pdf_base64 per paper -- see types.ts's own
    // comment on RawPaperInput for why this is a runtime check rather than
    // enforced by the type alone (both are legitimately optional at the
    // type level since a batch can mix text-based and PDF-based papers).
    const badPaperIndex = body.papers.findIndex((p) => {
      const hasText = typeof p.raw_text === "string" && p.raw_text.trim().length > 0;
      const hasPdf = typeof p.pdf_base64 === "string" && p.pdf_base64.trim().length > 0;
      return hasText === hasPdf; // true when both or neither are set
    });
    if (badPaperIndex !== -1) {
      res.status(400).json({
        error: `papers[${badPaperIndex}] must set exactly one of raw_text or pdf_base64, not both or neither`,
      });
      return;
    }
    // A PDF paper needs the run's resolved provider (explicit, or the
    // service default when llmProvider is undefined here) to actually be
    // Anthropic -- azureOpenAIProvider.ts would reject it anyway once
    // Stage 0 runs, but catching it here means a bad combination fails
    // the submission itself (immediate, readable 400) instead of a run
    // that gets created and only fails once it starts executing.
    const hasAnyPdf = body.papers.some((p) => typeof p.pdf_base64 === "string" && p.pdf_base64.trim().length > 0);
    if (hasAnyPdf && (llmProvider ?? getActiveLlmProvider()) !== "anthropic") {
      res.status(400).json({
        error: "A PDF paper requires llm_provider 'anthropic' (or omit llm_provider on a service defaulting to it) -- Azure OpenAI has no native PDF reading.",
      });
      return;
    }
    const params: SubmitRunParams = {
      educationContext: body.education_context,
      curriculumTaxonomyText: body.curriculum_taxonomy_text,
      createdBy: body.created_by ?? null,
      llmProvider,
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
      llmProvider,
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

// Stage 4 -- cross-level ArchetypeFamily mining (see stage4FamilyMiner.ts
// and the source design's own §2.4, deliberately deferred there). Callers
// must name a subject_or_course explicitly -- this deliberately never runs
// over the whole catalogue unprompted, both because that could span an
// unbounded number of unrelated subjects in one LLM call, and because
// mining families is a genuine analytical judgment an admin should
// trigger deliberately, not something that happens as a side effect of
// anything else.
app.post("/v1/archetype-families/mine", requireSharedSecret, async (req: Request, res: Response) => {
  const body = req.body as Partial<{ subject_or_course: string; llm_provider: string }>;
  if (typeof body.subject_or_course !== "string" || !body.subject_or_course.trim()) {
    res.status(400).json({ error: "subject_or_course is required" });
    return;
  }
  let llmProvider: LlmProvider | undefined;
  if (body.llm_provider !== undefined) {
    if (!isValidLlmProvider(body.llm_provider)) {
      res.status(400).json({ error: "llm_provider must be 'anthropic' or 'azure-openai' when provided" });
      return;
    }
    llmProvider = body.llm_provider;
  }

  const supabase = getSupabaseClient();
  // Only archetypes actually accepted into their own catalogue --
  // reviewed/final status, and a critic_decision that means "this
  // archetype stands" (KEEP/REVISE/ADD). MERGE/REMOVE archetypes are gone
  // in all but name; REVIEW ones haven't been settled yet -- none of the
  // three belong in a cross-level relationship built on top of them.
  const { data, error } = await supabase
    .from("archetypes")
    .select("archetype")
    .eq("education_context->>subject_or_course", body.subject_or_course)
    .in("status", ["reviewed", "final"])
    .in("critic_decision", ["KEEP", "REVISE", "ADD"]);

  if (error) {
    res.status(502).json({ error: "Failed to load archetypes for family mining" });
    return;
  }

  const archetypes = (data ?? []).map((row) => row.archetype as Archetype);
  if (archetypes.length === 0) {
    res.json({ families: [] });
    return;
  }

  const result = await runFamilyMiner(archetypes, llmProvider);
  if (!result) {
    res.status(502).json({ error: "Family mining failed" });
    return;
  }

  if (result.families.length > 0) {
    const { error: insertError } = await supabase.from("archetype_families").insert(
      result.families.map((f) => ({
        family_id: f.family_id,
        family_name: f.family_name,
        member_archetype_ids: f.member_archetype_ids,
        progression_notes: f.progression_notes,
        subject_or_course: body.subject_or_course,
      }))
    );
    if (insertError) {
      console.error("Failed to persist archetype families:", insertError);
      res.status(502).json({ error: "Family mining succeeded but failed to save" });
      return;
    }
  }

  res.json({ families: result.families });
});

app.get("/v1/archetype-families", requireSharedSecret, async (req: Request, res: Response) => {
  const supabase = getSupabaseClient();
  let query = supabase.from("archetype_families").select("*");
  if (typeof req.query.subject_or_course === "string") {
    query = query.eq("subject_or_course", req.query.subject_or_course);
  }
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) {
    res.status(502).json({ error: "Failed to load archetype families" });
    return;
  }
  res.json({ families: data ?? [] });
});

app.listen(PORT, () => {
  console.log(`Archetype-miner service listening on port ${PORT}`);
});
