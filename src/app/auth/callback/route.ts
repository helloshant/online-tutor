import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { SIGNUP_CAMPAIGN_COOKIE, SIGNUP_SOURCE_COOKIE } from "@/lib/attribution";

// Signups created in the last minute are treated as "just happened" -- a
// generous margin for the exchange itself, not an attempt to catch anyone
// logging back in later.
const JUST_SIGNED_UP_WINDOW_MS = 60_000;

// Shared landing spot for every Supabase Auth flow that redirects back with
// a `code` to exchange for a session: Google OAuth (?next=/dashboard) and
// password-recovery links (?next=/reset-password) both go through here.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";
  const safeNext = next.startsWith("/") ? next : "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.user) {
      // Google sign-in has no equivalent of signUp()'s options.data (see
      // src/app/signup/actions.ts for the native-password path), so this is
      // the earliest point the app can attach attribution to a new Google
      // account -- patched onto the profile row after the fact instead.
      // Gated to accounts created moments ago so a returning user who later
      // clicks a promo link and logs back in through this same route
      // doesn't get their original signup misattributed to that later
      // click; the `is("signup_source", null)` guard on the write is a
      // second line of defense against the same thing.
      const justSignedUp = Date.now() - new Date(data.user.created_at).getTime() < JUST_SIGNED_UP_WINDOW_MS;
      if (justSignedUp) {
        const cookieStore = await cookies();
        const signupSource = cookieStore.get(SIGNUP_SOURCE_COOKIE)?.value;
        if (signupSource) {
          await supabase
            .from("profiles")
            .update({
              signup_source: signupSource,
              signup_campaign: cookieStore.get(SIGNUP_CAMPAIGN_COOKIE)?.value ?? null,
            })
            .eq("id", data.user.id)
            .is("signup_source", null);
        }
      }
      return NextResponse.redirect(`${origin}${safeNext}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
}
