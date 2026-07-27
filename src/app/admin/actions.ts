"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { ADMIN_PAGES, PASSWORD_EXPIRY_DAYS, requireAdminPage, requireSuperAdmin } from "@/lib/auth";
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

// Admin-side counterpart to /api/razorpay/verify's activation -- same two
// fields (status, activated_at), just skipping the Razorpay signature check
// entirely rather than mimicking it. razorpay_payment_id is deliberately
// left null (not backfilled with a fake value), so a subscription active
// through this path stays distinguishable in the data from one that was
// actually paid for. Scoped to a currently-pending subscription, same as
// the real activation route, so this can't accidentally reactivate a
// cancelled one.
export async function activateSubscriptionWithoutPayment(subscriptionId: string, userId: string) {
  await requireAdminPage("users");
  const supabase = await createClient();
  await supabase
    .from("subscriptions")
    .update({ status: "active", activated_at: new Date().toISOString() })
    .eq("id", subscriptionId)
    .eq("status", "pending_payment");
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

// Lets an admin send a password reset link on a user's behalf (e.g. they're
// locked out and can't reach /forgot-password themselves). Same
// resetPasswordForEmail call the self-service form uses -- no special
// privilege needed for that part, just the target's email, which the
// service-role client can always look up regardless of what an admin's own
// session can see.
export async function sendPasswordResetEmail(userId: string) {
  await requireAdminPage("users");

  const admin = createAdminClient();
  const { data } = await admin.auth.admin.getUserById(userId);
  const email = data?.user?.email;
  if (!email) return;

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const protocol = h.get("x-forwarded-proto") ?? "http";
  const origin = `${protocol}://${host}`;

  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=/reset-password`,
  });
}

export interface SetUserPasswordState {
  error?: string;
  success?: boolean;
}

// Lets an admin directly set (or replace) a user's password, rather than
// only being able to email them a reset link -- e.g. the account has no
// working inbox, or the admin needs the change to take effect immediately.
// Works even for an account that signed up via Google: Supabase allows
// attaching a password to any account regardless of how it originally
// authenticated, which is exactly the escape hatch this form exists for.
// password_changed_at is stamped automatically by the auth.users update
// trigger (0011_password_lifecycle.sql) -- no app-side write needed here.
// Takes userId first so the page can bind it and hand the rest to
// useActionState (prevState, formData), which is what lets the form flash a
// success/error message instead of this being fire-and-forget like the
// other actions on this page.
export async function setUserPassword(
  userId: string,
  _prevState: SetUserPasswordState,
  formData: FormData
): Promise<SetUserPasswordState> {
  await requireAdminPage("users");
  const password = String(formData.get("password") ?? "");
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) {
    return { error: error.message };
  }

  revalidatePath(`/admin/users/${userId}`);
  return { success: true };
}

// Toggles whether a native account's password is currently treated as
// expired -- checking the box back-dates password_changed_at past
// PASSWORD_EXPIRY_DAYS (forcing a reset on next login, e.g. after a
// suspected compromise); unchecking it sets password_changed_at to now
// (the same effect a fresh password change would have). Only meaningful
// once a password actually exists -- the page only renders this control
// once setUserPassword (or a prior native signup) has set one.
export async function setAccountExpired(userId: string, formData: FormData) {
  await requireAdminPage("users");
  const expired = formData.get("expired") === "on";

  const newTimestamp = expired
    ? new Date(Date.now() - (PASSWORD_EXPIRY_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString()
    : new Date().toISOString();

  const supabase = await createClient();
  await supabase.from("profiles").update({ password_changed_at: newTimestamp }).eq("id", userId);

  revalidatePath(`/admin/users/${userId}`);
}
