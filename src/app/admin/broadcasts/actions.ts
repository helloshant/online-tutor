"use server";

import { revalidatePath } from "next/cache";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendBroadcast as sendBroadcastRequest, gradeTestAnswer } from "@/lib/broadcastClient";
import type { BroadcastType, Medium, TestQuestionType } from "@/lib/supabase/types";

export interface SaveBroadcastState {
  error?: string;
  success?: boolean;
}

const BROADCAST_TYPES: BroadcastType[] = ["announcement", "promotion", "feedback", "test"];
const MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];

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

  const { error } = await supabase.from("broadcasts").insert({
    type: type as BroadcastType,
    title,
    body,
    board_id: optionalField(formData, "boardId"),
    grade_id: optionalField(formData, "gradeId"),
    subject_id: optionalField(formData, "subjectId"),
    medium: medium as Medium | null,
    status: "draft",
    created_by: session.user.id,
  });
  if (error) return { error: "Could not create the broadcast. Please try again." };

  revalidatePath("/admin/broadcasts");
  return { success: true };
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
    .select("board_id, grade_id, subject_id, medium, status, type")
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
