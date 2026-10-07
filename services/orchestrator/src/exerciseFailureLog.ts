// Persists the raw LLM output for a /v1/topic-exercises/generate attempt
// that never parsed into a usable exercise (see exercise_generation_
// failures in supabase/migrations/0057_exercise_generation_failures.sql).
// Fire-and-forget, fail-open -- same posture as observabilityClient.ts's
// recordChatEvent: this is a debugging aid, never something a failed
// write here should turn into a worse error for the student than the
// generation failure they already hit.
import { getSupabaseClient } from "./supabaseClient.js";

export type ExerciseGenerationFailureInput = {
  userId: string;
  boardId: string;
  gradeId: string;
  subjectId: string;
  chapter: string;
  topic: string;
  patternName?: string | null;
  archetypeId?: string | null;
  archetypeRunId?: string | null;
  requestedType?: string | null;
  requestedDifficulty?: string | null;
  provider?: string | null;
  rawOutput: string;
};

export async function recordExerciseGenerationFailure(
  input: ExerciseGenerationFailureInput,
): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const { error } = await supabase.from("exercise_generation_failures").insert({
      user_id: input.userId,
      board_id: input.boardId,
      grade_id: input.gradeId,
      subject_id: input.subjectId,
      chapter: input.chapter,
      topic: input.topic,
      pattern_name: input.patternName ?? null,
      archetype_id: input.archetypeId ?? null,
      archetype_run_id: input.archetypeRunId ?? null,
      requested_type: input.requestedType ?? null,
      requested_difficulty: input.requestedDifficulty ?? null,
      provider: input.provider ?? null,
      // Same 2000-char truncation already used for the console.error this
      // sits alongside -- plenty to see the actual shape of the bad
      // output without storing an unbounded blob per failure.
      raw_output: input.rawOutput.slice(0, 2000),
    });
    if (error) {
      console.error("Failed to record exercise_generation_failures row:", error);
    }
  } catch (err) {
    console.error("Failed to record exercise_generation_failures row:", err);
  }
}
