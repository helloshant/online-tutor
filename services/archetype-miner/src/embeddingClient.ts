// Mirrors services/orchestrator/src/voyageClient.ts closely (same
// provider, model, and retry/backoff shape, for the same reason: Anthropic
// has no first-party embedding model, and Voyage is Anthropic's own
// recommended embeddings partner) -- duplicated rather than imported since
// each service here is an independently deployable container with its own
// package.json/node_modules, not a shared workspace package.
const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";

// Same model/dimension the rest of this app already standardized on (see
// 0024_chapter_documents_rag.sql's own comment) -- this service's
// archetype_question_embeddings.embedding column is vector(1024) to match.
const VOYAGE_MODEL = "voyage-4";

type VoyageInputType = "document" | "query";

let warnedMissingKey = false;

const MAX_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// Unlike the chat pipeline's own use of this pattern (where a missing
// embedding just means "no RAG context this turn, chat still works"), a
// null return here is more consequential: clustering.ts can't group a
// signature it has no embedding for, so pipelineRunner.ts routes any
// question that fails to embed straight to the review queue instead of
// silently dropping it from the run (see reviewQueue.ts).
export async function embed(texts: string[], inputType: VoyageInputType): Promise<number[][] | null> {
  if (texts.length === 0) return [];

  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    if (!warnedMissingKey) {
      console.warn(
        "VOYAGE_API_KEY not set in services/archetype-miner/.env.local -- clustering (and " +
          "therefore Stage 2/3) cannot run without embeddings."
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

  return null;
}
