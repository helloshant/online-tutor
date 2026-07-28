// Read/write access to the observability tables (chat_events). Only this
// service ever writes chat_events -- the admin UI reads it through the
// ordinary session (RLS + is_admin()), same pattern as the answer bank.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null | undefined;

export function getSupabaseClient(): SupabaseClient | null {
  if (client !== undefined) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in services/observability/.env.local " +
        "(NOT the web app's root .env.local, and NOT services/orchestrator/.env.local -- this " +
        "service reads its own separate env file) -- events will be acknowledged but not recorded."
    );
    client = null;
    return client;
  }

  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}
