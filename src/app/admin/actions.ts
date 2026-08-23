"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { ADMIN_PAGES, PASSWORD_EXPIRY_DAYS, requireAdminPage, requireSuperAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { amountForSubjects } from "@/lib/pricing";
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

// Lets an admin add/remove subjects on a subscription after the fact --
// e.g. a student calls in wanting to drop or pick up a subject mid-term,
// rather than only ever being able to set the list once at onboarding.
// Only offered for a subscription that's still 'active' or
// 'pending_payment' (the UI itself only renders the edit form for those
// two, but this is re-checked here too, same "don't trust the UI alone"
// posture as every other admin write) -- editing a cancelled/expired
// subscription's subjects has no effect on anything.
export async function updateSubscriptionSubjects(subscriptionId: string, userId: string, formData: FormData) {
  await requireAdminPage("users");
  const supabase = await createClient();

  const requestedSubjectIds = formData.getAll("subjectIds").map(String).filter(Boolean);
  if (requestedSubjectIds.length === 0) {
    // A subscription always needs at least one subject -- same requirement
    // onboarding enforces when a student first picks their subjects. Rather
    // than surface a form error (this page's other admin forms are plain
    // fire-and-forget actions, no useActionState wiring), just no-op: the
    // revalidated page re-renders with the previous, still-valid selection
    // checked.
    return;
  }

  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("board_id, grade_id, status")
    .eq("id", subscriptionId)
    .in("status", ["active", "pending_payment"])
    .maybeSingle();
  if (!subscription) return;

  // Same server-side guard onboarding's confirmSelection uses: don't let a
  // tampered request attach a subject that isn't actually offered for this
  // subscription's board/grade.
  const { data: validOfferings } = await supabase
    .from("board_grade_subjects")
    .select("subject_id")
    .eq("board_id", subscription.board_id)
    .eq("grade_id", subscription.grade_id)
    .in("subject_id", requestedSubjectIds);
  const validSubjectIds = (validOfferings ?? []).map((o) => o.subject_id);
  if (validSubjectIds.length === 0) return;

  await supabase.from("subscription_subjects").delete().eq("subscription_id", subscriptionId);
  await supabase
    .from("subscription_subjects")
    .insert(validSubjectIds.map((subjectId) => ({ subscription_id: subscriptionId, subject_id: subjectId })));

  // Keeps amount_paise in sync with the subject-count price list, same
  // formula onboarding itself uses -- unless a coupon has already been
  // redeemed against this subscription, in which case overwriting it here
  // would silently erase that discount rather than respect it.
  const { data: redeemedCoupon } = await supabase
    .from("coupon_codes")
    .select("id")
    .eq("subscription_id", subscriptionId)
    .not("used_by", "is", null)
    .maybeSingle();
  if (!redeemedCoupon) {
    await supabase
      .from("subscriptions")
      .update({ amount_paise: amountForSubjects(validSubjectIds.length) })
      .eq("id", subscriptionId);
  }

  revalidatePath("/admin");
  revalidatePath(`/admin/users/${userId}`);
}

// Lets an admin/superadmin correct a student's board and grade after the
// fact -- e.g. onboarding was completed with the wrong grade selected, or
// the student moved up a grade mid-year. Same eligibility and "don't trust
// the UI alone" posture as updateSubscriptionSubjects above: only offered
// (and re-checked here) for a subscription that's still 'active' or
// 'pending_payment'.
export async function updateSubscriptionBoardGrade(subscriptionId: string, userId: string, formData: FormData) {
  await requireAdminPage("users");
  const supabase = await createClient();

  const boardId = String(formData.get("boardId") ?? "");
  const gradeId = String(formData.get("gradeId") ?? "");
  if (!boardId || !gradeId) return;

  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("id, status")
    .eq("id", subscriptionId)
    .in("status", ["active", "pending_payment"])
    .maybeSingle();
  if (!subscription) return;

  // A subject valid under the old board/grade isn't guaranteed to still be
  // offered under the new one (e.g. a subject that doesn't exist at the
  // target grade) -- re-validate the subscription's currently-selected
  // subjects against board_grade_subjects for the *new* board/grade, same
  // guard updateSubscriptionSubjects applies when subjects themselves are
  // edited directly.
  const { data: currentSubjectRows } = await supabase
    .from("subscription_subjects")
    .select("subject_id")
    .eq("subscription_id", subscriptionId);
  const currentSubjectIds = (currentSubjectRows ?? []).map((r) => r.subject_id);

  const { data: validOfferings } = await supabase
    .from("board_grade_subjects")
    .select("subject_id")
    .eq("board_id", boardId)
    .eq("grade_id", gradeId)
    .in("subject_id", currentSubjectIds);
  const validSubjectIds = (validOfferings ?? []).map((o) => o.subject_id);

  // Same floor updateSubscriptionSubjects enforces: a subscription can't be
  // left with zero subjects. If none of the currently-selected subjects
  // are offered under the target board/grade, block the whole change --
  // silently no-op, same as that action does for an empty selection --
  // rather than landing the subscription in a board/grade with nothing it
  // can actually be used for. The admin should pick a subject list that
  // has at least some overlap, or edit subjects on the target board/grade
  // in a separate step first.
  if (validSubjectIds.length === 0) return;

  await supabase.from("subscriptions").update({ board_id: boardId, grade_id: gradeId }).eq("id", subscriptionId);

  if (validSubjectIds.length !== currentSubjectIds.length) {
    await supabase.from("subscription_subjects").delete().eq("subscription_id", subscriptionId);
    await supabase
      .from("subscription_subjects")
      .insert(validSubjectIds.map((subjectId) => ({ subscription_id: subscriptionId, subject_id: subjectId })));
  }

  // Same coupon-redeemed guard as updateSubscriptionSubjects: only
  // recompute amount_paise off the (possibly now-smaller) subject count
  // when no coupon has already been redeemed against this subscription.
  const { data: redeemedCoupon } = await supabase
    .from("coupon_codes")
    .select("id")
    .eq("subscription_id", subscriptionId)
    .not("used_by", "is", null)
    .maybeSingle();
  if (!redeemedCoupon) {
    await supabase
      .from("subscriptions")
      .update({ amount_paise: amountForSubjects(validSubjectIds.length) })
      .eq("id", subscriptionId);
  }

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
