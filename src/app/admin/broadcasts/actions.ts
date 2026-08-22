"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendBroadcast as sendBroadcastRequest, gradeTestAnswer } from "@/lib/broadcastClient";
import type { BroadcastType, Medium, TestQuestionType } from "@/lib/supabase/types";

export interface SaveBroadcastState {
  error?: string;
  success?: boolean;
}

const BROADCAST_TYPES: BroadcastType[] = ["announcement", "promotion", "feedback", "test", "exam"];
const MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];

// Private bucket (0029_exam_broadcast_type.sql) -- unlike
// answer-bank-images, an exam paper and especially a student's answer
// sheet aren't meant to be openly servable to anyone with the URL, so
// every read goes through createSignedUrl(s) server-side after an
// authorization check, never a stored public URL.
const EXAM_BUCKET = "exam-files";
const ALLOWED_EXAM_FILE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
// A multi-page scanned answer sheet as a PDF, or several page photos, can
// run larger than a single answer-bank diagram -- generous enough for a
// real exam script without inviting an accidentally-huge upload.
const MAX_EXAM_FILE_BYTES = 15 * 1024 * 1024;

// Every targeting field is optional -- left blank in the form means "every
// value for that dimension", matching how broadcasts.board_id etc. being
// null is interpreted throughout (see 0028_broadcast_service.sql and
// services/broadcast/src/audience.ts).
function optionalField(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" && value ? value : null;
}

export async function createBroadcast(
  _prevState: SaveBroadcastState,
  formData: FormData
): Promise<SaveBroadcastState> {
  const session = await requireAdminPage("broadcasts");
  const supabase = createAdminClient();

  const type = formData.get("type") as string | null;
  const title = ((formData.get("title") as string | null) ?? "").trim();
  const body = ((formData.get("body") as string | null) ?? "").trim();
  if (!type || !BROADCAST_TYPES.includes(type as BroadcastType)) return { error: "A valid type is required." };
  if (!title) return { error: "Title is required." };
  if (!body) return { error: "Message body is required." };

  const medium = optionalField(formData, "medium");
  if (medium && !MEDIUMS.includes(medium as Medium)) return { error: "Invalid medium." };

  const { data: created, error } = await supabase
    .from("broadcasts")
    .insert({
      type: type as BroadcastType,
      title,
      body,
      board_id: optionalField(formData, "boardId"),
      grade_id: optionalField(formData, "gradeId"),
      subject_id: optionalField(formData, "subjectId"),
      medium: medium as Medium | null,
      status: "draft",
      created_by: session.user.id,
    })
    .select("id")
    .single();
  if (error || !created) return { error: "Could not create the broadcast. Please try again." };

  revalidatePath("/admin/broadcasts");
  // Straight to the new draft's own page rather than back to the list --
  // an exam draft needs its question paper uploaded and a test draft
  // needs its questions added before Send does anything, and leaving the
  // admin on the list page (as this used to) buried that next step behind
  // an easy-to-miss link, which is exactly what prompted this redirect
  // (an admin couldn't find where to attach an exam's question paper at
  // all). redirect() throws, so nothing after this line runs -- the
  // `success` state below is unreachable in practice, kept only as a
  // fallback shape for SaveBroadcastState.
  redirect(`/admin/broadcasts/${created.id}`);
}

// Only a draft can be deleted -- once sent, broadcast_recipients/responses/
// attempts carry real student data (who it reached, what they answered),
// so deleting the parent row (and cascading all of that away) would
// destroy it. An admin who wants a sent broadcast gone can set it to
// 'closed' instead (not yet exposed in the UI, left for a future pass).
export async function deleteBroadcast(id: string) {
  await requireAdminPage("broadcasts");
  const supabase = createAdminClient();
  await supabase.from("broadcasts").delete().eq("id", id).eq("status", "draft");
  revalidatePath("/admin/broadcasts");
}

