import "server-only";

import type { Medium } from "@/lib/supabase/types";

export type ChatTurn = { role: "user" | "assistant"; content: string };

// Mirrors the orchestrator's ImageMediaType/ImageAttachment exactly (see
// services/orchestrator/src/types.ts) -- kept in sync by hand, same as
// every other request/response shape duplicated in this file.
export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
export type ImageAttachment = { mediaType: ImageMediaType; base64: string };

// Everything the orchestration service needs to build a system prompt and
// call the active LLM provider. Prompt engineering, syllabus-relevance
// filtering, and provider selection all live in that service now -- this
// app only decides *whether* a user may ask (auth/entitlement) and persists
// the result; it no longer talks to any LLM SDK directly.
export type ChatOrchestrationRequest =
  | {
      mode: "student";
      userId: string;
      subjectId: string;
      subjectName: string;
      boardId: string;
      boardName: string;
      gradeId: string;
      gradeName: string;
      medium: Medium;
      topics: { chapter: string; topic: string }[];
      message: string;
      image?: ImageAttachment | null;
      history: ChatTurn[];
    }
  | {
      mode: "staff";
      userId: string;
      subjectId: string;
      subjectName: string;
      message: string;
      image?: ImageAttachment | null;
      history: ChatTurn[];
    };

// "cache" = Redis hit, "database" = Postgres full-text answer bank hit,
// "llm" = freshly generated, "rejected" = failed the syllabus scope gate.
// Optional/best-effort -- purely for observability, callers shouldn't
// branch on it.
export type ChatOrchestrationSource = "cache" | "database" | "llm" | "rejected";

function getOrchestratorUrl(): string {
  const url = process.env.ORCHESTRATOR_URL;
  if (!url) throw new Error("Missing ORCHESTRATOR_URL environment variable");
  return url;
}

export async function getOrchestratedReply(
  request: ChatOrchestrationRequest
): Promise<{ reply: string; source?: ChatOrchestrationSource }> {
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
  return { reply: body.reply, source: body.source };
}

export type TopicSummaryRequest = {
  userId: string;
  topicId: string;
  subjectName: string;
  boardName: string;
  gradeName: string;
  medium: Medium;
  chapter: string;
  topic: string;
};

export async function getTopicSummary(request: TopicSummaryRequest): Promise<{ summary: string }> {
  const url = `${getOrchestratorUrl().replace(/\/$/, "")}/v1/topic-summary`;
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
  if (!body || typeof body.summary !== "string") {
    throw new Error("Orchestrator returned an unexpected response shape");
  }
  return { summary: body.summary };
}

export type TopicExercisesRequest = {
  userId: string;
  boardId: string;
  gradeId: string;
  subjectId: string;
  subjectName: string;
  boardName: string;
  gradeName: string;
  medium: Medium;
  chapter: string;
  topic: string;
};

export type ExerciseItem = { question: string; answer: string };

export async function getTopicExercises(
  request: TopicExercisesRequest
): Promise<{ exercises: ExerciseItem[] }> {
  const url = `${getOrchestratorUrl().replace(/\/$/, "")}/v1/topic-exercises`;
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
  if (!body || !Array.isArray(body.exercises)) {
    throw new Error("Orchestrator returned an unexpected response shape");
  }
  return { exercises: body.exercises as ExerciseItem[] };
}

export type CacheInvalidationScope = {
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: Medium;
  question: string;
};

// Best-effort: called after an admin rejects or deletes an answer-bank
// entry so the demoted/removed answer stops being served from the
// orchestrator's Redis cache immediately, instead of surviving until its
// TTL runs out. Never throws -- the Postgres update/delete is the source of
// truth and must still succeed even if the orchestrator or Redis is
// unreachable; worst case is a stale cache entry for up to the TTL.
export async function invalidateCachedAnswer(scope: CacheInvalidationScope): Promise<void> {
  const sharedSecret = process.env.ORCHESTRATOR_SHARED_SECRET;
  try {
    const url = `${getOrchestratorUrl().replace(/\/$/, "")}/v1/cache/invalidate`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sharedSecret ? { "x-internal-api-key": sharedSecret } : {}),
      },
      body: JSON.stringify(scope),
    });
    if (!res.ok) {
      console.error(`Cache invalidation request failed with status ${res.status}`);
    }
  } catch (err) {
    console.error("Cache invalidation request failed:", err);
  }
}
