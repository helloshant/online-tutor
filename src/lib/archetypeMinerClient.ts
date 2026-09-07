import "server-only";

import type { EducationContext } from "./archetypeMinerTypes";

// Only the two operations that actually trigger background LLM work go
// through the archetype-miner service -- submitting a pipeline run and
// mining cross-level archetype families. Everything else the admin UI
// needs (listing runs, browsing the mined catalogue, viewing/resolving the
// review queue, listing families) reads/writes the archetype_* tables
// directly with the ordinary admin session client, the same way
// chapter_documents/broadcasts/coupon_codes already do -- those RLS
// policies already grant an admin exactly that access (see
// supabase/migrations/0038_archetype_miner.sql and
// 0039_archetype_miner_admin_and_families.sql), so there's no reason to
// proxy a plain read/CRUD operation through an extra HTTP hop.

function getArchetypeMinerUrl(): string {
  const url = process.env.ARCHETYPE_MINER_URL;
  if (!url) throw new Error("Missing ARCHETYPE_MINER_URL environment variable");
  return url;
}

type RawPaperInput = {
  paper: {
    subject: string;
    year: number;
    board: string;
    class: string;
    set_code: string | null;
    paper_type: "board_exam" | "sample_paper" | "compartment";
    source_url: string;
    extraction_method: "native_text" | "ocr";
  };
  // Exactly one of these -- see the archetype-miner service's own
  // types.ts (RawPaperInput) and server.ts for the runtime check.
  raw_text?: string;
  pdf_base64?: string;
};

export type SubmitPipelineRunRequest = {
  educationContext: EducationContext;
  curriculumTaxonomyText?: string;
  createdBy?: string | null;
  // Explicit per-run choice -- omit to let the service fall back to its
  // own LLM_PROVIDER default. See ArchetypeMinerLlmProvider below and
  // SubmitRunParams.llmProvider's own comment in pipelineRunner.ts.
  llmProvider?: ArchetypeMinerLlmProvider;
} & ({ inputKind: "raw_papers"; papers: RawPaperInput[] } | { inputKind: "pre_segmented"; questions: unknown[] });

export async function submitPipelineRun(request: SubmitPipelineRunRequest): Promise<{ runId: string }> {
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/pipeline/runs`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const body: Record<string, unknown> = {
    education_context: request.educationContext,
    curriculum_taxonomy_text: request.curriculumTaxonomyText,
    input_kind: request.inputKind,
    created_by: request.createdBy ?? undefined,
    llm_provider: request.llmProvider,
  };
  if (request.inputKind === "raw_papers") body.papers = request.papers;
  else body.questions = request.questions;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sharedSecret ? { "x-internal-api-key": sharedSecret } : {}),
    },
    body: JSON.stringify(body),
  });

  const responseBody = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(responseBody?.error ?? `Archetype-miner run submission failed with status ${res.status}`);
  }
  if (!responseBody || typeof responseBody.runId !== "string") {
    throw new Error("Archetype-miner returned an unexpected response shape");
  }
  return { runId: responseBody.runId };
}

export type ArchetypeMinerLlmProvider = "anthropic" | "azure-openai";

// Used by the submit-run page to know whether a PDF paper upload will
// actually work before an admin tries one -- only the Anthropic provider
// supports Stage 0 reading a PDF's pages directly (see
// anthropicProvider.ts); the service rejects a PDF outright when it's
// running on Azure OpenAI (see azureOpenAIProvider.ts). No shared-secret
// header -- /health is deliberately unauthenticated, same as the
// docker-compose healthcheck that already calls it. Returns null (rather
// than throwing) when the service can't be reached at all, so a page
// render never breaks over this -- the caller falls back to assuming PDF
// upload is available, the same as before this existed.
export async function getArchetypeMinerHealth(): Promise<{ llmProvider: ArchetypeMinerLlmProvider } | null> {
  try {
    const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/health`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (body?.llmProvider !== "anthropic" && body?.llmProvider !== "azure-openai") return null;
    return { llmProvider: body.llmProvider };
  } catch (err) {
    console.error("Failed to check archetype-miner service health:", err);
    return null;
  }
}

export type Stage3RecoveryPreview = { affectedRuns: number; affectedArchetypes: number; inProgress: boolean };

