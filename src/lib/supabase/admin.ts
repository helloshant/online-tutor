import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import { getSupabaseServiceRoleKey, getSupabaseUrl } from "./env";

// Service-role Supabase client. Bypasses Row Level Security entirely, so it
// must only ever be used inside trusted server code (API routes) after the
// caller's identity and authorization have been independently verified —
// never expose this client or its key to the browser.
export function createAdminClient() {
  return createSupabaseClient<Database>(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
