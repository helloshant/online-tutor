import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getSupabaseAnonKey, getSupabaseUrl } from "@/lib/supabase/env";
import { SIGNUP_CAMPAIGN_COOKIE, SIGNUP_SOURCE_COOKIE } from "@/lib/attribution";

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
