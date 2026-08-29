// Read/write access to every archetype_* table (see
// supabase/migrations/0038_archetype_miner.sql). Only this service ever
// writes them -- the admin UI (once built) reads them through the ordinary
// session (RLS + is_admin()), same pattern as chat_events/observability.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null | undefined;

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in services/archetype-miner/.env.local " +
        "(NOT the web app's root .env.local, and NOT the other services' -- this service reads " +
        "its own separate env file). Unlike observability's own fail-open pattern for one best-" +
        "effort event, this service's entire job IS persisting pipeline state -- there is nothing " +
        "useful it can do without a working connection, so this throws immediately rather than " +
        "silently accepting runs it can never actually save."
    );
  }

  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}
