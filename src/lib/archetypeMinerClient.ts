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

export type CrossRunMergeScope = { boardName: string; gradeName: string; subjectName: string };
export type CrossRunMergePreview = { chapterGroups: number; archetypesInvolved: number; inProgress: boolean };

// See the service's own crossRunMerge.ts for what this catches and why --
// the SAME reasoning pattern mined independently across separate runs,
// under different wording, that Stage 3's own within-run-only MERGE
// detection was never positioned to catch. Always scoped to one explicit
// board/grade/subject (never a blind whole-catalogue sweep), same
// reasoning mineArchetypeFamilies already requires an explicit
// subjectOrCourse for -- a false merge here is a real, silent taxonomy
// error, not just a missed opportunity, so this is a deliberate,
// human-triggered action per scope, not a background sweep.
export async function previewCrossRunMerge(scope: CrossRunMergeScope): Promise<CrossRunMergePreview> {
  const params = new URLSearchParams(scope);
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/cross-run-merge/preview?${params}`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const res = await fetch(url, {
    headers: sharedSecret ? { "x-internal-api-key": sharedSecret } : undefined,
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `Cross-run merge preview failed with status ${res.status}`);
  }
  if (typeof body?.chapterGroups !== "number" || typeof body?.archetypesInvolved !== "number") {
    throw new Error("Archetype-miner returned an unexpected response shape");
  }
  return { chapterGroups: body.chapterGroups, archetypesInvolved: body.archetypesInvolved, inProgress: Boolean(body.inProgress) };
}

export async function startCrossRunMerge(
  scope: CrossRunMergeScope
): Promise<{ started: boolean; chapterGroups: number; archetypesInvolved: number }> {
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/cross-run-merge/run`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sharedSecret ? { "x-internal-api-key": sharedSecret } : {}),
    },
    body: JSON.stringify(scope),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `Cross-run merge failed to start with status ${res.status}`);
  }
  if (typeof body?.started !== "boolean" || typeof body?.chapterGroups !== "number" || typeof body?.archetypesInvolved !== "number") {
    throw new Error("Archetype-miner returned an unexpected response shape");
  }
  return { started: body.started, chapterGroups: body.chapterGroups, archetypesInvolved: body.archetypesInvolved };
}

export type CurriculumReconciliationScope = { boardName: string; gradeName: string; subjectName: string };
export type CurriculumReconciliationPreview = {
  unmatchedChapters: number;
  affectedQuestions: number;
  syllabusValuesAvailable: number;
  inProgress: boolean;
};

// See the service's own curriculumReconciliation.ts for what this fixes
// and why -- already-mined questions whose curriculum.chapter doesn't
// exactly match this app's own curated syllabus_topics wording, which
// silently excludes them from every exact-string match this app does
// against a real syllabus topic (year-coverage, archetype-progress, the
// pattern picker's own lookup). curriculum.topic is deliberately left
// alone (see that file's own comment on why reconciling the full
// chapter+topic pair together doesn't work -- the two systems use
// genuinely different granularities for "topic"). Same scoped,
// human-triggered, preview-first shape as cross-run merge above, for the
// same reason -- a wrong mapping is a real, silent data error, not just a
// missed opportunity.
export async function previewCurriculumReconciliation(scope: CurriculumReconciliationScope): Promise<CurriculumReconciliationPreview> {
  const params = new URLSearchParams(scope);
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/curriculum-reconciliation/preview?${params}`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const res = await fetch(url, {
    headers: sharedSecret ? { "x-internal-api-key": sharedSecret } : undefined,
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `Curriculum reconciliation preview failed with status ${res.status}`);
  }
  if (
    typeof body?.unmatchedChapters !== "number" ||
    typeof body?.affectedQuestions !== "number" ||
    typeof body?.syllabusValuesAvailable !== "number"
  ) {
    throw new Error("Archetype-miner returned an unexpected response shape");
  }
  return {
    unmatchedChapters: body.unmatchedChapters,
    affectedQuestions: body.affectedQuestions,
    syllabusValuesAvailable: body.syllabusValuesAvailable,
    inProgress: Boolean(body.inProgress),
  };
}

export async function startCurriculumReconciliation(
  scope: CurriculumReconciliationScope
): Promise<{ started: boolean; unmatchedChapters: number; affectedQuestions: number }> {
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/curriculum-reconciliation/run`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sharedSecret ? { "x-internal-api-key": sharedSecret } : {}),
    },
    body: JSON.stringify(scope),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `Curriculum reconciliation failed to start with status ${res.status}`);
  }
  if (typeof body?.started !== "boolean" || typeof body?.unmatchedChapters !== "number" || typeof body?.affectedQuestions !== "number") {
    throw new Error("Archetype-miner returned an unexpected response shape");
  }
  return { started: body.started, unmatchedChapters: body.unmatchedChapters, affectedQuestions: body.affectedQuestions };
}

