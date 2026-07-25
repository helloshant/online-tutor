import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/supabase/types";

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

export function isStaff(role: Profile["role"] | undefined): boolean {
  return role === "admin" || role === "superadmin";
}

// Admin panel access: both staff tiers. Role management inside the panel is
// further restricted to superadmin only -- see requireSuperAdmin().
export async function requireAdmin() {
  const session = await requireUser();
  if (!isStaff(session.profile?.role)) redirect("/dashboard");
  return session;
}

export async function requireSuperAdmin() {
  const session = await requireUser();
  if (session.profile?.role !== "superadmin") redirect("/admin");
  return session;
}
