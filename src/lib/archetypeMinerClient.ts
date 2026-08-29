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
  raw_text: string;
};

export type SubmitPipelineRunRequest = {
  educationContext: EducationContext;
  curriculumTaxonomyText?: string;
  createdBy?: string | null;
} & ({ inputKind: "raw_papers"; papers: RawPaperInput[] } | { inputKind: "pre_segmented"; questions: unknown[] });

export async function submitPipelineRun(request: SubmitPipelineRunRequest): Promise<{ runId: string }> {
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/pipeline/runs`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const body: Record<string, unknown> = {
    education_context: request.educationContext,
    curriculum_taxonomy_text: request.curriculumTaxonomyText,
    input_kind: request.inputKind,
    created_by: request.createdBy ?? undefined,
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

export async function mineArchetypeFamilies(subjectOrCourse: string): Promise<{ familyCount: number }> {
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/archetype-families/mine`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sharedSecret ? { "x-internal-api-key": sharedSecret } : {}),
    },
    body: JSON.stringify({ subject_or_course: subjectOrCourse }),
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
