import "server-only";

import type { Medium } from "@/lib/supabase/types";

export type ChatTurn = { role: "user" | "assistant"; content: string };

// Everything the orchestration service needs to build a system prompt and
// call the active LLM provider. Prompt engineering, syllabus-relevance
// filtering, and provider selection all live in that service now -- this
// app only decides *whether* a user may ask (auth/entitlement) and persists
// the result; it no longer talks to any LLM SDK directly.
export type ChatOrchestrationRequest =
  | {
      mode: "student";
      subjectName: string;
      boardName: string;
      gradeName: string;
      medium: Medium;
      topics: { chapter: string; topic: string }[];
      message: string;
      history: ChatTurn[];
    }
  | {
      mode: "staff";
      subjectName: string;
      message: string;
      history: ChatTurn[];
    };

function getOrchestratorUrl(): string {
  const url = process.env.ORCHESTRATOR_URL;
  if (!url) throw new Error("Missing ORCHESTRATOR_URL environment variable");
  return url;
}

export async function getOrchestratedReply(request: ChatOrchestrationRequest): Promise<string> {
  const url = `${getOrchestratorUrl().replace(/\/$/, "")}/v1/chat`;
  const sharedSecret = process.env.ORCHESTRATOR_SHARED_SECRET;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sharedSecret ? { "x-internal-api-key": sharedSecret } : {}),
    },
    body: JSON.stringify(request),
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(body?.error ?? `Orchestrator request failed with status ${res.status}`);
  }
  if (!body || typeof body.reply !== "string") {
    throw new Error("Orchestrator returned an unexpected response shape");
  }
  return body.reply;
}