// Fans the broadcast out to every matching student (services/broadcast
// resolves the actual audience -- see that service's audience.ts) and
// flips status to 'sent'. Guarded here too (not just by the UI only
// showing this button for a draft) so a stale page can't re-send.
export async function sendBroadcastAction(id: string) {
  const session = await requireAdminPage("broadcasts");
  const supabase = createAdminClient();

  const { data: broadcast, error } = await supabase
    .from("broadcasts")
    .select("board_id, grade_id, subject_id, medium, status, type, attachment_paths")
    .eq("id", id)
    .single();
  if (error || !broadcast) return;
  if (broadcast.status !== "draft") return;

  if (broadcast.type === "test") {
    const { count } = await supabase
      .from("test_questions")
      .select("id", { count: "exact", head: true })
      .eq("broadcast_id", id);
    if (!count) return; // nothing to send -- the UI keeps Send disabled for this case too
  }

  if (broadcast.type === "exam") {
    // A student needs both the question paper to know what to answer and
    // at least one question to eventually be marked against -- the UI
    // keeps Send disabled for either gap too.
    if (!broadcast.attachment_paths || broadcast.attachment_paths.length === 0) return;
    const { count } = await supabase
      .from("exam_questions")
      .select("id", { count: "exact", head: true })
      .eq("broadcast_id", id);
    if (!count) return;
  }

  await sendBroadcastRequest(id, {
    boardId: broadcast.board_id,
    gradeId: broadcast.grade_id,
    subjectId: broadcast.subject_id,
    medium: broadcast.medium as Medium | null,
  });

  // Kept for parity with every other admin write in this app, even though
  // requireAdminPage already re-checked -- costs nothing and future-proofs
  // this action if it's ever called from somewhere requireAdminPage alone
  // wouldn't cover.
  void session;

  revalidatePath("/admin/broadcasts");
  revalidatePath(`/admin/broadcasts/${id}`);
}

export interface AddQuestionState {
  error?: string;
  success?: boolean;
}

// Only while the parent broadcast is still a draft -- once sent, students
// may already be mid-attempt, so the question set (and therefore
// max_possible_score) can't safely change underneath them.
export async function addTestQuestion(
  broadcastId: string,
  _prevState: AddQuestionState,
  formData: FormData
): Promise<AddQuestionState> {
  await requireAdminPage("broadcasts");
  const supabase = createAdminClient();

  const { data: broadcast } = await supabase.from("broadcasts").select("status").eq("id", broadcastId).single();
  if (!broadcast || broadcast.status !== "draft") return { error: "This test has already been sent." };

  const questionType = formData.get("questionType") as string | null;
  const question = ((formData.get("question") as string | null) ?? "").trim();
  const maxScoreRaw = Number(formData.get("maxScore"));
  const maxScore = Number.isFinite(maxScoreRaw) && maxScoreRaw > 0 ? maxScoreRaw : 1;

  if (questionType !== "mcq" && questionType !== "short_answer") return { error: "Invalid question type." };
  if (!question) return { error: "Question text is required." };

  let options: string[] | null = null;
  let correctOption: number | null = null;
  if (questionType === "mcq") {
    options = formData
      .getAll("option")
      .map((o) => (typeof o === "string" ? o.trim() : ""))
      .filter(Boolean);
    if (options.length < 2) return { error: "An MCQ question needs at least two options." };
    const correctRaw = Number(formData.get("correctOption"));
    if (!Number.isInteger(correctRaw) || correctRaw < 0 || correctRaw >= options.length) {
      return { error: "Pick which option is correct." };
    }
    correctOption = correctRaw;
  }

  const { count } = await supabase
    .from("test_questions")
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", broadcastId);

  const { error } = await supabase.from("test_questions").insert({
    broadcast_id: broadcastId,
    question_type: questionType as TestQuestionType,
    question,
    options,
    correct_option: correctOption,
    max_score: maxScore,
    sort_order: count ?? 0,
  });
  if (error) return { error: "Could not save the question. Please try again." };

  revalidatePath(`/admin/broadcasts/${broadcastId}`);
  return { success: true };
}

