// Looks up mined archetypes for a chapter/topic to ground exercise
// generation in real, proven exam patterns instead of the ungrounded
// "vary difficulty slightly" fallback (see prompts.ts's
// buildExerciseGenerationPrompt). Reads the archetype_* tables directly
// with this service's own Supabase connection -- same "read shared tables
// directly, no extra HTTP hop" pattern the web app's admin catalogue/
// coverage pages already use for this exact data (the archetype-miner
// service itself only exposes submit-run/mine-families, not a read API,
// see its own README section) -- rather than calling that service.
//
// Chapter/topic matching is deliberately soft (trimmed, case-insensitive),
// never exact-only: this service's own syllabus_topics table (curated by
// an admin) and the archetype pipeline's Stage 1 (LLM-derived
// curriculum.chapter/topic during mining, see the coverage page's own
// comment on why this isn't a field on Archetype itself) name chapters
// completely independently, with no cross-reference between the two
// systems today -- there's no guarantee their spellings align exactly
// even when they mean the same chapter. A mismatch (or nothing mined for
// this scope yet, the common case for most chapters right now) just means
// this returns an empty array and generation falls back to the original
// ungrounded prompt -- never an error, never blocks a student's request.
//
// syllabus_topics also turns out to use two different granularity
// conventions in the live catalog (confirmed directly, same finding as
// archetypeCoverage.ts's own comment on this): some subjects give
// `chapter` the real chapter name, but most of the CBSE Grade 11/12
// catalog -- exactly where mining has concentrated -- sets `chapter` to
// the subject name or a book title for every row and puts the real
// chapter name in `topic` instead (e.g. CBSE Grade 12 Mathematics:
// chapter "Mathematics", topic "Relations and Functions"). A question's
// own real curriculum.chapter is always the real chapter name, so it's
// matched against EITHER field below -- requiring it to match `chapter`
// specifically silently missed this whole second convention, exactly
// like it did for the student-facing progress badges before that was
// fixed (see /api/topics/archetype-progress's own comment).
import { getSupabaseClient } from "./supabaseClient.js";
import type { ExerciseArchetype } from "./prompts.js";

const ACCEPTED_STATUSES = ["reviewed", "final"];
const ACCEPTED_DECISIONS = ["KEEP", "REVISE", "ADD"];
// Matches EXERCISE_GENERATION_COUNT in server.ts -- no reason to fetch/
// pass more patterns than the exercise set could ever draw from.
const MAX_ARCHETYPES = 5;

type SignatureRow = { run_id: string; question_id: string; signature: { curriculum?: { chapter?: string; topic?: string } } };

type ArchetypeLookupRow = {
  run_id: string;
  archetype_id: string;
  archetype: {
    name: string;
    invariant_reasoning_structure: string;
    variations: { description: string }[];
    supporting_question_ids: string[];
    stats: { difficulty_distribution: { Easy: number; Medium: number; Hard: number }; years_observed?: number[] };
  };
};

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