export type UnmatchedChapterEntry = {
  boardName: string;
  gradeName: string;
  subjectName: string;
  chapter: string;
  questionCount: number;
  sampleQuestions: { ref: string; text: string }[];
  acceptableValues: string[];
};

function isUnmatchedChapterEntry(value: unknown): value is UnmatchedChapterEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.boardName === "string" &&
    typeof v.gradeName === "string" &&
    typeof v.subjectName === "string" &&
    typeof v.chapter === "string" &&
    typeof v.questionCount === "number" &&
    Array.isArray(v.sampleQuestions) &&
    Array.isArray(v.acceptableValues)
  );
}

// The human-in-the-loop counterpart to previewCurriculumReconciliation
// above -- see the service's own curriculumReconciliation.ts "Cross-scope
// manual review" section for the full reasoning. Unscoped deliberately:
// every board/grade/subject at once, each row carrying its own real sample
// question text and its own scope's real syllabus values, so an admin can
// browse and act on the whole catalogue's unmatched chapters from one
// page. Long-running (a full-table read service-side) -- this is a review
// page an admin visits deliberately, not something rendered on every
// request.
export async function listUnmatchedChapters(): Promise<UnmatchedChapterEntry[]> {
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/curriculum-reconciliation/unmatched-all`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const res = await fetch(url, {
    headers: sharedSecret ? { "x-internal-api-key": sharedSecret } : undefined,
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `Listing unmatched chapters failed with status ${res.status}`);
  }
  if (!Array.isArray(body?.entries) || !body.entries.every(isUnmatchedChapterEntry)) {
    throw new Error("Archetype-miner returned an unexpected response shape");
  }
  return body.entries;
}

// Attaches one unmatched chapter value, for one scope, onto a real
// syllabus value an admin picked by hand -- the service itself still
// verifies toChapter is a real, verbatim syllabus value for that scope
// before writing anything (never trust the client alone for this).
export async function attachChapterMapping(
  params: CurriculumReconciliationScope & { fromChapter: string; toChapter: string }
): Promise<{ questionsUpdated: number }> {
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/curriculum-reconciliation/attach`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sharedSecret ? { "x-internal-api-key": sharedSecret } : {}),
    },
    body: JSON.stringify(params),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `Attaching chapter mapping failed with status ${res.status}`);
  }
  if (typeof body?.questionsUpdated !== "number") {
    throw new Error("Archetype-miner returned an unexpected response shape");
  }
  return { questionsUpdated: body.questionsUpdated };
}

