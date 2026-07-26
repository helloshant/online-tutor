"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function approveAnswer(id: string) {
  await requireAdmin();
  const supabase = await createClient();
  await supabase.from("answered_questions").update({ validation_status: "admin_approved" }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

export async function rejectAnswer(id: string) {
  await requireAdmin();
  const supabase = await createClient();
  await supabase.from("answered_questions").update({ validation_status: "rejected" }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

// Undoes an approve/reject decision back to the implicit-validation default,
// so a mistaken click isn't permanent.
export async function restoreAnswer(id: string) {
  await requireAdmin();
  const supabase = await createClient();
  await supabase.from("answered_questions").update({ validation_status: "auto_approved" }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

export async function deleteAnswer(id: string) {
  await requireAdmin();
  const supabase = await createClient();
  await supabase.from("answered_questions").delete().eq("id", id);
  revalidatePath("/admin/answer-bank");
}
