// Shared between src/proxy.ts (which sets these) and the two places that
// read them back at account-creation time (src/app/signup/actions.ts,
// src/app/auth/callback/route.ts) -- pulled out of proxy.ts itself so those
// server actions/routes don't need to import next/server or @supabase/ssr
// just to reference two cookie names.
export const SIGNUP_SOURCE_COOKIE = "to_signup_source";
export const SIGNUP_CAMPAIGN_COOKIE = "to_signup_campaign";
