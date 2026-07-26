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

export async function recordAnswer(
  scope: AnswerScope,
  answer: string,
  validationStatus: "auto_approved" | "pending_review"
): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  const { error } = await supabase.from("answered_questions").insert({
    board_id: scope.boardId,
    grade_id: scope.gradeId,
    subject_id: scope.subjectId,
    medium: scope.medium,
    question: scope.question,
    answer,
    validation_status: validationStatus,
  });

  if (error) {
    console.error("Failed to record answer in answer bank:", error);
  }
}
