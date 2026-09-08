import { getSupabaseClient } from "./supabaseClient.js";
import { getJsonCompletion } from "./jsonCompletion.js";
import { buildCurriculumReconciliationPrompt } from "./prompts.js";
import { getActiveLlmProvider, type LlmProvider } from "./llm.js";

// Stage 1 classifies curriculum.chapter/topic from its own judgment
// whenever no taxonomy document was supplied for that run's curriculum
// source (see curriculumTaxonomy.ts) -- and, confirmed live, ZERO rows
// existed in archetype_curriculum_taxonomies at all before the web app
// started auto-generating one from this app's own syllabus_topics
// catalogue (see the web app's own syllabusTaxonomyText.ts). So every run
// mined before that classified curriculum.chapter purely from the
// model's own judgment, with no anchor to this app's actual curated
// syllabus wording -- producing text that's topically right but doesn't
// exactly match it. Every place that matches a mined archetype back to a
// real syllabus topic (year-coverage, archetype-progress, the pattern
// picker's own topic lookup) only ever compares an archetype's own
// RESOLVED CHAPTER against a real syllabus_topics.chapter OR .topic value
// (see archetypeCoverage.ts's own EITHER-field match) -- it never touches
// curriculum.topic at all. A mismatch there doesn't error -- it just
// silently excludes that archetype from ever showing up under its real
// topic.
//
// Confirmed directly against a real scope (Grade 12 CBSE Biology): 100+
// distinct curriculum.chapter strings exist for what the syllabus itself
// only has 13 real chapter names for -- typos ("Human Health and
// Diseases"), punctuation drift across FOUR different dash characters on
// "Biotechnology ?Principles and Processes" alone, paraphrases
// ("Reproduction in Flowering Plants" for the syllabus's own "Sexual
// Reproduction in Flowering Plants"), and a long tail of one-off stray
// misclassifications that aren't a real syllabus chapter at all.
//
// This reconciles ONLY curriculum.chapter, deliberately never
// curriculum.topic -- an earlier version of this tool tried to reconcile
// the full (chapter, topic) PAIR together and found essentially nothing
// to map (628 "unmatched" pairs, 0 confident mappings) because
// curriculum.topic is a genuinely different granularity from
// syllabus_topics.topic: Stage 1's topic is a fine, often near-unique
// per-QUESTION sub-topic ("Medical Termination of Pregnancy (MTP)"),
// while syllabus_topics.topic is chapter-level ("Reproductive Health").
// Forcing them to match as a pair was never going to work, and isn't
// needed anyway -- nothing that actually surfaces an archetype to a
// student reads curriculum.topic for this purpose. Reconciling
// curriculum.chapter alone, against the union of every real
// syllabus_topics.chapter AND .topic value (either field satisfies the
// app's own EITHER-field match), is both the real fix and a much smaller,
// tractable problem.
//
// Feeding the syllabus taxonomy into Stage 1 prevents this for FUTURE
// mining, but doesn't touch anything already mined. This reconciles what's
// already there: for one board/grade/subject scope, finds every DISTINCT
// curriculum.chapter value already assigned to a real mined question that
// doesn't exactly match a real syllabus value, asks an LLM (given the
// real syllabus list as the only allowed target) to map each one onto the
// closest real chapter -- or flag it as genuinely unmatched, never forced
// -- and rewrites every archetype_question_signatures row carrying that
// chapter value (curriculum.topic is left completely untouched). Chapter
// is resolved for an archetype AT READ TIME from these signature rows
// (see archetypeCoverage.ts's own comment on why), so fixing the
// signatures alone is enough to fix every already-mined archetype's own
// resolved chapter -- nothing on the archetypes table itself needs
// touching.
const PAGE_SIZE = 1000;

type SignatureRow = {
  run_id: string;
  question_id: string;
  signature: { curriculum?: { chapter?: string } };
};

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

