"use server";

import { revalidatePath } from "next/cache";
import { requireAdminPage } from "@/lib/auth";
import { invalidateCachedAnswer } from "@/lib/orchestratorClient";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Medium } from "@/lib/supabase/types";

// The scope fields needed to evict the matching Redis entry -- the review
// page already has the full row loaded, so these are passed straight
// through rather than looked up again.
export type AnswerBankScope = {
  id: string;
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: Medium;
  question: string;
};

export async function approveAnswer(id: string) {
  await requireAdminPage("answer_bank");
  const supabase = createAdminClient();
  await supabase.from("answered_questions").update({ validation_status: "admin_approved" }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

export async function rejectAnswer(scope: AnswerBankScope) {
  await requireAdminPage("answer_bank");
  const supabase = createAdminClient();
  await supabase.from("answered_questions").update({ validation_status: "rejected" }).eq("id", scope.id);
  // A rejected answer must stop being served immediately, not whenever its
  // Redis TTL happens to expire.
  await invalidateCachedAnswer(scope);
  revalidatePath("/admin/answer-bank");
}

// Undoes an approve/reject decision back to the implicit-validation default,
// so a mistaken click isn't permanent. No cache eviction needed here -- an
// auto_approved row is servable again, and the next matching question just
// repopulates the cache from the database as usual.
export async function restoreAnswer(id: string) {
  await requireAdminPage("answer_bank");
  const supabase = createAdminClient();
  await supabase.from("answered_questions").update({ validation_status: "auto_approved" }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

export async function deleteAnswer(scope: AnswerBankScope) {
  await requireAdminPage("answer_bank");
  const supabase = createAdminClient();
  await supabase.from("answered_questions").delete().eq("id", scope.id);
  await invalidateCachedAnswer(scope);
  revalidatePath("/admin/answer-bank");
}

// Read-then-write rather than a Postgres array_append/remove RPC -- this is
// an admin-only tool with effectively no concurrent-edit risk, so the extra
// round trip is a fine trade for not needing two more RPCs.
export async function addTag(id: string, formData: FormData) {
  await requireAdminPage("answer_bank");
  const tag = ((formData.get("tag") as string | null) ?? "").trim();
  if (!tag) return;

  const supabase = createAdminClient();
  const { data } = await supabase.from("answered_questions").select("tags").eq("id", id).single();
  const tags = Array.from(new Set([...(data?.tags ?? []), tag]));
  await supabase.from("answered_questions").update({ tags }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

export async function removeTag(id: string, tag: string) {
  await requireAdminPage("answer_bank");
  const supabase = createAdminClient();
  const { data } = await supabase.from("answered_questions").select("tags").eq("id", id).single();
  const tags = (data?.tags ?? []).filter((t: string) => t !== tag);
  await supabase.from("answered_questions").update({ tags }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

// Same Q:/A:/--- block format the orchestrator's exercise generation uses
// (services/orchestrator/src/exerciseParser.ts) -- deliberately duplicated
// rather than shared, same as every other type/parser this web app
// mirrors from the orchestrator, since the two are independently deployed
// packages with no shared code path.
const IMPORT_BLOCK_PATTERN = /^Q:\s*([\s\S]*?)\r?\n^A:\s*([\s\S]*)$/im;

function parseImportBlocks(text: string): { question: string; answer: string }[] {
  const blocks = text.split(/\n-{3,}\n/);
  const rows: { question: string; answer: string }[] = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;
    const match = block.match(IMPORT_BLOCK_PATTERN);
    if (!match) continue;
    const question = match[1].trim();
    const answer = match[2].trim();
    if (!question || !answer) continue;
    rows.push({ question, answer });
  }

  return rows;
}

// Bulk-imported content is admin-curated (a real textbook or exam paper),
// not LLM output -- it skips validateAnswerForStorage entirely (that
// heuristic exists to catch a generated answer hedging or reading like a
// question asked back, neither of which applies to hand-sourced content)
// and is stored admin_approved so it's immediately servable, same trust
// level as manually approving a pending_review entry.
export async function bulkImportAnswers(formData: FormData) {
  await requireAdminPage("answer_bank");

  const boardId = formData.get("boardId") as string | null;
  const gradeId = formData.get("gradeId") as string | null;
  const subjectId = formData.get("subjectId") as string | null;
  const medium = formData.get("medium") as Medium | null;
  const topicId = (formData.get("topicId") as string | null) || null;
  const tags = ((formData.get("tags") as string | null) ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const text = (formData.get("bulkText") as string | null) ?? "";

  if (!boardId || !gradeId || !subjectId || !medium || !text.trim()) return;

  const rows = parseImportBlocks(text);
  if (rows.length === 0) return;

  const supabase = createAdminClient();
  await supabase.from("answered_questions").insert(
    rows.map((r) => ({
      board_id: boardId,
      grade_id: gradeId,
      subject_id: subjectId,
      medium,
      topic_id: topicId,
      question: r.question,
      answer: r.answer,
      validation_status: "admin_approved" as const,
      tags,
    }))
  );

  revalidatePath("/admin/answer-bank");
}
