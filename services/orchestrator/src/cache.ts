// Stage 2 of the answer pipeline: L1 exact/near-exact match cache. A miss or
// an unreachable Redis is never fatal -- every function here fails open (null
// on read, no-op on write) so the pipeline just falls through to the
// database/LLM stages instead of erroring the whole request.
import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import type { AnswerScope, Medium } from "./types.js";

const REDIS_URL = process.env.REDIS_URL;
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS) || 60 * 60 * 24 * 7; // 7 days

let client: RedisClientType | null = null;
let connectPromise: Promise<RedisClientType | null> | null = null;

async function getClient(): Promise<RedisClientType | null> {
  if (!REDIS_URL) return null;
  if (client) return client;
  if (!connectPromise) {
    connectPromise = (async () => {
      try {
        const c: RedisClientType = createClient({ url: REDIS_URL });
        c.on("error", (err) => console.error("Redis client error:", err));
        await c.connect();
        client = c;
        return c;
      } catch (err) {
        console.error("Failed to connect to Redis, caching disabled:", err);
        connectPromise = null;
        return null;
      }
    })();
  }
  return connectPromise;
}

function normalizeQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, " ");
}

function cacheKey(scope: AnswerScope): string {
  const hash = createHash("sha256").update(normalizeQuestion(scope.question)).digest("hex");
  return `tutorops:answer:${scope.boardId}:${scope.gradeId}:${scope.subjectId}:${scope.medium}:${hash}`;
}

export async function getCachedAnswer(scope: AnswerScope): Promise<string | null> {
  const c = await getClient();
  if (!c) return null;
  try {
    // GETEX (not plain GET) resets the TTL on every hit -- a sliding
    // expiration, so a genuinely popular question stays cached as long as
    // it keeps getting asked, instead of expiring on a fixed clock from
    // whenever it was first written regardless of how often it's reused.
    return await c.getEx(cacheKey(scope), { EX: CACHE_TTL_SECONDS });
  } catch (err) {
    console.error("Redis GETEX failed:", err);
    return null;
  }
}

export async function setCachedAnswer(scope: AnswerScope, answer: string): Promise<void> {
  const c = await getClient();
  if (!c) return;
  try {
    await c.set(cacheKey(scope), answer, { EX: CACHE_TTL_SECONDS });
  } catch (err) {
    console.error("Redis SET failed:", err);
  }
}

// Used when an admin rejects or deletes the corresponding answer-bank
// entry, so a demoted answer stops being served from cache immediately
// instead of surviving until its TTL runs out.
export async function deleteCachedAnswer(scope: AnswerScope): Promise<void> {
  const c = await getClient();
  if (!c) return;
  try {
    await c.del(cacheKey(scope));
  } catch (err) {
    console.error("Redis DEL failed:", err);
  }
}

// Same cache, a separate key namespace: topic summaries are looked up by
// (topic_id, language) (see topic_summaries' unique constraint,
// 0027_topic_summary_language.sql), not by a question string, so this
// doesn't reuse cacheKey() above. Only ever populated with an *approved*
// summary (see server.ts's /v1/topic-summary handler) -- a pending_review
// one is deliberately kept out of here, same reasoning as answer-bank's
// cache-only-on-auto_approve.
function topicSummaryCacheKey(topicId: string, language: Medium): string {
  return `tutorops:topic-summary:${topicId}:${language}`;
}

export async function getCachedTopicSummary(topicId: string, language: Medium): Promise<string | null> {
  const c = await getClient();
  if (!c) return null;
  try {
    return await c.getEx(topicSummaryCacheKey(topicId, language), { EX: CACHE_TTL_SECONDS });
  } catch (err) {
    console.error("Redis GETEX (topic summary) failed:", err);
    return null;
  }
}

export async function setCachedTopicSummary(topicId: string, language: Medium, summary: string): Promise<void> {
  const c = await getClient();
  if (!c) return;
  try {
    await c.set(topicSummaryCacheKey(topicId, language), summary, { EX: CACHE_TTL_SECONDS });
  } catch (err) {
    console.error("Redis SET (topic summary) failed:", err);
  }
}

// Used when an admin rejects or deletes a topic summary, mirroring
// deleteCachedAnswer above -- a demoted summary must stop being served from
// cache right away, not survive until its TTL runs out.
export async function deleteCachedTopicSummary(topicId: string, language: Medium): Promise<void> {
  const c = await getClient();
  if (!c) return;
  try {
    await c.del(topicSummaryCacheKey(topicId, language));
  } catch (err) {
    console.error("Redis DEL (topic summary) failed:", err);
  }
}
