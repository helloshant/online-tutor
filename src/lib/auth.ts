import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
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

// `next`, when given, is the path to send the visitor back to once they've
// logged back in (plumbed through to /login's own `next` param, which
// login/actions.ts already honours) -- without it, a session that's gone
// stale mid-flow (e.g. the single-active-device restriction kicking an
// older tab, or a long-idle cookie) bounces to a bare /login and, after
// logging in, drops the visitor at the default /dashboard instead of back
// at whatever they were actually trying to reach (e.g. /subscribe to pay).
export async function requireUser(next?: string) {
  const session = await getCurrentUser();
  if (!session) redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  return session;
}

// Only native (email/password) accounts have a password to expire --
// password_changed_at is null for an OAuth-only (Google) account, since it
// never set one with this app. See 0011_password_lifecycle.sql.
export const PASSWORD_EXPIRY_DAYS = 90;

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

// "Preview as this admin" -- lets a superadmin see /admin exactly as a
// given plain admin would (which pages they can reach, which grades their
// data is scoped to), since otherwise the only way to check a specific
// admin's restricted view was to read admin_page_permissions/
// admin_grade_permissions rows directly. Same cookie-based convention as
// the single-active-device cookie (src/lib/singleSession.ts's
// ACTIVE_SESSION_COOKIE) -- httpOnly since only the server ever needs it.
export const ADMIN_PREVIEW_COOKIE = "admin_preview_as";
const ADMIN_PREVIEW_COOKIE_MAX_AGE = 60 * 60 * 4; // 4h safety expiry

// Resolves the admin a superadmin is currently previewing as, or null if
// not previewing -- including when the caller isn't a superadmin, no
// cookie is set, or the cookie's target no longer exists or isn't a plain
// admin any more (demoted/promoted/deleted since the cookie was set):
// treated as "not previewing" rather than left in a broken half-state.
// cache()'d per request, same as getCurrentUser, since every preview-aware
// helper below calls this at least once per request-render-pass.
export const getAdminPreviewTarget = cache(
  async (): Promise<{ id: string; fullName: string | null } | null> => {
    const session = await getCurrentUser();
    if (!session || session.profile?.role !== "superadmin") return null;

    const cookieStore = await cookies();
    const targetId = cookieStore.get(ADMIN_PREVIEW_COOKIE)?.value;
    if (!targetId) return null;

    const supabase = await createClient();
    const { data: target } = await supabase
      .from("profiles")
      .select("id, full_name, role")
      .eq("id", targetId)
      .maybeSingle();
    if (!target || target.role !== "admin") return null;

    return { id: target.id, fullName: target.full_name };
  },
);

export async function setAdminPreviewCookie(targetUserId: string) {
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_PREVIEW_COOKIE, targetUserId, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_PREVIEW_COOKIE_MAX_AGE,
  });
}

export async function clearAdminPreviewCookie() {
  (await cookies()).delete(ADMIN_PREVIEW_COOKIE);
}

// Every distinct page/section inside /admin that a superadmin can grant or
// revoke for a plain admin. Keep in sync with the `page` check constraint on
// admin_page_permissions (supabase/migrations/0008_admin_page_permissions.sql).
export const ADMIN_PAGES: AdminPageKey[] = [
  "users",
  "catalog",
  "answer_bank",
  "observability",
  "coupons",
  "chapter_notes",
  "topic_summaries",
  "broadcasts",
  "feedback",
  "archetype_miner",
  "callback_requests",
  "business_enquiries",
];

// Which admin pages the current user can see. Superadmins always get every
// page ("all") -- their access can't be narrowed by this table, only a
// plain admin's can. Preview-aware: a superadmin previewing as a plain
// admin (see getAdminPreviewTarget) sees exactly that admin's own grants
// instead of "all", so they can check what a specific admin can reach.
export async function getAllowedAdminPages(): Promise<Set<AdminPageKey> | "all"> {
  const session = await requireAdmin();
  const previewTarget = await getAdminPreviewTarget();
  if (!previewTarget && session.profile?.role === "superadmin") return "all";

  const supabase = await createClient();
  const { data } = await supabase
    .from("admin_page_permissions")
    .select("page")
    .eq("user_id", previewTarget?.id ?? session.user.id);
  return new Set((data ?? []).map((row) => row.page));
}

// Gates an individual admin page or action beyond the blanket staff check
// in requireAdmin(). Superadmins always pass; a plain admin needs an
// explicit grant row for `page`, or is redirected to a safe, ungated
// landing page rather than back into another permission check (which could
// otherwise redirect-loop if they lack that page too). Preview-aware, same
// as getAllowedAdminPages above -- a superadmin previewing as a plain admin
// who lacks `page` gets redirected here too, exactly like that admin would.
export async function requireAdminPage(page: AdminPageKey) {
  const session = await requireAdmin();
  const previewTarget = await getAdminPreviewTarget();
  if (!previewTarget && session.profile?.role === "superadmin") return session;

  const supabase = await createClient();
  const { data } = await supabase
    .from("admin_page_permissions")
    .select("page")
    .eq("user_id", previewTarget?.id ?? session.user.id)
    .eq("page", page)
    .maybeSingle();

  if (!data) redirect("/admin/no-access");
  return session;
}

// Which grades the current user's admin access is scoped to. Superadmins
// are always unrestricted. For a plain admin, zero rows means unrestricted
// too (opt-in scoping -- see 0071_admin_grade_permissions.sql) rather than
// "locked out," the opposite default from getAllowedAdminPages()/
// admin_page_permissions deliberately, since narrowing access here is
// something a superadmin does on top of an otherwise-unrestricted admin,
// not a grant they start from zero. Preview-aware, same as
// getAllowedAdminPages/requireAdminPage above.
export async function getAllowedAdminGrades(): Promise<Set<string> | "all"> {
  const session = await requireAdmin();
  const previewTarget = await getAdminPreviewTarget();
  if (!previewTarget && session.profile?.role === "superadmin") return "all";

  const supabase = await createClient();
  const { data } = await supabase
    .from("admin_grade_permissions")
    .select("grade_id")
    .eq("user_id", previewTarget?.id ?? session.user.id);
  if (!data || data.length === 0) return "all";
  return new Set(data.map((row) => row.grade_id));
}

// Plain predicate (no redirect) for checking one specific row's grade_id
// against a scope already resolved via getAllowedAdminGrades() -- used
// inside pages/actions that are already gated by requireAdminPage(), to
// filter a list or re-validate a client-bound id before a mutation. A
// null/missing gradeId is never implicitly allowed once scoped, since
// there's nothing to check it against.
export function isGradeAllowed(scope: Set<string> | "all", gradeId: string | null | undefined): boolean {
  if (scope === "all") return true;
  return Boolean(gradeId) && scope.has(gradeId as string);
}
