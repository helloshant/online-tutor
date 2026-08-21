// Submitting and grading a test attempt -- the other genuinely
// cross-cutting logic in this service, kept here rather than in the web
// app because a client must never be trusted to self-report whether its
// own MCQ answers were correct or what score a short-answer response
// deserves.
import { getSupabaseClient } from "./supabaseClient.js";
import type { GradeAnswerResponse, SubmitTestResponse, SubmittedAnswer } from "./types.js";

// Shared by submitTest (after inserting the fresh answer rows) and
// gradeAnswer (after an admin updates one). Re-derives total/max score and
// the attempt's status from the actual test_answers/test_questions rows
// every time, rather than incrementally patching a running total -- a test
// is at most a few dozen questions, so recomputing from scratch is cheap
// and can never drift out of sync with the underlying rows the way an
// incremental update could after a regrade.
async function recomputeAttemptTotals(
  attemptId: string
): Promise<{ status: "submitted" | "graded"; totalScore: number; maxPossibleScore: number }> {
  const supabase = getSupabaseClient();

  const { data: attemptRow, error: attemptError } = await supabase
    .from("test_attempts")
    .select("broadcast_id")
    .eq("id", attemptId)
    .single();
  if (attemptError) throw new Error(`Failed to load attempt: ${attemptError.message}`);

  const [{ data: answers, error: answersError }, { data: questions, error: questionsError }] = await Promise.all([
    supabase.from("test_answers").select("score").eq("attempt_id", attemptId),
    supabase.from("test_questions").select("max_score").eq("broadcast_id", attemptRow.broadcast_id),
  ]);
  if (answersError) throw new Error(`Failed to load test answers: ${answersError.message}`);
  if (questionsError) throw new Error(`Failed to load test questions: ${questionsError.message}`);

  // A null score means a short-answer response is still awaiting an
  // admin's grade (see submitTest below -- a *blank* short-answer response
  // is auto-scored 0 immediately, not left null, so it never blocks this).
  const hasUngraded = (answers ?? []).some((a) => a.score === null);
  const totalScore = (answers ?? []).reduce((sum, a) => sum + (a.score ?? 0), 0);
  const maxPossibleScore = (questions ?? []).reduce((sum, q) => sum + Number(q.max_score), 0);
  const status: "submitted" | "graded" = hasUngraded ? "submitted" : "graded";

  const { error: updateError } = await supabase
    .from("test_attempts")
    .update({ status, total_score: totalScore, max_possible_score: maxPossibleScore })
    .eq("id", attemptId);
  if (updateError) throw new Error(`Failed to update attempt totals: ${updateError.message}`);

  return { status, totalScore, maxPossibleScore };
}

export async function submitTest(
  broadcastId: string,
  userId: string,
  answers: SubmittedAnswer[]
): Promise<SubmitTestResponse> {
  const supabase = getSupabaseClient();

  // Re-verified here rather than trusted from the caller -- the web app's
  // proxy route already checks the student is a recipient before calling
  // this, but this is the actual trust boundary for what score gets
  // recorded, same reasoning as services/payment re-deriving the charge
  // amount instead of trusting what it's handed.
  const { data: attempt, error: attemptError } = await supabase
    .from("test_attempts")
    .select("id, status")
    .eq("broadcast_id", broadcastId)
    .eq("user_id", userId)
    .maybeSingle();
  if (attemptError) throw new Error(`Failed to look up test attempt: ${attemptError.message}`);
  if (!attempt) {
    throw new Error("No test attempt found -- fetch the test (GET /api/broadcasts/:id/test) before submitting.");
  }
  if (attempt.status !== "in_progress") {
    throw new Error("This test has already been submitted.");
  }

  const { data: questions, error: questionsError } = await supabase
    .from("test_questions")
    .select("id, question_type, correct_option, max_score")
    .eq("broadcast_id", broadcastId);
  if (questionsError) throw new Error(`Failed to load test questions: ${questionsError.message}`);
  if (!questions || questions.length === 0) throw new Error("This test has no questions.");

  const submittedByQuestionId = new Map(answers.map((a) => [a.questionId, a]));

  const answerRows = questions.map((q) => {
    const submitted = submittedByQuestionId.get(q.id);
    if (q.question_type === "mcq") {
      const selected = typeof submitted?.selectedOption === "number" ? submitted.selectedOption : null;
      const isCorrect = selected !== null && selected === q.correct_option;
      return {
        attempt_id: attempt.id,
        question_id: q.id,
        selected_option: selected,
        answer_text: null,
        is_correct: isCorrect,
        score: isCorrect ? Number(q.max_score) : 0,
      };
    }
    // short_answer: a real response is graded manually (score left null,
    // picked up by recomputeAttemptTotals' hasUngraded check above); a
    // blank one is auto-scored 0 immediately -- there's nothing for an
    // admin to evaluate, and leaving it null would mean a skipped question
    // could block the attempt from ever reaching 'graded'.
    const text = submitted?.answerText?.trim() || null;
    return {
      attempt_id: attempt.id,
      question_id: q.id,
      selected_option: null,
      answer_text: text,
      is_correct: text ? null : false,
      score: text ? null : 0,
    };
  });

  const { error: upsertError } = await supabase
    .from("test_answers")
    .upsert(answerRows, { onConflict: "attempt_id,question_id" });
  if (upsertError) throw new Error(`Failed to store test answers: ${upsertError.message}`);

  const { error: submittedError } = await supabase
    .from("test_attempts")
    .update({ submitted_at: new Date().toISOString() })
    .eq("id", attempt.id);
  if (submittedError) throw new Error(`Failed to mark attempt as submitted: ${submittedError.message}`);

  const totals = await recomputeAttemptTotals(attempt.id);
  return { attemptId: attempt.id, ...totals };
}

export async function gradeAnswer(answerId: string, score: number): Promise<GradeAnswerResponse> {
  const supabase = getSupabaseClient();

  const { data: answer, error } = await supabase
    .from("test_answers")
    .select("id, attempt_id, question_id")
    .eq("id", answerId)
    .maybeSingle();
  if (error) throw new Error(`Failed to look up test answer: ${error.message}`);
  if (!answer) throw new Error("Answer not found.");

  const { data: question, error: questionError } = await supabase
    .from("test_questions")
    .select("question_type, max_score")
    .eq("id", answer.question_id)
    .single();
  if (questionError) throw new Error(`Failed to look up question: ${questionError.message}`);
  if (question.question_type !== "short_answer") {
    throw new Error("Only short-answer responses can be graded manually -- MCQ answers are auto-scored.");
  }

  const clampedScore = Math.max(0, Math.min(Number(question.max_score), score));
  const { error: updateError } = await supabase
    .from("test_answers")
    .update({ score: clampedScore, is_correct: clampedScore >= Number(question.max_score) })
    .eq("id", answerId);
  if (updateError) throw new Error(`Failed to save grade: ${updateError.message}`);

  const totals = await recomputeAttemptTotals(answer.attempt_id);
  return { attemptId: answer.attempt_id, attemptStatus: totals.status, totalScore: totals.totalScore, maxPossibleScore: totals.maxPossibleScore };
}