async function loadMinedChapters(params: { boardName: string; gradeName: string; subjectName: string }): Promise<SignatureRow[]> {
  const supabase = getSupabaseClient();
  const rows: SignatureRow[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("archetype_question_signatures")
      .select("run_id, question_id, signature")
      .eq("education_context->curriculum_source->>name", params.boardName)
      .eq("education_context->>grade_or_year", params.gradeName)
      .eq("education_context->>subject_or_course", params.subjectName)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      console.error("Curriculum reconciliation: failed to load question signatures:", error);
      break;
    }
    const page = (data ?? []) as SignatureRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

// grades.name is always "Grade N" (see the web app's own
// archetypeGradeName.ts, the inverse of this lookup); education_context.
// grade_or_year -- and therefore this scope's own gradeName -- is always
// the bare "N". Reimplemented here rather than imported since this file
// lives in a different service from that "server-only" web app util (see
// this repo's own established convention for small duplicated helpers
// across service boundaries, e.g. crossRunMerge.ts's own mostCommon()).
async function resolveSyllabusScopeIds(
  supabase: ReturnType<typeof getSupabaseClient>,
  params: { boardName: string; gradeName: string; subjectName: string }
): Promise<{ boardId: string; gradeId: string; subjectId: string } | null> {
  const [{ data: board }, { data: grades }, { data: subject }] = await Promise.all([
    supabase.from("boards").select("id").eq("name", params.boardName).maybeSingle(),
    supabase.from("grades").select("id, name"),
    supabase.from("subjects").select("id").eq("name", params.subjectName).maybeSingle(),
  ]);
  if (!board || !subject) return null;
  const grade = (grades ?? []).find((g: { id: string; name: string }) => g.name.replace(/^grade\s+/i, "").trim() === params.gradeName);
  if (!grade) return null;
  return { boardId: board.id as string, gradeId: grade.id as string, subjectId: subject.id as string };
}

// The union of every real syllabus_topics.chapter AND .topic value for
// this scope -- either field satisfies the app's own EITHER-field match
// (see archetypeCoverage.ts), so both are valid targets for a mined
// chapter to be remapped onto. Exported for offScopeContentScan.ts's own
// use too (see that file's own comment on why it needs this same list) --
// both files live in this one service, so this is a normal shared
// internal import, not the cross-service duplication this repo's own
// convention otherwise accepts for small helpers.
export async function loadAcceptableChapterValues(params: { boardName: string; gradeName: string; subjectName: string }): Promise<string[]> {
  const supabase = getSupabaseClient();
  const ids = await resolveSyllabusScopeIds(supabase, params);
  if (!ids) return [];

  const { data, error } = await supabase
    .from("syllabus_topics")
    .select("chapter, topic")
    .eq("board_id", ids.boardId)
    .eq("grade_id", ids.gradeId)
    .eq("subject_id", ids.subjectId)
    // English only -- the syllabus structure itself (which chapters/topics
    // exist) doesn't vary by medium, only which language a paper is in;
    // including every medium would just duplicate identical values.
    .eq("medium", "English");
  if (error) {
    console.error("Curriculum reconciliation: failed to load syllabus_topics:", error);
    return [];
  }

  const seen = new Set<string>();
  const values: string[] = [];
  for (const row of (data ?? []) as { chapter: string; topic: string }[]) {
    for (const value of [row.chapter, row.topic]) {
      const key = normalize(value);
      if (seen.has(key)) continue;
      seen.add(key);
      values.push(value);
    }
  }
  return values;
}

type UnmatchedChapter = { chapter: string; count: number };

async function computeUnmatched(params: {
  boardName: string;
  gradeName: string;
  subjectName: string;
}): Promise<{ unmatched: UnmatchedChapter[]; acceptableValues: string[] }> {
  const [signatureRows, acceptableValues] = await Promise.all([loadMinedChapters(params), loadAcceptableChapterValues(params)]);
  const acceptableKeys = new Set(acceptableValues.map(normalize));

  const counts = new Map<string, UnmatchedChapter>();
  for (const row of signatureRows) {
    const chapter = row.signature?.curriculum?.chapter?.trim();
    if (!chapter) continue;
    const key = normalize(chapter);
    if (acceptableKeys.has(key)) continue;
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { chapter, count: 1 });
  }

  return { unmatched: Array.from(counts.values()), acceptableValues };
}

