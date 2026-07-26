// Stage 2 of the answer pipeline: L1 exact/near-exact match cache. A miss or
// an unreachable Redis is never fatal -- every function here fails open (null
// on read, no-op on write) so the pipeline just falls through to the
// database/LLM stages instead of erroring the whole request.
import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import type { AnswerScope } from "./types.js";

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
    return await c.get(cacheKey(scope));
  } catch (err) {
    console.error("Redis GET failed:", err);
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
