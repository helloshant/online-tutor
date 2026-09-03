// Stage 3 of the answer pipeline: the durable Postgres full-text knowledge
// base (see supabase/migrations/0005_answer_bank.sql). Like cache.ts, every
// function here fails open -- a missing Supabase connection or a query error
// just means this stage is skipped, not that the request fails.
import { getSupabaseClient } from "./supabaseClient.js";
import type { AnswerScope } from "./types.js";

// Below this ts_rank score, a "match" is too weak to trust -- serving it
// risks answering a different question than the one asked, which is a worse
// failure mode than falling through to the LLM.
const MIN_RANK = 0.1;

export async function findAnswerInBank(
  scope: AnswerScope
): Promise<{ id: string; answer: string } | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .rpc("search_answer_bank", {
      p_board_id: scope.boardId,
      p_grade_id: scope.gradeId,
      p_subject_id: scope.subjectId,
      p_medium: scope.medium,
      p_query: scope.question,
      p_min_rank: MIN_RANK,
    })
    .maybeSingle<{ id: string; answer: string; rank: number }>();

  if (error) {
    console.error("Postgres answer bank search failed:", error);
    return null;
  }
  if (!data) return null;

  // Best-effort hit-count bump -- never block the response on it.
  supabase
    .rpc("bump_answer_bank_hit", { p_id: data.id })
    .then(({ error: bumpError }) => {
      if (bumpError) console.error("Failed to bump answer bank hit count:", bumpError);
    });

  return { id: data.id, answer: data.answer };
}

// "Relevant exercises" search, used by the topic-exercises endpoint --
// distinct from findAnswerInBank above: that wants the single best
// full-text match for one specific question (the chat pipeline), this
// wants every exercise already banked for one exact syllabus topic (an
// exact topic_id match, not a text-similarity guess -- see
// 0015_answer_bank_topic_id.sql for why this isn't FTS-ranked like the
// other lookups here) and needs the question text back too, since the
// student is shown a list of exercises rather than a single reply.
const EXERCISE_SEARCH_LIMIT = 5;

// snake_case -- this is the raw shape search_topic_exercises' own
// RETURNS TABLE produces (see 0043_exercise_grading.sql), not
// PostgREST-style camelCased; server.ts maps it onto ExerciseItem's own
// camelCase fields when building the response.
export type BankedExercise = {
  id: string;
  question: string;
  answer: string;
  archetype_run_id: string | null;
  archetype_id: string | null;
};

export async function findRelevantExercises(
  scope: Omit<AnswerScope, "question" | "topicId">,
  topicId: string
): Promise<BankedExercise[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  // archetype_run_id/archetype_id (0043_exercise_grading.sql) carry
  // through even for an exercise reused from the bank, not just a freshly
  // generated one -- archetype attribution is a property of the exercise
  // CONTENT itself, so a later student attempting an already-banked
  // exercise still needs it credited to the right pattern on grading.
  const { data, error } = await supabase.rpc("search_topic_exercises", {
    p_board_id: scope.boardId,
    p_grade_id: scope.gradeId,
    p_subject_id: scope.subjectId,
    p_medium: scope.medium,
    p_topic_id: topicId,
    p_limit: EXERCISE_SEARCH_LIMIT,
  });

  if (error) {
    console.error("Postgres exercise search failed:", error);
    return [];
  }

  return (data ?? []) as BankedExercise[];
}

// Returns the new row's own id (null on failure), rather than a plain
// boolean -- a caller building a gradeable ExerciseItem (see server.ts's
// topic-exercises handler) needs a stable id to hand back to the student
// for later grading, not just a yes/no. Callers that only cared about
// success/failure before this changed still work unmodified: `!saved` is
// still the right failure check whether `saved` is `false` (before) or
// `null` (now) -- silently discarding success/failure here is exactly what
// made past storage failures invisible until someone noticed the answer
// bank staying empty, so callers should still log when this comes back
// null/falsy.
export async function recordAnswer(
  scope: AnswerScope,
  answer: string,
  validationStatus: "auto_approved" | "pending_review",
  // The student whose question triggered this write -- an audit trail
  // distinct from `scope.question` itself, which (for a chat-originated
  // entry) is already a restated version rather than the student's raw
  // wording -- see questionRewrite.ts and 0033_answer_bank_created_by.sql.
  // Callers that can't resolve one (there are none today) should pass null
  // rather than guessing.
  createdBy: string | null,
  // Set only when this specific exercise was generated from a mined
  // archetype (see archetypeExercises.ts) -- stored on the row itself
  // (0043_exercise_grading.sql) so a LATER student reusing this exercise
  // from the bank (see findRelevantExercises above) still gets it credited
  // to the right pattern when they grade their own attempt at it.
  archetypeAttribution?: { runId: string; archetypeId: string } | null
): Promise<string | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("answered_questions")
    .insert({
      board_id: scope.boardId,
      grade_id: scope.gradeId,
      subject_id: scope.subjectId,
      medium: scope.medium,
      question: scope.question,
      answer,
      validation_status: validationStatus,
      archetype_run_id: archetypeAttribution?.runId ?? null,
      archetype_id: archetypeAttribution?.archetypeId ?? null,
      topic_id: scope.topicId ?? null,
      created_by: createdBy,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("Failed to record answer in answer bank:", error);
    return null;
  }
  return data.id as string;
}

// Resolves everything /v1/topic-exercises/grade (server.ts) needs about
// one exercise, by its own stored row id -- deliberately re-derived from
// the row itself rather than trusted from the grading request, same
// reasoning as every other trust boundary in this app (services/payment
// re-deriving a charge amount instead of trusting the caller): a student
// grading their own attempt must never be able to supply their own
// "expected answer" to fake correctness. chapter/topic come from a join
// against syllabus_topics via the row's own topic_id (answered_questions
// itself only stores the FK, not the text) -- null when the row has no
// topic_id (a chat-originated answer-bank entry, not a topic exercise;
// grading such a row is rejected by the caller before this matters).
export type ExerciseForGrading = {
  question: string;
  answer: string;
  boardId: string;
  gradeId: string;
  subjectId: string;
  subjectName: string;
  medium: string;
  archetypeRunId: string | null;
  archetypeId: string | null;
  chapter: string | null;
  topic: string | null;
};

export async function getExerciseForGrading(exerciseId: string): Promise<ExerciseForGrading | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data: row, error } = await supabase
    .from("answered_questions")
    .select("question, answer, board_id, grade_id, subject_id, medium, archetype_run_id, archetype_id, topic_id")
    .eq("id", exerciseId)
    .maybeSingle();

  if (error) {
    console.error("Failed to look up exercise for grading:", error);
    return null;
  }
  if (!row) return null;

  const [{ data: subjectRow }, { data: topicRow }] = await Promise.all([
    supabase.from("subjects").select("name").eq("id", row.subject_id).maybeSingle(),
    row.topic_id
      ? supabase.from("syllabus_topics").select("chapter, topic").eq("id", row.topic_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return {
    question: row.question,
    answer: row.answer,
    boardId: row.board_id,
    gradeId: row.grade_id,
    subjectId: row.subject_id,
    subjectName: subjectRow?.name ?? "this subject",
    medium: row.medium,
    archetypeRunId: row.archetype_run_id,
    archetypeId: row.archetype_id,
    chapter: topicRow?.chapter ?? null,
    topic: topicRow?.topic ?? null,
  };
}
