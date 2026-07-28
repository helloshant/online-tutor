import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Medium } from "@/lib/supabase/types";

export type StudentSubjectScope = {
  boardId: string;
  gradeId: string;
  medium: Medium;
};

// Resolves the board/grade/medium a student's active subscription entitles
// them to for a given subject, or null if they have no active subscription
// or haven't subscribed to that subject -- the same entitlement check
// /api/chat applies before letting a student ask about a subject. Reused by
// the answer-bank tag endpoints since answered_questions has zero
// client-facing RLS policies (see supabase/migrations/0005_answer_bank.sql)
// and must not be queryable for a board/grade/subject a student never paid
// for, even read-only.
export async function resolveStudentSubjectScope(
  supabase: SupabaseClient<Database>,
  userId: string,
  subjectId: string
): Promise<StudentSubjectScope | null> {
  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("id, board_id, grade_id, medium, status")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (!subscription) return null;

  const { data: subjectLink } = await supabase
    .from("subscription_subjects")
    .select("subject_id")
    .eq("subscription_id", subscription.id)
    .eq("subject_id", subjectId)
    .maybeSingle();

  if (!subjectLink) return null;

  return { boardId: subscription.board_id, gradeId: subscription.grade_id, medium: subscription.medium };
}
