import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Medium } from "@/lib/supabase/types";
import type { StaffPreviewScope } from "@/lib/staffPreview";

export type StudentSubjectScope = {
  boardId: string;
  gradeId: string;
  medium: Medium;
};

// A language subject's own SYLLABUS content -- which chapters/topics
// exist to ask about at all -- is always written in that language,
// regardless of which medium the REST of a student's subjects are taught
// in. "Hindi" means something genuinely different depending on who's
// taking it (a second language under an English-medium subscription, a
// first language under a Hindi-medium one), but either way its own
// syllabus_topics rows only ever exist under medium=Hindi (confirmed
// directly: zero Hindi-subject rows under medium=English, zero
// English-subject rows under medium=Hindi, zero Bengali-subject rows
// under medium=English/Hindi). Every other subject genuinely does follow
// the student's own medium of instruction. Keyed by subjects.code, not
// name, matching this app's own established convention (see
// ENGLISH_SUBJECT_CODE, previously duplicated across /api/chat/route.ts
// and every /api/topics/[id]/* route).
const LANGUAGE_SUBJECT_MEDIUM: Record<string, Medium> = {
  ENG: "English",
  HN: "Hindi",
  BE: "Bengali",
};

// The medium a given subject's own SYLLABUS content is scoped under --
// which syllabus_topics rows are even in scope to ask about, per
// LANGUAGE_SUBJECT_MEDIUM's own comment. Exported so callers that don't go
// through resolveStudentSubjectScope (e.g. /api/chat/route.ts, which
// resolves its own subscription/subject-link lookup directly rather than
// through the RLS-scoped client this function uses) still get the exact
// same rule rather than reimplementing their own narrower version of it.
//
// NOT the right function for "what medium was this student's BANKED
// answer recorded in" -- see resolveAnswerBankMedium's own comment on why
// that's a genuinely different question for the English subject
// specifically (confirmed directly: real English-subject answered_questions
// rows exist under BOTH medium=English and medium=Bengali, the latter from
// this app's own English-to-native-language translation toggle for
// non-English-medium students -- Hindi/Bengali-subject rows, with no such
// toggle, only ever exist under their own one language, same as syllabus
// content).
export function resolveContentMedium(subjectCode: string, studentMedium: Medium): Medium {
  return LANGUAGE_SUBJECT_MEDIUM[subjectCode] ?? studentMedium;
}

// Deliberately excludes ENG -- see resolveAnswerBankMedium's own comment.
const RIGID_LANGUAGE_SUBJECT_MEDIUM: Record<string, Medium> = {
  HN: "Hindi",
  BE: "Bengali",
};

// The medium to search a student's own BANKED answers under for a given
// subject -- genuinely different from resolveContentMedium for the
// English subject specifically. Confirmed directly against real data:
// answered_questions has English-subject rows under BOTH medium=English
// (a straight answer) and medium=Bengali (the SAME kind of content, but
// translated for a Bengali-medium student who used this app's own
// English-to-native-language toggle for comprehension -- see
// isEnglishSubject/responseLanguage in /api/chat/route.ts and the
// matching /api/topics/[id]/* routes for where that toggle actually
// lives). A Bengali-medium student's own banked English-subject answers
// are the TRANSLATED ones, so forcing medium=English here (the way
// resolveContentMedium correctly does for SYLLABUS scoping) would make
// their own search/tag lookups find nothing they've actually banked.
// Hindi and Bengali, with no such translation toggle, stay rigid to their
// own one language, same as resolveContentMedium.
export function resolveAnswerBankMedium(subjectCode: string, studentMedium: Medium): Medium {
  return RIGID_LANGUAGE_SUBJECT_MEDIUM[subjectCode] ?? studentMedium;
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

  // Both callers of this function (the answer-bank search/tag endpoints)
  // use the returned medium to filter answered_questions -- a BANKED
  // answer lookup, not a syllabus-scoping one, so this goes through
  // resolveAnswerBankMedium (see its own comment on why that's not the
  // same function as resolveContentMedium for the English subject).
  const subjectCode = (subjectLink as unknown as { subjects: { code: string } | null }).subjects?.code ?? "";
  return {
    boardId: subscription.board_id,
    gradeId: subscription.grade_id,
    medium: resolveAnswerBankMedium(subjectCode, subscription.medium),
  };
}