export async function findArchetypesForTopic(params: {
  boardName: string;
  gradeName: string;
  subjectName: string;
  chapter: string;
  topic: string;
}): Promise<ExerciseArchetype[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  const { data: archetypeRows, error } = await supabase
    .from("archetypes")
    .select("run_id, archetype_id, archetype")
    .eq("education_context->curriculum_source->>name", params.boardName)
    .eq("education_context->>grade_or_year", params.gradeName)
    .eq("education_context->>subject_or_course", params.subjectName)
    .in("status", ACCEPTED_STATUSES)
    .in("critic_decision", ACCEPTED_DECISIONS);

  if (error) {
    console.error("Archetype lookup for exercise generation failed (falling back to ungrounded generation):", error);
    return [];
  }
  if (!archetypeRows || archetypeRows.length === 0) return [];

  const rows = archetypeRows as unknown as ArchetypeLookupRow[];
  const runIds = Array.from(new Set(rows.map((r) => r.run_id)));

  const { data: signatureRows, error: sigError } = await supabase
    .from("archetype_question_signatures")
    .select("run_id, question_id, signature")
    .in("run_id", runIds);

  if (sigError) {
    console.error("Signature lookup for exercise generation failed (falling back to ungrounded generation):", sigError);
    return [];
  }

  const chapterByQuestion = new Map<string, { chapter: string; topic: string }>();
  for (const s of (signatureRows ?? []) as SignatureRow[]) {
    const curriculum = s.signature?.curriculum;
    if (!curriculum?.chapter || !curriculum?.topic) continue;
    chapterByQuestion.set(`${s.run_id}:${s.question_id}`, { chapter: curriculum.chapter, topic: curriculum.topic });
  }

  const targetChapter = normalize(params.chapter);
  const targetTopic = normalize(params.topic);

  const matches: ExerciseArchetype[] = [];
  for (const row of rows) {
    const resolved = row.archetype.supporting_question_ids
      .map((qid) => chapterByQuestion.get(`${row.run_id}:${qid}`))
      .filter((v): v is { chapter: string; topic: string } => Boolean(v));
    const isMatch = resolved.some((r) => normalize(r.chapter) === targetChapter || normalize(r.chapter) === targetTopic);
    if (!isMatch) continue;

    const dist = row.archetype.stats?.difficulty_distribution;
    // All-zero (no question ever classified) is treated the same as no
    // data at all -- previously this picked "Easy" by insertion-order tie-
    // break even with nothing behind it, which would have made
    // describeDifficultyAsk's "never appeared as X" check below actively
    // wrong about the one level it DID report.
    const total = dist ? dist.Easy + dist.Medium + dist.Hard : 0;
    const difficulty =
      dist && total > 0
        ? ((Object.entries(dist).sort((a, b) => b[1] - a[1])[0]?.[0] as "Easy" | "Medium" | "Hard" | undefined) ?? null)
        : null;

    matches.push({
      runId: row.run_id,
      archetypeId: row.archetype_id,
      name: row.archetype.name,
      invariantReasoningStructure: row.archetype.invariant_reasoning_structure,
      variationDescriptions: (row.archetype.variations ?? []).map((v) => v.description),
      difficulty,
      difficultyDistribution: dist && total > 0 ? dist : null,
      // Sorted, deduped ascending -- Stage 2 builds this from every
      // supporting question's own year, in whatever order clustering
      // happened to process them, with no guaranteed order or uniqueness.
      yearsObserved: Array.from(new Set(row.archetype.stats?.years_observed ?? [])).sort((a, b) => a - b),
    });

    if (matches.length >= MAX_ARCHETYPES) break;
  }

  return matches;
}

// Both the "just shown" event (generation, no result yet) and a graded
// attempt's result go through the SAME record_archetype_progress Postgres
// function (0043_exercise_grading.sql) -- a plain PostgREST upsert can't
// express "+1" for times_seen/times_correct/times_incorrect (every column
// left out of the payload is simply untouched on conflict, never
// incremented), so this needs a real SQL-side increment to be accurate
// across repeat calls. Fails open throughout: a write error here never
// blocks the response already being sent back to the student, only gets
// logged.
async function recordArchetypeProgressRow(params: {
  userId: string;
  runId: string;
  archetypeId: string;
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: string;
  chapter: string;
  topic: string;
  result?: "correct" | "partially_correct" | "incorrect" | null;
}): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  const { error } = await supabase.rpc("record_archetype_progress", {
    p_user_id: params.userId,
    p_run_id: params.runId,
    p_archetype_id: params.archetypeId,
    p_board_id: params.boardId,
    p_grade_id: params.gradeId,
    p_subject_id: params.subjectId,
    p_medium: params.medium,
    p_chapter: params.chapter,
    p_topic: params.topic,
    p_result: params.result ?? null,
  });

  if (error) {
    console.error("Failed to record student_archetype_progress:", error);
  }
}

// Called only after a successful, archetype-grounded generation (the HIT
// path in server.ts) -- records that this student was shown a question
// following each of these patterns, for the "N of M known patterns
// practiced" chapter/topic view (see 0042_student_archetype_progress.sql's
// own comment on exactly what this does and doesn't claim -- "shown," not
// "attempted" or "mastered"; see recordArchetypeAttemptResult below for
// the actual mastery signal).
export async function recordArchetypeProgress(params: {
  userId: string;
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: string;
  chapter: string;
  topic: string;
  archetypes: ExerciseArchetype[];
}): Promise<void> {
  if (params.archetypes.length === 0) return;
  await Promise.all(
    params.archetypes.map((a) =>
      recordArchetypeProgressRow({
        userId: params.userId,
        runId: a.runId,
        archetypeId: a.archetypeId,
        boardId: params.boardId,
        gradeId: params.gradeId,
        subjectId: params.subjectId,
        medium: params.medium,
        chapter: params.chapter,
        topic: params.topic,
      })
    )
  );
}

// Called once per graded attempt (see /v1/topic-exercises/grade in
// server.ts), only when the exercise being graded was archetype-grounded
// AND the LLM judge's own response actually parsed into a real verdict
// (see exerciseGrading.ts) -- an attempt at an ungrounded exercise, or a
// grading response that failed to parse, has nothing valid to credit and
// is skipped rather than guessed at.
export async function recordArchetypeAttemptResult(params: {
  userId: string;
  runId: string;
  archetypeId: string;
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: string;
  chapter: string;
  topic: string;
  result: "correct" | "partially_correct" | "incorrect";
}): Promise<void> {
  await recordArchetypeProgressRow(params);
}
