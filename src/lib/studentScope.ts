import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Medium } from "@/lib/supabase/types";
import type { StaffPreviewScope } from "@/lib/staffPreview";

export type StudentSubjectScope = {
  boardId: string;
  gradeId: string;
  medium: Medium;
};

// A language subject's own content is always written in that language --
// regardless of which medium the REST of a student's subjects are taught
// in. "Hindi" means something genuinely different depending on who's
// taking it (a second language under an English-medium subscription, a
// first language under a Hindi-medium one), but either way its own
// syllabus/exercises/answer-bank content only ever exists in Hindi (see
// this constant's own confirmation against real data: syllabus_topics has
// zero Hindi-subject rows under medium=English, zero English-subject rows
// under medium=Hindi, zero Bengali-subject rows under medium=English/
// Hindi). Every other subject genuinely does follow the student's own
// medium of instruction. Keyed by subjects.code, not name, matching this
// app's own established convention (see ENGLISH_SUBJECT_CODE, previously
// duplicated across /api/chat/route.ts and every /api/topics/[id]/*
// route) -- centralized here instead of staying duplicated, since
// duplication is exactly how this went stale: English got this override,
// Hindi and Bengali silently never did.
const LANGUAGE_SUBJECT_MEDIUM: Record<string, Medium> = {
  ENG: "English",
  HN: "Hindi",
  BE: "Bengali",
};

// The medium a given subject's own CONTENT should be fetched/served in for
// a student whose subscription's overall medium is `studentMedium` --
// distinct from (and not always equal to) that overall medium, per
// LANGUAGE_SUBJECT_MEDIUM's own comment. Exported so callers that don't go
// through resolveStudentSubjectScope (e.g. /api/chat/route.ts, which
// resolves its own subscription/subject-link lookup directly rather than
// through the RLS-scoped client this function uses) still get the exact
// same rule rather than reimplementing their own narrower version of it.
export function resolveContentMedium(subjectCode: string, studentMedium: Medium): Medium {
  return LANGUAGE_SUBJECT_MEDIUM[subjectCode] ?? studentMedium;
}

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
    .select("subject_id, subjects(code)")
    .eq("subscription_id", subscription.id)
    .eq("subject_id", subjectId)
    .maybeSingle();

  if (!subjectLink) return null;

  // See resolveContentMedium's own comment -- a language subject's content
  // stays in that language regardless of the subscription's overall
  // medium (e.g. Hindi as a second language under an English-medium
  // subscription still only has Hindi content to serve).
  const subjectCode = (subjectLink as unknown as { subjects: { code: string } | null }).subjects?.code ?? "";
  return {
    boardId: subscription.board_id,
    gradeId: subscription.grade_id,
    medium: resolveContentMedium(subjectCode, subscription.medium),
  };
}
