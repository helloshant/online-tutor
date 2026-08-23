"use server";

import { revalidatePath } from "next/cache";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

// Marks a feedback row as handled -- the actual fix (approving/rejecting a
// topic summary, editing an answer-bank entry, nothing at all if the flag
// turned out to be a false alarm) happens on whichever existing review
// surface this feedback links out to (see the `kind`-specific link on the
// page itself); this action only closes the loop on the feedback item so it
// stops showing up in the open queue.
export async function resolveFeedback(id: string) {
  const session = await requireAdminPage("feedback");
  const supabase = createAdminClient();
  await supabase
    .from("answer_feedback")
    .update({ status: "resolved", resolved_by: session.user.id, resolved_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/admin/feedback");
}

// Undoes an accidental resolve -- puts a row back in the open queue.
export async function reopenFeedback(id: string) {
  await requireAdminPage("feedback");
  const supabase = createAdminClient();
  await supabase.from("answer_feedback").update({ status: "open", resolved_by: null, resolved_at: null }).eq("id", id);
  revalidatePath("/admin/feedback");
}
