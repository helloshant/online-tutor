import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Medium } from "@/lib/supabase/types";
import type { StaffPreviewScope } from "@/lib/staffPreview";

export type StudentSubjectScope = {
  boardId: string;
  gradeId: string;
  medium: Medium;
};

// Keyed on subjects.code, not name (see LANGUAGE_SUBJECT_MEDIUM's own
// comment on why) -- exported so every SERVER-side caller that needs to
// single out the English subject specifically (this file's own
// resolveResponseLanguage below, and until now four separately
// copy-pasted isEnglishSubject checks across /api/chat/route.ts and the
// three /api/topics/[id]/* routes) shares the exact same string instead of
// each redeclaring "ENG" locally -- exactly the kind of duplication that
// let the responseLanguage bug below go unnoticed for Hindi/Bengali (every
// copy got updated for English, none of them for anything else). A couple
// of CLIENT components (chat-panel.tsx, dashboard-shell.tsx) still keep
// their own local "ENG" copy rather than importing this one -- this file
// is server-only (see the top import) and can't be pulled into client
// code, so that duplication is a real constraint, not an oversight.
export const ENGLISH_SUBJECT_CODE = "ENG";

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
// English-to-native-language toggle for comprehension -- see this file's
// own resolveResponseLanguage below for where that toggle's logic
// actually lives. A Bengali-medium student's own banked English-subject answers
// are the TRANSLATED ones, so forcing medium=English here (the way
// resolveContentMedium correctly does for SYLLABUS scoping) would make
// their own search/tag lookups find nothing they've actually banked.
// Bengali, with no such translation toggle (so far), stays rigid to its
// own one language, same as resolveContentMedium.
export function resolveAnswerBankMedium(subjectCode: string, studentMedium: Medium): Medium {
  return RIGID_LANGUAGE_SUBJECT_MEDIUM[subjectCode] ?? studentMedium;
}

// A subject whose own class content is conducted in one fixed language no
// matter which cohort's course a student is actually taking -- a Hindi
// lesson is taught in Hindi whether the student is on Course A/Sparsh
// (English-medium cohort) or Course B/Kshitij (Hindi-medium cohort, not
// yet in this app's catalog), same for Bengali. Deliberately a DIFFERENT
// question from LANGUAGE_SUBJECT_MEDIUM above (which decides which rows
// are even in scope to draw content FROM, i.e. the cohort) -- this decides
// what human language the tutor's own words should be written in, and the
// two can genuinely disagree: resolveContentMedium correctly stopped
// forcing Hindi content to medium=Hindi (see that constant's own comment
// on the Sparsh case), but a Hindi CLASS is still always conducted in
// Hindi regardless of which cohort's rows it drew from. Reported live: an
// English-medium student's Hindi topic summary was coming back entirely in
// English prose, because nothing downstream had ever asked this question
// separately from "what medium is this student's own content in."
// Deliberately excludes ENG -- see resolveResponseLanguage's own
// English-specific branch below for why that one needs a student choice
// instead of an unconditional rule.
const FIXED_RESPONSE_LANGUAGE_SUBJECT: Partial<Record<string, Medium>> = {
  HN: "Hindi",
  BE: "Bengali",
};

// What human language a chat reply / topic summary / exercise should
// actually be WRITTEN in for this subject -- previously reimplemented with
// its own isEnglishSubject + responseLanguage formula in FOUR different
// places (/api/chat/route.ts and the three /api/topics/[id]/* routes),
// exactly the kind of duplication this file's own resolveContentMedium
// comment already warned goes stale. Centralized here so every caller
// shares one rule.
//
// Hindi and Bengali are unconditional (see FIXED_RESPONSE_LANGUAGE_SUBJECT
// above): their own class content is always conducted in that language,
// full stop, regardless of the student's own medium. English is the one
// language subject where that ISN'T always true -- a non-English-medium
// student may deliberately want immersive English replies for practice, or
// may prefer their own native language since English is often genuinely
// hard to follow in a second language -- so it stays the student's own
// choice (preferEnglish, surfaced as ChatPanel's own language-toggle UI),
// defaulting to their native medium as the more accessible starting point.
// Every other subject has no fixed language of its own at all -- taught in
// whatever the student's own medium already is, same as before.
export function resolveResponseLanguage(subjectCode: string, studentMedium: Medium, preferEnglish: boolean): Medium {
  const fixed = FIXED_RESPONSE_LANGUAGE_SUBJECT[subjectCode];
  if (fixed) return fixed;
  if (subjectCode === ENGLISH_SUBJECT_CODE && studentMedium !== "English") {
    return preferEnglish ? "English" : studentMedium;
  }
  return studentMedium;
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