export type CurriculumReconciliationPreview = {
  unmatchedChapters: number;
  affectedQuestions: number;
  syllabusValuesAvailable: number;
};

// Counts only -- no LLM call, no writes.
export async function previewCurriculumReconciliation(params: {
  boardName: string;
  gradeName: string;
  subjectName: string;
}): Promise<CurriculumReconciliationPreview> {
  const { unmatched, acceptableValues } = await computeUnmatched(params);
  return {
    unmatchedChapters: unmatched.length,
    affectedQuestions: unmatched.reduce((sum, u) => sum + u.count, 0),
    syllabusValuesAvailable: acceptableValues.length,
  };
}

type Mapping = { fromChapter: string; toChapter: string };

// Every chapter mined for a scope this size can genuinely need mapping in
// one call -- confirmed live, over 100 distinct variants against 13 real
// syllabus chapters for a single scope. A model that gets this WRONG
// (paraphrasing the target instead of copying it verbatim) is caught
// below, not trusted -- so a generous token budget here just means more
// GENUINE mappings get a chance to be found, not more risk.
const MAX_TOKENS = 8000;

async function requestMappings(unmatched: UnmatchedChapter[], acceptableValues: string[], provider: LlmProvider): Promise<Mapping[]> {
  const { data } = await getJsonCompletion({
    systemPrompt: buildCurriculumReconciliationPrompt(),
    message: JSON.stringify({
      unmatched: unmatched.map((u) => ({ chapter: u.chapter, count: u.count })),
      syllabus: acceptableValues,
    }),
    maxTokens: MAX_TOKENS,
    provider,
  });

  if (!Array.isArray(data)) {
    console.warn("Curriculum reconciliation: response was not a JSON array.");
    return [];
  }

  const acceptableKeys = new Set(acceptableValues.map(normalize));
  const mappings: Mapping[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as Record<string, unknown>;
    if (typeof m.from_chapter === "string" && typeof m.to_chapter === "string") {
      // Only trust a mapping whose target is a real, verbatim syllabus
      // value -- a model that paraphrased the target instead of copying
      // it would otherwise introduce a BRAND NEW mismatch, defeating the
      // entire point of this pass.
      if (!acceptableKeys.has(normalize(m.to_chapter))) continue;
      mappings.push({ fromChapter: m.from_chapter, toChapter: m.to_chapter });
    }
  }
  return mappings;
}

// Rewrites curriculum.chapter (ONLY -- curriculum.topic is left exactly
// as mined, see this file's own top comment on why) on every
// archetype_question_signatures row in this scope carrying one FROM
// value. One row at a time (same posture crossRunMerge.ts's own
// processBatch already accepts for its own per-member updates).
async function applyMapping(
  supabase: ReturnType<typeof getSupabaseClient>,
  params: { boardName: string; gradeName: string; subjectName: string },
  mapping: Mapping
): Promise<number> {
  const { data, error } = await supabase
    .from("archetype_question_signatures")
    .select("run_id, question_id, signature")
    .eq("education_context->curriculum_source->>name", params.boardName)
    .eq("education_context->>grade_or_year", params.gradeName)
    .eq("education_context->>subject_or_course", params.subjectName)
    .eq("signature->curriculum->>chapter", mapping.fromChapter);
  if (error) {
    console.error(`Curriculum reconciliation: failed to load rows for "${mapping.fromChapter}":`, error);
    return 0;
  }

  let updated = 0;
  for (const row of (data ?? []) as SignatureRow[]) {
    const nextSignature = { ...row.signature, curriculum: { ...row.signature.curriculum, chapter: mapping.toChapter } };
    const { error: updateError } = await supabase
      .from("archetype_question_signatures")
      .update({ signature: nextSignature })
      .eq("run_id", row.run_id)
      .eq("question_id", row.question_id);
    if (updateError) {
      console.error(`Curriculum reconciliation: failed to update ${row.run_id}:${row.question_id}:`, updateError);
      continue;
    }
    updated++;
  }
  return updated;
}

