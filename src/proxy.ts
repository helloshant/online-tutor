import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getSupabaseAnonKey, getSupabaseUrl } from "@/lib/supabase/env";
import { SIGNUP_CAMPAIGN_COOKIE, SIGNUP_SOURCE_COOKIE } from "@/lib/attribution";
import { ACTIVE_SESSION_COOKIE } from "@/lib/singleSession";

const PROTECTED_PREFIXES = ["/dashboard", "/onboarding", "/subscribe", "/admin"];
const AUTH_ROUTES = ["/login", "/signup"];

// 30 days -- long enough to cover someone who clicks a promo link, browses
// around, and doesn't actually sign up until weeks later.
const ATTRIBUTION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

// Optimistic auth: refreshes the Supabase session cookie on every request
// and redirects unauthenticated users away from protected routes. This is a
// fast, cookie-only check — real authorization (role, subscription
// ownership, etc.) is re-verified server-side in each page/route handler.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Single-active-device enforcement (see src/lib/singleSession.ts): every
  // sign-in overwrites profiles.current_session_id and mirrors that same
  // value onto this one browser's own cookie. A mismatch means a LATER
  // sign-in elsewhere has since overwritten the row -- this browser is no
  // longer the account's active device, full stop, regardless of which
  // path it's requesting. Runs on every authenticated request (not just
  // PROTECTED_PREFIXES below) so it also catches /account and
  // /change-password, which aren't gated by the isProtected check further
  // down. Skipped entirely when current_session_id is still null (no
  // sign-in has gone through establishSingleSession yet for this account,
  // e.g. an existing session that predates this feature shipping) -- this
  // is what keeps deploying this feature from retroactively signing
  // everyone out at once.
  if (user) {
    const { data: profile } = await supabase.from("profiles").select("current_session_id").eq("id", user.id).maybeSingle();
    const activeSessionCookie = request.cookies.get(ACTIVE_SESSION_COOKIE)?.value;
    if (profile?.current_session_id && profile.current_session_id !== activeSessionCookie) {
      // Triggers the cookies() setAll callback above, which reassigns
      // `response` (via closure) to carry the cleared Supabase auth
      // cookies. Building the actual redirect as a SEPARATE response
      // object below, rather than converting `response` in place (a
      // NextResponse can't change status after construction), so those
      // just-cleared cookies have to be copied over explicitly or the
      // redirect would silently ship without them.
      await supabase.auth.signOut();
      const redirectUrl = new URL("/login", request.url);
      redirectUrl.searchParams.set("reason", "signed_in_elsewhere");
      const redirectResponse = NextResponse.redirect(redirectUrl);
      for (const cookie of response.cookies.getAll()) {
        redirectResponse.cookies.set(cookie);
      }
      redirectResponse.cookies.delete(ACTIVE_SESSION_COOKIE);
      return redirectResponse;
    }
  }

  const { pathname, searchParams } = request.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  const isAuthRoute = AUTH_ROUTES.some((p) => pathname.startsWith(p));

  // First-touch attribution: remember whichever channel first sent someone
  // here (?utm_source=/?ref=, plus ?utm_campaign=) in a cookie that outlives
  // the click itself, since the landing visit and the eventual signup form
  // submission are almost never the same request -- src/app/signup/
  // actions.ts and src/app/auth/callback/route.ts read these cookies back
  // at account-creation time. First-touch, not last-touch: only set it if
  // it isn't already there, so a later click (e.g. a friend's referral
  // link) doesn't overwrite credit for the channel that originally brought
  // them here.
  const source = searchParams.get("utm_source") ?? searchParams.get("ref");
  if (source && !request.cookies.get(SIGNUP_SOURCE_COOKIE)) {
    response.cookies.set(SIGNUP_SOURCE_COOKIE, source.slice(0, 100), {
      maxAge: ATTRIBUTION_COOKIE_MAX_AGE,
      path: "/",
    });
    const campaign = searchParams.get("utm_campaign");
    if (campaign) {
      response.cookies.set(SIGNUP_CAMPAIGN_COOKIE, campaign.slice(0, 100), {
        maxAge: ATTRIBUTION_COOKIE_MAX_AGE,
        path: "/",
      });
    }
  }

  if (isProtected && !user) {
    const redirectUrl = new URL("/login", request.url);
    redirectUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (isAuthRoute && user) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