// Marks one unmatched chapter value, for one scope, as reviewed and
// genuinely unmappable -- see CHAPTER_UNMATCHED_IGNORED_FLAG's own
// comment for what this means and why it's tracked at all.
export async function ignoreUnmatchedChapter(
  params: CurriculumReconciliationScope & { chapter: string }
): Promise<{ questionsMarked: number }> {
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/curriculum-reconciliation/ignore`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sharedSecret ? { "x-internal-api-key": sharedSecret } : {}),
    },
    body: JSON.stringify(params),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `Ignoring unmatched chapter failed with status ${res.status}`);
  }
  if (typeof body?.questionsMarked !== "number") {
    throw new Error("Archetype-miner returned an unexpected response shape");
  }
  return { questionsMarked: body.questionsMarked };
}

export type OffScopeScanScope = { boardName: string; gradeName: string; subjectName: string };
// flaggedQuestions: how many questions in this scope are SITTING, right
// now, with a pending "off-scope" review-queue item -- distinct from
// candidateQuestions (how many still need a look). A scope can show 0
// candidates and still have real, unresolved flags waiting on a human;
// see offScopeContentScan.ts's own countPendingFlaggedInScope for why
// this can't be collapsed into a single "nothing left to scan" number.
export type OffScopeScanPreview = { candidateQuestions: number; flaggedQuestions: number; inProgress: boolean };

// See the service's own offScopeContentScan.ts for what this catches --
// content that reached the catalogue before pipelineRunner.ts started
// checking for it at mining time: a question that's actually a different
// subject entirely, or actually a different grade's own syllabus content.
// Same scoped, human-triggered, preview-first shape as cross-run merge
// and curriculum reconciliation above, for the same reason -- a false
// positive here silently discards real content and removes a legitimate
// archetype.
export async function previewOffScopeContentScan(scope: OffScopeScanScope): Promise<OffScopeScanPreview> {
  const params = new URLSearchParams(scope);
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/off-scope-content-scan/preview?${params}`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const res = await fetch(url, {
    headers: sharedSecret ? { "x-internal-api-key": sharedSecret } : undefined,
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `Off-scope content scan preview failed with status ${res.status}`);
  }
  if (typeof body?.candidateQuestions !== "number" || typeof body?.flaggedQuestions !== "number") {
    throw new Error("Archetype-miner returned an unexpected response shape");
  }
  return { candidateQuestions: body.candidateQuestions, flaggedQuestions: body.flaggedQuestions, inProgress: Boolean(body.inProgress) };
}

export async function startOffScopeContentScan(scope: OffScopeScanScope): Promise<{ started: boolean; candidateQuestions: number }> {
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/off-scope-content-scan/run`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sharedSecret ? { "x-internal-api-key": sharedSecret } : {}),
    },
    body: JSON.stringify(scope),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `Off-scope content scan failed to start with status ${res.status}`);
  }
  if (typeof body?.started !== "boolean" || typeof body?.candidateQuestions !== "number") {
    throw new Error("Archetype-miner returned an unexpected response shape");
  }
  return { started: body.started, candidateQuestions: body.candidateQuestions };
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

// One chapter of a book, already split out of the original OCR text --
// matches RawImportChunk's own shape in admin/chapter-notes/actions.ts
// exactly (chapter_number/chapter_title/text), the format the Chapter
// Notes admin page's "Import chunks" upload already expects, so the OCR
// page's own downloadable output needs no reshaping in between.
export type BookChapterChunk = { chapter_number: number; chapter_title: string; text: string };

// See the archetype-miner service's own bookChapterSegmentation.ts for
// what this does and why it never asks the model to reproduce chapter
// text -- called by admin/archetype-miner/ocr/actions.ts once an admin has
// reviewed/edited the raw OCR output and asks for it to be split into
// chapters.
export async function segmentBookIntoChapters(
  text: string
): Promise<{ chunks: BookChapterChunk[]; unresolvedChapterTitles: string[] }> {
  const url = `${getArchetypeMinerUrl().replace(/\/$/, "")}/v1/book-chapter-segmentation`;
  const sharedSecret = process.env.ARCHETYPE_MINER_SHARED_SECRET;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sharedSecret ? { "x-internal-api-key": sharedSecret } : {}),
    },
    body: JSON.stringify({ text }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `Book chapter segmentation failed with status ${res.status}`);
  }
  if (!body || !Array.isArray(body.chunks) || !Array.isArray(body.unresolvedChapterTitles)) {
    throw new Error("Archetype-miner returned an unexpected response shape");
  }
  return { chunks: body.chunks, unresolvedChapterTitles: body.unresolvedChapterTitles };
}