export type CurriculumReconciliationResult = {
  mappingsApplied: number;
  questionsUpdated: number;
  unmatchedRemaining: number;
};

let reconciliationInProgress = false;

export function isCurriculumReconciliationInProgress(): boolean {
  return reconciliationInProgress;
}

// A single call over a scope this size (100+ distinct chapter variants
// confirmed live for one real scope) doesn't reliably map every genuine
// case in one shot, the same ordinary model-non-determinism-on-a-large-
// batch behavior cross-run merge's own MAX_ITERATIONS comment documents --
// confirmed directly: a first pass against Grade 12 CBSE Biology mapped
// 26 of 100, but a follow-up investigation of the 74 leftover values found
// most of them ARE real, confidently-mappable Grade 12 chapters just
// described more specifically than the syllabus's own short name
// ("Reproduction in Organisms", "Human Genome Project", "Human Immune
// System" -> real chapters the first pass simply didn't happen to catch).
// Repeating the pass, same as cross-run merge's own outer loop, gives a
// fresh model sample another chance at exactly these -- an admin
// shouldn't have to manually re-click "Reconcile now" to get the same
// effect by hand.
const MAX_ITERATIONS = 5;

async function runCurriculumReconciliationOnePass(params: {
  boardName: string;
  gradeName: string;
  subjectName: string;
}): Promise<CurriculumReconciliationResult> {
  const supabase = getSupabaseClient();
  const { unmatched, acceptableValues } = await computeUnmatched(params);

  if (unmatched.length === 0 || acceptableValues.length === 0) {
    return { mappingsApplied: 0, questionsUpdated: 0, unmatchedRemaining: unmatched.length };
  }

  const provider = getActiveLlmProvider();
  const mappings = await requestMappings(unmatched, acceptableValues, provider);

  let questionsUpdated = 0;
  for (const mapping of mappings) {
    questionsUpdated += await applyMapping(supabase, params, mapping);
  }

  return { mappingsApplied: mappings.length, questionsUpdated, unmatchedRemaining: unmatched.length - mappings.length };
}

export async function runCurriculumReconciliation(params: {
  boardName: string;
  gradeName: string;
  subjectName: string;
}): Promise<CurriculumReconciliationResult> {
  if (reconciliationInProgress) {
    throw new Error("A curriculum reconciliation pass is already in progress -- wait for it to finish before starting another.");
  }
  reconciliationInProgress = true;
  try {
    const total: CurriculumReconciliationResult = { mappingsApplied: 0, questionsUpdated: 0, unmatchedRemaining: 0 };
    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      const pass = await runCurriculumReconciliationOnePass(params);
      total.mappingsApplied += pass.mappingsApplied;
      total.questionsUpdated += pass.questionsUpdated;
      total.unmatchedRemaining = pass.unmatchedRemaining;

      console.log(
        `Curriculum reconciliation: iteration ${iteration}/${MAX_ITERATIONS} for ${params.subjectName} (${params.boardName}, ` +
          `grade ${params.gradeName}) -- ${pass.mappingsApplied} mapping(s) applied, ${pass.questionsUpdated} question(s) updated, ` +
          `${pass.unmatchedRemaining} chapter value(s) still unmatched.`
      );

      // Converged -- nothing new to find, no point spending the rest of
      // the iteration budget re-asking the same unanswerable question.
      if (pass.mappingsApplied === 0) break;
    }

    console.log(
      `Curriculum reconciliation: done -- ${total.mappingsApplied} total mapping(s) applied, ${total.questionsUpdated} total ` +
        `question(s) updated, ${total.unmatchedRemaining} chapter value(s) left unmatched (genuinely no confident syllabus match -- ` +
        "wrong subject/grade content, a chapter since removed from the syllabus, or too ambiguous to place safely)."
    );

    return total;
  } finally {
    reconciliationInProgress = false;
  }
}
