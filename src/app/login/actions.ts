"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { establishSingleSession } from "@/lib/singleSession";

export interface LoginState {
  error?: string;
}

function formatLockoutError(lockedUntil: string): string {
  const minutesLeft = Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 60_000));
  return `Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.`;
}

export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/dashboard");

  if (!email || !password) {
    return { error: "Enter both email and password." };
  }

  // Keyed by normalized email (pre-authentication, we don't yet know if the
  // account exists, so there's no user_id to key on). Checked before ever
  // calling Supabase Auth so a locked-out attacker's request never even
  // reaches it.
  const normalizedEmail = email.toLowerCase();
  const admin = createAdminClient();

  const { data: lockout } = await admin
    .from("login_lockouts")
    .select("locked_until")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (lockout?.locked_until && new Date(lockout.locked_until).getTime() > Date.now()) {
    return { error: formatLockoutError(lockout.locked_until) };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const { data: lockedUntil } = await admin.rpc("record_failed_login", { p_email: normalizedEmail });
    if (lockedUntil) {
      return { error: formatLockoutError(lockedUntil) };
    }
    return { error: error.message };
  }

  // Successful login clears any prior failed-attempt history for this
  // email -- a legitimate sign-in shouldn't leave a stale count sitting
  // around to combine with some later unrelated failed attempt.
  await admin.from("login_lockouts").delete().eq("email", normalizedEmail);

  // Makes this login the account's one active device -- see that
  // function's own comment. Awaited before redirect so the very first
  // page this device loads already reflects it.
  await establishSingleSession(supabase, data.user.id);

  redirect(next.startsWith("/") ? next : "/dashboard");
}
