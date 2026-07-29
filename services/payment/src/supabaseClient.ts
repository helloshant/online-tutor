// Read/write access to subscriptions and coupon_codes. Only this service
// ever activates a subscription or claims a coupon -- the web app has no
// user-facing RLS path to either write (see 0002_rls_policies.sql and
// 0019_ccavenue_and_coupons.sql).
//
// Unlike observability's/orchestrator's equivalent client, this one throws
// instead of returning null when unconfigured: those services fail open
// (an unrecorded analytics event or an uncached answer is a minor
// annoyance), but a payment or coupon-redemption request that silently
// no-ops instead of failing loudly could mean a student pays and never
// gets access, or believes a coupon worked when it didn't. Every route
// handler in server.ts lets this throw propagate into a 500, rather than
// checking for a null client itself.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in services/payment/.env.local (NOT the " +
        "web app's root .env.local, and NOT the other services' -- this service reads its own " +
        "separate env file)"
    );
  }

  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}
