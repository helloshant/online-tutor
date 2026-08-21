// Read/write access to broadcasts, broadcast_recipients,
// broadcast_feedback_responses, and the test_* tables. Throws instead of
// returning null when unconfigured, same reasoning as services/payment's
// client: a "send" that silently no-ops instead of reaching anyone, or a
// submitted test that silently fails to score, is a real problem for a
// student/admin relying on it -- not a minor annoyance the way an uncached
// chat answer is for the orchestrator/observability services. Every route
// handler in server.ts lets this throw propagate into a 500 via asyncRoute.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in services/broadcast/.env.local (NOT the " +
        "web app's root .env.local, and NOT the other services' -- this service reads its own " +
        "separate env file)"
    );
  }

  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}
