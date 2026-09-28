import "server-only";

import { randomUUID } from "crypto";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

// Single source of truth for "which browser is this account's one active
// device right now" -- src/proxy.ts compares this same value against
// profiles.current_session_id on every request, and
// single-session-guard.tsx compares it against the live realtime feed of
// that same column for an instant, no-reload sign-out. httpOnly since only
// the server ever needs to read it back (the client guard gets its own
// copy as a render prop instead, not by reading this cookie itself).
export const ACTIVE_SESSION_COOKIE = "active_session_id";

// 30 days, matching this app's own Supabase session cookie lifetime --
// there's no reason for this cookie to expire before the session it's
// paired with does.
const ACTIVE_SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

// Called once, right after every successful sign-in (native password,
// Google OAuth, and a signup that lands the user in an immediate session --
// see login/actions.ts, auth/callback/route.ts, signup/actions.ts) to make
// THIS sign-in the account's one active device: a fresh random id, written
// to profiles.current_session_id with the service-role client (bypasses
// RLS -- "user can update own row" is restricted to role='user' by its own
// WITH CHECK, so a plain per-user client can't self-update a staff/admin
// row; this needs to work uniformly for every role) and mirrored onto this
// one browser's own cookie. Any OTHER browser still holding an older
// cookie value now reads as mismatched everywhere that compares it.
//
// Only callable from a Server Action or Route Handler (cookies().set()
// needs that request context) -- both real call sites already are.
//
// Also revokes every other GoTrue refresh token for this account
// (scope: "others") as a second, independent enforcement layer: even if
// this app's own proxy.ts/realtime checks were ever bypassed or briefly
// unavailable, another device's session still can't outlive its own
// current access token once its refresh token stops working.
export async function establishSingleSession(supabase: SupabaseClient<Database>, userId: string): Promise<void> {
  const sessionId = randomUUID();

  const admin = createAdminClient();
  await admin.from("profiles").update({ current_session_id: sessionId }).eq("id", userId);

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: ACTIVE_SESSION_COOKIE_MAX_AGE,
  });

  // Best-effort -- a failure here just means the native GoTrue-level
  // revocation didn't happen this time; the app-level checks above (the
  // column write + cookie) are the primary enforcement and don't depend
  // on this succeeding.
  await supabase.auth.signOut({ scope: "others" }).catch(() => {});
}
