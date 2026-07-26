"use server";

import { revalidatePath } from "next/cache";
import { ADMIN_PAGES, requireAdminPage, requireSuperAdmin } from "@/lib/auth";
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

  // New admins start with full access to every page (matches what "admin"
  // meant before per-page permissions existed) -- a superadmin can then
  // narrow it via /admin/authorization. Demoting away from admin clears any
  // grants so a later re-promotion starts from a known, empty state rather
  // than silently resurrecting old permissions.
  if (role === "admin") {
    await supabase
      .from("admin_page_permissions")
      .upsert(
        ADMIN_PAGES.map((page) => ({ user_id: userId, page })),
        { onConflict: "user_id,page", ignoreDuplicates: true }
      );
  } else {
    await supabase.from("admin_page_permissions").delete().eq("user_id", userId);
  }

  revalidatePath("/admin");
  revalidatePath("/admin/authorization");
  revalidatePath(`/admin/users/${userId}`);
}

export async function cancelSubscription(subscriptionId: string, userId: string) {
  await requireAdminPage("users");
  const supabase = await createClient();
  await supabase
    .from("subscriptions")
    .update({ status: "cancelled" })
    .eq("id", subscriptionId);
  revalidatePath("/admin");
  revalidatePath(`/admin/users/${userId}`);
}
