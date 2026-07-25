"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireSuperAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ProfileRole } from "@/lib/supabase/types";

// Role changes are superadmin-only -- a plain admin cannot create more
// admins or superadmins. This check is UX; the database enforces the same
// rule unconditionally via the profiles_role_change_guard trigger, so this
// can never be bypassed by calling the action directly.
export async function setUserRole(userId: string, role: ProfileRole) {
  await requireSuperAdmin();
  const supabase = await createClient();
  await supabase.from("profiles").update({ role }).eq("id", userId);
  revalidatePath("/admin");
  revalidatePath(`/admin/users/${userId}`);
}

export async function cancelSubscription(subscriptionId: string, userId: string) {
  await requireAdmin();
  const supabase = await createClient();
  await supabase
    .from("subscriptions")
    .update({ status: "cancelled" })
    .eq("id", subscriptionId);
  revalidatePath("/admin");
  revalidatePath(`/admin/users/${userId}`);
}
