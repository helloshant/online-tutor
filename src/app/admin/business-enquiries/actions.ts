"use server";

import { revalidatePath } from "next/cache";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

// Marks a business enquiry handled -- the actual follow-up happens over
// phone/email, outside this app entirely; this just closes the loop so it
// stops showing up in the open queue. Same posture as markContacted in
// /admin/callback-requests/actions.ts.
export async function markContacted(id: string) {
  const session = await requireAdminPage("business_enquiries");
  const supabase = createAdminClient();
  await supabase
    .from("business_enquiries")
    .update({ status: "contacted", contacted_by: session.user.id, contacted_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/admin/business-enquiries");
}

// Undoes an accidental "mark contacted" -- puts an enquiry back in the new
// queue.
export async function reopenEnquiry(id: string) {
  await requireAdminPage("business_enquiries");
  const supabase = createAdminClient();
  await supabase.from("business_enquiries").update({ status: "new", contacted_by: null, contacted_at: null }).eq("id", id);
  revalidatePath("/admin/business-enquiries");
}