// See the service's own stage3Recovery.ts for what this backfills and
// why -- a one-time recovery for archetypes stuck REVIEW by a since-fixed
// Stage 3 prompt bug, never a genuine Stage 3 REVIEW a human should still
// decide. inProgress reflects the service's own in-memory guard against a
// second concurrent pass -- lets the admin page disable the "Recover now"
// button (or say so) instead of a click quietly firing a redundant second
// pass with no visible feedback that anything went wrong.
export async function previewStage3Recovery(): Promise<Stage3RecoveryPreview> {
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/stage3-recovery/preview`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const res = await fetch(url, {
    headers: sharedSecret ? { "x-internal-api-key": sharedSecret } : undefined,
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `Stage 3 recovery preview failed with status ${res.status}`);
  }
  if (typeof body?.affectedRuns !== "number" || typeof body?.affectedArchetypes !== "number") {
    throw new Error("Archetype-miner returned an unexpected response shape");
  }
  return { affectedRuns: body.affectedRuns, affectedArchetypes: body.affectedArchetypes, inProgress: Boolean(body.inProgress) };
}

// Fire-and-forget on the service side (see its own POST route comment) --
// this resolves as soon as the run has STARTED, not once it's finished.
// Throws (with a clear message) on a 409 if a pass is already running --
// the caller should have already disabled the button via preview's own
// inProgress, but this is the real guard, not just the UI affordance.
export async function startStage3Recovery(): Promise<{ started: boolean } & Omit<Stage3RecoveryPreview, "inProgress">> {
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/stage3-recovery/run`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const res = await fetch(url, {
    method: "POST",
    headers: sharedSecret ? { "x-internal-api-key": sharedSecret } : undefined,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `Stage 3 recovery failed to start with status ${res.status}`);
  }
  if (typeof body?.started !== "boolean" || typeof body?.affectedRuns !== "number" || typeof body?.affectedArchetypes !== "number") {
    throw new Error("Archetype-miner returned an unexpected response shape");
  }
  return { started: body.started, affectedRuns: body.affectedRuns, affectedArchetypes: body.affectedArchetypes };
}

export type StudentExplanationBackfillPreview = { pendingArchetypes: number; inProgress: boolean };

// See the service's own studentExplanationBackfill.ts for what this
// backfills and why -- a one-time pass generating the plain-language
// concept explanation shown in the pattern picker for every archetype
// mined before that field existed. Same preview/start/inProgress shape as
// the Stage 3 recovery functions above, for the same reasons.
export async function previewStudentExplanationBackfill(): Promise<StudentExplanationBackfillPreview> {
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/student-explanation-backfill/preview`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const res = await fetch(url, {
    headers: sharedSecret ? { "x-internal-api-key": sharedSecret } : undefined,
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `student_explanation backfill preview failed with status ${res.status}`);
  }
  if (typeof body?.pendingArchetypes !== "number") {
    throw new Error("Archetype-miner returned an unexpected response shape");
  }
  return { pendingArchetypes: body.pendingArchetypes, inProgress: Boolean(body.inProgress) };
}

export async function startStudentExplanationBackfill(): Promise<{ started: boolean; pendingArchetypes: number }> {
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/student-explanation-backfill/run`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const res = await fetch(url, {
    method: "POST",
    headers: sharedSecret ? { "x-internal-api-key": sharedSecret } : undefined,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `student_explanation backfill failed to start with status ${res.status}`);
  }
  if (typeof body?.started !== "boolean" || typeof body?.pendingArchetypes !== "number") {
    throw new Error("Archetype-miner returned an unexpected response shape");
  }
  return { started: body.started, pendingArchetypes: body.pendingArchetypes };
}

export async function mineArchetypeFamilies(
  subjectOrCourse: string,
  llmProvider?: ArchetypeMinerLlmProvider
): Promise<{ familyCount: number }> {
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/archetype-families/mine`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sharedSecret ? { "x-internal-api-key": sharedSecret } : {}),
    },
    body: JSON.stringify({ subject_or_course: subjectOrCourse, llm_provider: llmProvider }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `Family mining failed with status ${res.status}`);
  }
  if (!body || !Array.isArray(body.families)) {
    throw new Error("Archetype-miner returned an unexpected response shape");
  }
  return { familyCount: body.families.length };
}
