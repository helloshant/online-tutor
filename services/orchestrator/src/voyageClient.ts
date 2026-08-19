// Anthropic has no first-party embedding model -- Voyage AI is Anthropic's
// own recommended embeddings partner (see platform.claude.com/docs/en/
// build-with-claude/embeddings), so this is the only external embeddings
// call this codebase makes. No official Voyage Node/TypeScript SDK exists
// (only Python), so this is a plain fetch against their HTTP API, the same
// way this file's sibling providers reach Anthropic/Azure OpenAI through
// their own SDKs -- just without one available here.
const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";

// Balances quality and cost/latency for general-purpose multilingual
// retrieval (this app's chapter content spans English, Hindi, and Bengali
// medium) -- see Voyage's own model guide. 1024 is this model's default
// output dimension; supabase/migrations/0024_chapter_documents_rag.sql's
// `vector(1024)` columns must change together with this if it's ever
// swapped for a different model/dimension.
const VOYAGE_MODEL = "voyage-4";

type VoyageInputType = "document" | "query";

let warnedMissingKey = false;

// Chapter-document imports call this once per document, back to back with
// no gap (see chapterDocuments.ts) -- observed in practice: the last
// document or two in a several-chapter import fails while the earlier ones
// succeed, the classic signature of a request-per-minute limit (or an
// occasional transient network blip) being tripped partway through a tight
// sequential loop, not anything wrong with that specific document's
// content. Retries absorb exactly that case instead of forcing a full
// re-run of the import for one chapter.
const MAX_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 429 (rate limited) and 5xx (Voyage's own transient failures) are worth
// retrying; anything else (400 bad request, 401 bad key, 413 payload too
// large, ...) will just fail the same way again, so retrying would only
// delay surfacing a real problem.
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// Fails open like every other optional stage in this service (cache.ts,
// answerBank.ts) -- a missing key, a network error, or a non-200 response
// all just mean "no embeddings this call," never a thrown error that would
// take down the chat pipeline or a document save. Returns embeddings in the
// same order as `texts` (Voyage's own `index` field on each result is used
// to place them, rather than trusting response array order to already
// match request order).
export async function embed(texts: string[], inputType: VoyageInputType): Promise<number[][] | null> {
  if (texts.length === 0) return [];

  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    if (!warnedMissingKey) {
      console.warn(
        "VOYAGE_API_KEY not set in services/orchestrator/.env.local -- chapter-document embedding " +
          "and retrieval-augmented chat context are disabled (chat still works, just without this)."
      );
      warnedMissingKey = true;
    }
    return null;
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(VOYAGE_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: inputType }),
      });
    } catch (err) {
      // Network-level failure (DNS, connection reset, timeout) -- always
      // worth retrying, same reasoning as a 5xx.
      if (attempt === MAX_ATTEMPTS) {
        console.error("Voyage embeddings request failed:", err);
        return null;
      }
      console.warn(`Voyage embeddings request failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying:`, err);
      await sleep(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
      continue;
    }

    if (!res.ok) {
      const bodyText = await res.text();
      if (isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS) {
        // Voyage sends Retry-After (seconds) on a 429 when it wants a
        // specific wait -- honor it over our own backoff schedule when
        // present, since it reflects their actual rate-limit window rather
        // than a guess.
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
        const delayMs = Number.isFinite(retryAfterMs) ? retryAfterMs : BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
        console.warn(
          `Voyage embeddings request failed with status ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${delayMs}ms: ${bodyText}`
        );
        await sleep(delayMs);
        continue;
      }
      console.error(`Voyage embeddings request failed with status ${res.status}: ${bodyText}`);
      return null;
    }

    const body = (await res.json()) as { data?: { embedding: number[]; index: number }[] };
    if (!Array.isArray(body.data) || body.data.length !== texts.length) {
      console.error("Voyage embeddings response had an unexpected shape.");
      return null;
    }

    const embeddings = new Array<number[]>(texts.length);
    for (const entry of body.data) embeddings[entry.index] = entry.embedding;
    return embeddings;
  }

  // Unreachable -- the loop above always returns or (on its final iteration)
  // falls into one of the two `return null` branches instead of `continue`.
  return null;
}
