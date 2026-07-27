"use server";

import { revalidatePath } from "next/cache";
import { ADMIN_PAGES, requireAdminPage, requireSuperAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ProfileRole } from "@/lib/supabase/types";

const VALID_ROLES: ProfileRole[] = ["user", "admin", "superadmin"];

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

export async function createUser(formData: FormData) {
  const session = await requireAdminPage("users");
  const fullName = String(formData.get("fullName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const role = String(formData.get("role") ?? "user") as ProfileRole;
  if (!email || password.length < 8 || !VALID_ROLES.includes(role)) return;

  // Creating a staff account straight into "admin"/"superadmin" is
  // superadmin-only, mirroring setUserRole's restriction below -- otherwise
  // a plain admin could hand out elevated access through this form instead.
  if (role !== "user" && session.profile?.role !== "superadmin") return;

  const admin = createAdminClient();
  // Admin-created accounts are email-confirmed immediately: the admin
  // already vouches for the address, and this app has no transactional
  // email configured to send a confirmation link.
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: fullName ? { full_name: fullName } : undefined,
  });
  if (error || !data.user) return;

  if (role !== "user") {
    await setUserRole(data.user.id, role);
  }

  revalidatePath("/admin");
}

export async function updateUserProfile(userId: string, formData: FormData) {
  await requireAdminPage("users");
  const fullName = String(formData.get("fullName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) return;

  const supabase = await createClient();
  await supabase.from("profiles").update({ full_name: fullName || null }).eq("id", userId);

  // Email lives on auth.users, not profiles -- only the service-role client
  // can change it.
  const admin = createAdminClient();
  await admin.auth.admin.updateUserById(userId, { email });

  revalidatePath("/admin");
  revalidatePath(`/admin/users/${userId}`);
}

export async function deleteUser(userId: string) {
  const session = await requireAdminPage("users");
  // No self-delete from the admin panel -- the only way this account could
  // recover from that is another superadmin doing it for them.
  if (userId === session.user.id) return;

  const supabase = await createClient();
  const { data: targetProfile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();

  // Removing a staff account is superadmin-only, same restriction as
  // setUserRole and createUser above.
  if (targetProfile && targetProfile.role !== "user" && session.profile?.role !== "superadmin") return;

  // Cascades to profiles, subscriptions, subscription_subjects,
  // chat_messages, and admin_page_permissions -- all reference auth.users
  // with "on delete cascade" (see 0001_init_schema.sql, 0008_admin_page_permissions.sql).
  const admin = createAdminClient();
  await admin.auth.admin.deleteUser(userId);

  revalidatePath("/admin");
}