export async function deleteTestQuestion(broadcastId: string, questionId: string) {
  await requireAdminPage("broadcasts");
  const supabase = createAdminClient();

  const { data: broadcast } = await supabase.from("broadcasts").select("status").eq("id", broadcastId).single();
  if (!broadcast || broadcast.status !== "draft") return;

  await supabase.from("test_questions").delete().eq("id", questionId).eq("broadcast_id", broadcastId);
  revalidatePath(`/admin/broadcasts/${broadcastId}`);
}

// Grading itself (re-deriving the attempt's total/status from every answer
// row) lives in services/broadcast -- see that service's grading.ts and
// the reasoning in broadcastClient.ts.
export async function gradeShortAnswer(broadcastId: string, answerId: string, formData: FormData) {
  await requireAdminPage("broadcasts");
  const scoreRaw = Number(formData.get("score"));
  if (!Number.isFinite(scoreRaw) || scoreRaw < 0) return;
  await gradeTestAnswer(answerId, scoreRaw);
  revalidatePath(`/admin/broadcasts/${broadcastId}`);
}

// --- Exam (type='exam') -----------------------------------------------

// Appends every valid file to the broadcast's attachment_paths -- multiple
// calls (or multiple files in one call) accumulate rather than replace,
// same "append" philosophy as answer-bank's addImage, so an admin can add
// pages one at a time if that's easier than selecting them all at once.
// Draft-only: once sent, a student may already be looking at the paper
// they were shown, so it can't change under them.
export async function uploadExamPaper(broadcastId: string, formData: FormData) {
  await requireAdminPage("broadcasts");
  const supabase = createAdminClient();

  const { data: broadcast } = await supabase
    .from("broadcasts")
    .select("status, attachment_paths")
    .eq("id", broadcastId)
    .single();
  if (!broadcast || broadcast.status !== "draft") return;

  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const newPaths: string[] = [];
  for (const file of files) {
    if (file.size > MAX_EXAM_FILE_BYTES || !ALLOWED_EXAM_FILE_TYPES.has(file.type)) continue;
    const path = `${broadcastId}/paper-${crypto.randomUUID()}`;
    const { error } = await supabase.storage.from(EXAM_BUCKET).upload(path, file, { contentType: file.type });
    if (error) {
      console.error("Exam paper upload failed:", error);
      continue;
    }
    newPaths.push(path);
  }
  if (newPaths.length === 0) return;

  await supabase
    .from("broadcasts")
    .update({ attachment_paths: [...(broadcast.attachment_paths ?? []), ...newPaths] })
    .eq("id", broadcastId);
  revalidatePath(`/admin/broadcasts/${broadcastId}`);
}

export async function removeExamPaperFile(broadcastId: string, path: string) {
  await requireAdminPage("broadcasts");
  const supabase = createAdminClient();

  const { data: broadcast } = await supabase
    .from("broadcasts")
    .select("status, attachment_paths")
    .eq("id", broadcastId)
    .single();
  if (!broadcast || broadcast.status !== "draft") return;

  await supabase
    .from("broadcasts")
    .update({ attachment_paths: (broadcast.attachment_paths ?? []).filter((p: string) => p !== path) })
    .eq("id", broadcastId);
  await supabase.storage.from(EXAM_BUCKET).remove([path]);
  revalidatePath(`/admin/broadcasts/${broadcastId}`);
}

export interface AddExamQuestionState {
  error?: string;
  success?: boolean;
}

