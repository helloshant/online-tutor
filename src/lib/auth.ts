import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { AdminPageKey, Profile } from "@/lib/supabase/types";

// Cached per-request: verifies the session against Supabase Auth (not just
// the optimistic cookie check the proxy does) and loads the user's profile,
// including their role for authorization decisions.
export const getCurrentUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  return { user, profile: profile as Profile | null };
});

export async function requireUser() {
  const session = await getCurrentUser();
  if (!session) redirect("/login");
  return session;
}

// Only native (email/password) accounts have a password to expire --
// password_changed_at is null for an OAuth-only (Google) account, since it
// never set one with this app. See 0011_password_lifecycle.sql.
const PASSWORD_EXPIRY_DAYS = 90;

export function isPasswordExpired(profile: Profile | null): boolean {
  if (!profile?.password_changed_at) return false;
  const ageMs = Date.now() - new Date(profile.password_changed_at).getTime();
  return ageMs > PASSWORD_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
}

// Like requireUser(), but also forces a native-account user with an expired
// password to set a new one before continuing. Callers that are themselves
// reached from /change-password (i.e. the change-password page) must use
// requireUser() directly instead, or this would redirect-loop.
export async function requireFreshPassword() {
  const session = await requireUser();
  if (isPasswordExpired(session.profile)) redirect("/change-password");
  return session;
}

export function isStaff(role: Profile["role"] | undefined): boolean {
  return role === "admin" || role === "superadmin";
}

// Admin panel access: both staff tiers. Role management inside the panel is
// further restricted to superadmin only -- see requireSuperAdmin().
export async function requireAdmin() {
  const session = await requireFreshPassword();
  if (!isStaff(session.profile?.role)) redirect("/dashboard");
  return session;
}

export async function requireSuperAdmin() {
  const session = await requireFreshPassword();
  if (session.profile?.role !== "superadmin") redirect("/admin");
  return session;
}

// Every distinct page/section inside /admin that a superadmin can grant or
// revoke for a plain admin. Keep in sync with the `page` check constraint on
// admin_page_permissions (supabase/migrations/0008_admin_page_permissions.sql).
export const ADMIN_PAGES: AdminPageKey[] = ["users", "catalog", "answer_bank", "observability"];

// Which admin pages the current user can see. Superadmins always get every
// page ("all") -- their access can't be narrowed by this table, only a
// plain admin's can.
export async function getAllowedAdminPages(): Promise<Set<AdminPageKey> | "all"> {
  const session = await requireAdmin();
  if (session.profile?.role === "superadmin") return "all";

  const supabase = await createClient();
  const { data } = await supabase.from("admin_page_permissions").select("page").eq("user_id", session.user.id);
  return new Set((data ?? []).map((row) => row.page));
}

// Gates an individual admin page or action beyond the blanket staff check
// in requireAdmin(). Superadmins always pass; a plain admin needs an
// explicit grant row for `page`, or is redirected to a safe, ungated
// landing page rather than back into another permission check (which could
// otherwise redirect-loop if they lack that page too).
export async function requireAdminPage(page: AdminPageKey) {
  const session = await requireAdmin();
  if (session.profile?.role === "superadmin") return session;

  const supabase = await createClient();
  const { data } = await supabase
    .from("admin_page_permissions")
    .select("page")
    .eq("user_id", session.user.id)
    .eq("page", page)
    .maybeSingle();

  if (!data) redirect("/admin/no-access");
  return session;
}
