"use server";

import { revalidatePath } from "next/cache";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

// Marks a callback request handled -- the actual call happens over the
// phone, outside this app entirely; this just closes the loop so it stops
// showing up in the open queue. Same "close the loop, don't try to model
// the real-world action itself" posture as resolveFeedback in
// /admin/feedback/actions.ts.
export async function markContacted(id: string) {
  const session = await requireAdminPage("callback_requests");
  const supabase = createAdminClient();
  await supabase
    .from("callback_requests")
    .update({ status: "contacted", contacted_by: session.user.id, contacted_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/admin/callback-requests");
}

// Undoes an accidental "mark contacted" -- puts a request back in the new
// queue.
export async function reopenRequest(id: string) {
  await requireAdminPage("callback_requests");
  const supabase = createAdminClient();
  await supabase.from("callback_requests").update({ status: "new", contacted_by: null, contacted_at: null }).eq("id", id);
  revalidatePath("/admin/callback-requests");
}
