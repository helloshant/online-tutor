// Read/write access to the Postgres answer bank (L2 of the pipeline). This
// service only ever touches the `answered_questions` table -- it has no
// business with auth, subscriptions, or anything else in the schema, but
// needs the service-role key because that table's RLS has no client-facing
// policies at all (see supabase/migrations/0005_answer_bank.sql).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null | undefined;

export function getSupabaseClient(): SupabaseClient | null {
  if (client !== undefined) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in services/orchestrator/.env.local " +
        "(NOT the web app's root .env.local, which uses NEXT_PUBLIC_SUPABASE_URL instead -- this " +
        "service reads its own separate env file) -- the Postgres answer bank stage of the " +
        "pipeline is disabled, questions will fall through to the LLM after a cache miss."
    );
    client = null;
    return client;
  }

  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}
