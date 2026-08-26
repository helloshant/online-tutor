import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Medium } from "@/lib/supabase/types";
import type { StaffPreviewScope } from "@/lib/staffPreview";

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
//
// staffPreview, when given, short-circuits straight to that scope instead
// of looking up a subscription -- staff never have one. The caller is
// responsible for actually being staff and for validating the preview
// itself (see resolveStaffPreviewScope in src/lib/staffPreview.ts); this
// function just trusts whatever it's handed here, same as it trusts a real
// subscription row once found.
export async function resolveStudentSubjectScope(
  supabase: SupabaseClient<Database>,
  userId: string,
  subjectId: string,
  staffPreview?: StaffPreviewScope | null
): Promise<StudentSubjectScope | null> {
  if (staffPreview) return staffPreview;

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
