// Fire-and-forget reporting to the observability service after each
// /v1/chat outcome (rejected/cache/database/llm). Never blocks or affects
// the student's reply -- failures are logged and swallowed, the same
// fail-open philosophy as cache.ts and answerBank.ts.
import type { ChatOrchestrationSource, Medium } from "./types.js";

export type ChatEventInput = {
  userId: string;
  mode: "student" | "staff";
  boardId?: string | null;
  gradeId?: string | null;
  subjectId: string;
  medium?: Medium | null;
  question: string;
  source: ChatOrchestrationSource;
  provider?: string | null;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  answerBankId?: string | null;
  latencyMs?: number | null;
};

export async function recordChatEvent(event: ChatEventInput): Promise<void> {
  const baseUrl = process.env.OBSERVABILITY_URL;
  // Observability is an optional add-on to the pipeline, not a dependency of
  // it -- if it isn't configured, skip silently rather than warning on every
  // single request.
  if (!baseUrl) return;

  const sharedSecret = process.env.OBSERVABILITY_SHARED_SECRET;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sharedSecret ? { "x-internal-api-key": sharedSecret } : {}),
      },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      console.error(`Observability event request failed with status ${res.status}`);
      return;
    }
    // A 200 here only means the service accepted the request -- it still
    // reports recorded: false when its own Supabase connection isn't
    // configured (see services/observability/src/supabaseClient.ts), which
    // would otherwise fail this silently and leave chat_events looking
    // empty with nothing in either service's logs explaining why.
    const body = (await res.json().catch(() => null)) as { recorded?: boolean } | null;
    if (body && body.recorded === false) {
      console.error(
        "Observability service acknowledged the event but did not record it -- check its SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY configuration."
      );
    }
  } catch (err) {
    console.error("Observability event request failed:", err);
  }
}
