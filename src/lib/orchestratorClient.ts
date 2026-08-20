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
      // The student's real subscribed medium -- always drives topic scope,
      // the syllabus gate, RAG retrieval, and the cache key. Deliberately
      // never overridden by the language toggle (see responseLanguage
      // below and /api/chat/route.ts's own comment on why): a story that
      // only exists in this medium must still be recognized as in-scope
      // even when the student wants the reply in a different language.
      medium: Medium;
      // What language the model should actually reply in -- equal to
      // `medium` except when the English-subject toggle is on, in which
      // case it's "English" regardless of whether any English-medium
      // syllabus content exists. Never affects scope/grounding/caching,
      // only the system prompt's language instruction (see
      // buildTutorSystemPrompt) -- see server.ts's /v1/chat handler for
      // why a mismatch here also skips the cache/answer-bank stages.
      responseLanguage: Medium;
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
  subjectId: string;
  subjectName: string;
  boardName: string;
  gradeName: string;
  medium: Medium;
  // See ChatOrchestrationRequest's own comment -- defaults to `medium`.
  responseLanguage?: Medium;
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
  topicId: string;
  boardId: string;
  gradeId: string;
  subjectId: string;
  subjectName: string;
  boardName: string;
  gradeName: string;
  medium: Medium;
  // See ChatOrchestrationRequest's own comment -- defaults to `medium`.
  responseLanguage?: Medium;
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

export type ChapterDocumentEmbedRequest = {
  documentId: string;
  topicId: string;
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: Medium;
  content: string;
};

// Called right after the admin Chapter Notes action writes/updates the
// chapter_documents row itself (this app never holds Voyage credentials --
// same reasoning it never holds ANTHROPIC_API_KEY -- so the actual
// embedding call has to happen in the orchestrator; see
// services/orchestrator/src/chapterDocuments.ts). Not best-effort like
// invalidateCachedAnswer below: a failed embed here means the document is
// saved but invisible to retrieval, which the admin action surfaces back to
// whoever just saved it rather than silently swallowing.
export async function embedChapterDocument(
  request: ChapterDocumentEmbedRequest
): Promise<{ chunkCount: number; embedded: boolean }> {
  const url = `${getOrchestratorUrl().replace(/\/$/, "")}/v1/chapter-documents/embed`;
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
  if (!body || typeof body.chunkCount !== "number" || typeof body.embedded !== "boolean") {
    throw new Error("Orchestrator returned an unexpected response shape");
  }
  return { chunkCount: body.chunkCount, embedded: body.embedded };
}

export type ChapterDocumentImportChunksRequest = {
  documentId: string;
  topicId: string;
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: Medium;
  chunks: { content: string; fieldType?: string; citation?: string }[];
};

// Sibling of embedChapterDocument above, for the pre-chunked JSON import
// path -- the chunks are already split along real structural boundaries by
// whoever prepared the JSON (see src/app/admin/chapter-notes/
// import-chunks-form.tsx), so the orchestrator embeds them as given rather
// than re-splitting with its own naive chunker.
export async function importChapterChunks(
  request: ChapterDocumentImportChunksRequest
): Promise<{ chunkCount: number; embedded: boolean }> {
  const url = `${getOrchestratorUrl().replace(/\/$/, "")}/v1/chapter-documents/import-chunks`;
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
  if (!body || typeof body.chunkCount !== "number" || typeof body.embedded !== "boolean") {
    throw new Error("Orchestrator returned an unexpected response shape");
  }
  return { chunkCount: body.chunkCount, embedded: body.embedded };
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

// Same best-effort reasoning as invalidateCachedAnswer above, for the
// topic-summary cache namespace instead -- called after an admin rejects or
// deletes a topic summary in /admin/topic-summaries.
export async function invalidateCachedTopicSummary(topicId: string, language: Medium): Promise<void> {
  const sharedSecret = process.env.ORCHESTRATOR_SHARED_SECRET;
  try {
    const url = `${getOrchestratorUrl().replace(/\/$/, "")}/v1/topic-summary-cache/invalidate`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sharedSecret ? { "x-internal-api-key": sharedSecret } : {}),
      },
      body: JSON.stringify({ topicId, language }),
    });
    if (!res.ok) {
      console.error(`Topic-summary cache invalidation request failed with status ${res.status}`);
    }
  } catch (err) {
    console.error("Topic-summary cache invalidation request failed:", err);
  }
}
