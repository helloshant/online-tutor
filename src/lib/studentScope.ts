import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Medium } from "@/lib/supabase/types";
import type { StaffPreviewScope } from "@/lib/staffPreview";

export type StudentSubjectScope = {
  boardId: string;
  gradeId: string;
  medium: Medium;
};

// IMPORTANT: `medium` on syllabus_topics/answered_questions/
// chapter_document_chunks means "which student-medium COHORT this content
// serves," NOT "what script/language the text happens to be written in."
// Those two readings coincide for every content subject (an English-medium
// student's Math textbook is both English-language text AND for
// English-medium students) and for most language-subject content too --
// but they genuinely diverge wherever a language subject has more than one
// course. Confirmed live, reported directly: CBSE Grade 10 Hindi's
// "Sparsh" textbook is Hindi-LANGUAGE text, but it's Hindi Course A --
// taught to ENGLISH-medium students as their second language, not to
// Hindi-medium students (who'd take Course B, e.g. Kshitij/Kritika,
// covering different content this app has no data for yet). Those 14
// syllabus_topics rows (and the 398 chapter_document_chunks rows chunked
// from them) were tagged medium=Hindi -- reasoning "the text is in
// Hindi" -- and corrected to medium=English once this was reported; a
// Hindi-medium student's own Hindi-subject query now correctly finds
// nothing yet (no Course B content exists) instead of incorrectly seeing
// Course A content meant for English-medium students.
//
// This is exactly why Hindi is NOT in either map below: once its
// content is tagged by the cohort it actually serves, a plain
// `studentMedium` passthrough (same as every ordinary content subject)
// already does the right thing -- an English-medium student's Hindi
// query naturally lands on the Course A rows (medium=English), and
// nothing needs forcing. English (one single course, taken by every
// student regardless of their own medium) and Bengali (one single course
// SO FAR -- re-check this the same way if a second Bengali course is ever
// reported) are each genuinely one-cohort subjects, so their own content
// stays under one fixed medium value no matter which student asks.
const LANGUAGE_SUBJECT_MEDIUM: Record<string, Medium> = {
  ENG: "English",
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
// non-English-medium students -- Bengali-subject rows, with no such
// toggle (so far), only ever exist under their own one language, same as
// syllabus content).
export function resolveContentMedium(subjectCode: string, studentMedium: Medium): Medium {
  return LANGUAGE_SUBJECT_MEDIUM[subjectCode] ?? studentMedium;
}

// Deliberately excludes ENG -- see resolveAnswerBankMedium's own comment.
// Also excludes HN, same as LANGUAGE_SUBJECT_MEDIUM above and for the same
// reason: Hindi content is tagged by the cohort it serves now, so a plain
// studentMedium passthrough is already correct here too.
const RIGID_LANGUAGE_SUBJECT_MEDIUM: Record<string, Medium> = {
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
// Bengali, with no such translation toggle (so far), stays rigid to its
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
