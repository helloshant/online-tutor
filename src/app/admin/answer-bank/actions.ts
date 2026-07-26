"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { invalidateCachedAnswer } from "@/lib/orchestratorClient";
import { createClient } from "@/lib/supabase/server";
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
  await requireAdmin();
  const supabase = await createClient();
  await supabase.from("answered_questions").update({ validation_status: "admin_approved" }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

export async function rejectAnswer(scope: AnswerBankScope) {
  await requireAdmin();
  const supabase = await createClient();
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
  await requireAdmin();
  const supabase = await createClient();
  await supabase.from("answered_questions").update({ validation_status: "auto_approved" }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

export async function deleteAnswer(scope: AnswerBankScope) {
  await requireAdmin();
  const supabase = await createClient();
  await supabase.from("answered_questions").delete().eq("id", scope.id);
  await invalidateCachedAnswer(scope);
  revalidatePath("/admin/answer-bank");
}