export async function addExamQuestion(
  broadcastId: string,
  _prevState: AddExamQuestionState,
  formData: FormData
): Promise<AddExamQuestionState> {
  await requireAdminPage("broadcasts");
  const supabase = createAdminClient();

  const { data: broadcast } = await supabase.from("broadcasts").select("status").eq("id", broadcastId).single();
  if (!broadcast || broadcast.status !== "draft") return { error: "This exam has already been sent." };

  const question = ((formData.get("question") as string | null) ?? "").trim();
  const maxScoreRaw = Number(formData.get("maxScore"));
  const maxScore = Number.isFinite(maxScoreRaw) && maxScoreRaw > 0 ? maxScoreRaw : 1;
  if (!question) return { error: "Question text is required." };

  const { count } = await supabase
    .from("exam_questions")
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", broadcastId);

  const { error } = await supabase.from("exam_questions").insert({
    broadcast_id: broadcastId,
    question,
    max_score: maxScore,
    sort_order: count ?? 0,
  });
  if (error) return { error: "Could not save the question. Please try again." };

  revalidatePath(`/admin/broadcasts/${broadcastId}`);
  return { success: true };
}

export async function deleteExamQuestion(broadcastId: string, questionId: string) {
  await requireAdminPage("broadcasts");
  const supabase = createAdminClient();

  const { data: broadcast } = await supabase.from("broadcasts").select("status").eq("id", broadcastId).single();
  if (!broadcast || broadcast.status !== "draft") return;

  await supabase.from("exam_questions").delete().eq("id", questionId).eq("broadcast_id", broadcastId);
  revalidatePath(`/admin/broadcasts/${broadcastId}`);
}

// One form covers every question on a submission at once (fields named
// `score-<questionId>`), rather than one grading form per question the way
// Test's short-answer grading works -- an exam is graded from a single
// uploaded document, so it reads naturally as "mark the whole script in
// one pass", not question-by-question round trips. Re-derives the
// submission's total/status from every exam_question_scores row every
// time (never patched incrementally), same reasoning
// services/broadcast/src/grading.ts's recomputeAttemptTotals uses for
// Test attempts -- a regrade can never drift out of sync with the
// underlying scores. This is plain admin-entered data (not a student
// self-reporting a score), so unlike Test grading there's no "client
// shouldn't be trusted" boundary to route through services/broadcast --
// it's handled here directly, same trust level as every other admin
// write in this file.
export async function gradeExamSubmission(broadcastId: string, submissionId: string, formData: FormData) {
  await requireAdminPage("broadcasts");
  const supabase = createAdminClient();

  const { data: questions } = await supabase
    .from("exam_questions")
    .select("id, max_score")
    .eq("broadcast_id", broadcastId);
  if (!questions || questions.length === 0) return;

  const scoreRows: { submission_id: string; question_id: string; score: number }[] = [];
  for (const q of questions) {
    const raw = formData.get(`score-${q.id}`);
    if (raw === null || raw === "") continue; // left blank -- not graded yet
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    scoreRows.push({
      submission_id: submissionId,
      question_id: q.id,
      score: Math.max(0, Math.min(Number(q.max_score), value)),
    });
  }
  if (scoreRows.length === 0) return;

  const { error } = await supabase
    .from("exam_question_scores")
    .upsert(scoreRows, { onConflict: "submission_id,question_id" });
  if (error) {
    console.error("Failed to save exam question scores:", error);
    return;
  }

  const { data: allScores } = await supabase
    .from("exam_question_scores")
    .select("score")
    .eq("submission_id", submissionId);

  const totalScore = (allScores ?? []).reduce((sum, s) => sum + Number(s.score), 0);
  const maxPossibleScore = questions.reduce((sum, q) => sum + Number(q.max_score), 0);
  const status = (allScores?.length ?? 0) >= questions.length ? "graded" : "submitted";

  await supabase
    .from("exam_submissions")
    .update({ total_score: totalScore, max_possible_score: maxPossibleScore, status })
    .eq("id", submissionId);

  revalidatePath(`/admin/broadcasts/${broadcastId}`);
}
