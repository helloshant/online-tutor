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

  try {
    const res = await fetch(VOYAGE_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: inputType }),
    });

    if (!res.ok) {
      console.error(`Voyage embeddings request failed with status ${res.status}: ${await res.text()}`);
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
  } catch (err) {
    console.error("Voyage embeddings request failed:", err);
    return null;
  }
}
