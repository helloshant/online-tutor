import { getJsonCompletion } from "./jsonCompletion.js";
import { buildCriticPrompt } from "./prompts.js";
import { coerceInvariantReasoningStructure, normalizeStats } from "./textCoercion.js";
import type { LlmProvider } from "./llm.js";
import type { Archetype, CriticDecision } from "./types.js";

const MAX_TOKENS = 16000;

const VALID_DECISIONS: CriticDecision[] = ["KEEP", "MERGE", "SPLIT", "REVISE", "REVIEW", "ADD", "REMOVE"];

// A large multi-year/multi-set ingestion (see the "Do more years make
// sense" discussion this came out of) can produce a candidate catalogue
// too big for one Critic call to review in a single response -- the same
// class of failure Stage 0 hit on an oversized single paper, except this
// stage previously had no protection against it at all (this file's own
// prior comment said so directly: "callers with a catalogue too large for
// one context window should chunk upstream -- not something this
// service's first version does yet"). Unlike Stage 0's raw paper text, a
// candidate catalogue is already an array of self-contained Archetype
// objects -- splitting it carries none of the "might sever shared
// context" risk raw text splitting had, so this uses plain fixed-size
// batches rather than any boundary-detection heuristic.
//
// Real trade-off, accepted deliberately: MERGE/duplicate detection is
// weaker ACROSS batches (an archetype in one batch that should merge with
// one in another batch won't be flagged, since each batch only ever sees
// its own candidates) -- but that's strictly better than the prior
// all-or-nothing failure this exists to fix, and cross-run duplicate
// detection has the exact same limitation today regardless (see the
// "cross-run merge" follow-up this was scoped alongside).
const BATCH_SIZE = 20;

function isPlausibleReviewedArchetype(value: unknown): value is Partial<Archetype> & { archetype_id: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.archetype_id === "string" && v.archetype_id.length > 0;
}

// Normalizes one reviewed archetype: fills whatever the model omitted with
// safe defaults, and -- critically -- if critic_decision is missing or not
// one of the seven valid labels, forces REVIEW rather than silently
// treating it as KEEP. "Do not default to KEEP when uncertain" is an
// explicit instruction to the model in the prompt; this is the same rule
// enforced structurally on the parsing side too, so a model slip (or a
// slightly malformed field) can never quietly pass an unreviewed archetype
// through as accepted.
function normalizeReviewed(raw: Partial<Archetype> & { archetype_id: string }, original: Archetype | undefined): Archetype {
  const decision =
    typeof raw.critic_decision === "string" && VALID_DECISIONS.includes(raw.critic_decision as CriticDecision)
      ? (raw.critic_decision as CriticDecision)
      : "REVIEW";

  const base = original ?? {
    archetype_id: raw.archetype_id,
    education_context: raw.education_context as Archetype["education_context"],
    name: raw.name ?? "",
    concept: raw.concept ?? "",
    learning_objective: raw.learning_objective ?? "",
    invariant_reasoning_structure: raw.invariant_reasoning_structure ?? "",
    variations: [],
    supporting_question_ids: raw.supporting_question_ids ?? [],
    stats: normalizeStats(raw.stats, raw.supporting_question_ids?.length ?? 0),
    generator_usable: raw.generator_usable ?? false,
    generator_usability_rationale: raw.generator_usability_rationale ?? "",
    mining_confidence: raw.mining_confidence ?? 0,
    status: "candidate" as const,
    critic_decision: null,
    critic_rationale: null,
    critic_evidence: [],
    merge_target_id: null,
    split_result_ids: [],
    possible_duplicate_of: [],
  };

  return {
    ...base,
    // REVISE may have changed name/description/variations/learning_objective
    // -- take the model's version of any field it actually returned,
    // falling back to what it started with for anything it left untouched.
    name: raw.name ?? base.name,
    concept: raw.concept ?? base.concept,
    learning_objective: raw.learning_objective ?? base.learning_objective,
    invariant_reasoning_structure: raw.invariant_reasoning_structure ?? base.invariant_reasoning_structure,
    variations: Array.isArray(raw.variations) ? raw.variations : base.variations,
    supporting_question_ids: raw.supporting_question_ids ?? base.supporting_question_ids,
    generator_usable: raw.generator_usable ?? base.generator_usable,
    generator_usability_rationale: raw.generator_usability_rationale ?? base.generator_usability_rationale,
    status: decision === "ADD" ? "candidate" : "reviewed",
    critic_decision: decision,
    critic_rationale: typeof raw.critic_rationale === "string" ? raw.critic_rationale : null,
    critic_evidence: Array.isArray(raw.critic_evidence) ? raw.critic_evidence : [],
    merge_target_id: typeof raw.merge_target_id === "string" ? raw.merge_target_id : null,
    split_result_ids: Array.isArray(raw.split_result_ids) ? raw.split_result_ids : [],
  };
}

// The fallback for a candidate Stage 3 never actually reviewed -- an
// entire batch that failed (exception, non-array response, or exhausted
// jsonCompletion's own retries), or one candidate a batch's response
// simply omitted despite the prompt requiring every candidate to be
// echoed back. Forces REVIEW rather than dropping the candidate: this
// reuses normalizeReviewed's own "no valid decision -> REVIEW" shape, so
// pipelineRunner.ts's existing review-queue logic (filters
// critic_decision === "REVIEW") picks these up automatically -- a human
// gets to decide, instead of the archetype silently staying "candidate"
// forever with no record anywhere that Stage 3 never actually looked at
// it (the exact bug this file's batching exists to fix).
function fallbackToReview(candidates: Archetype[], reason: string): Archetype[] {
  return candidates.map((c) => normalizeReviewed({ archetype_id: c.archetype_id, critic_rationale: reason }, c));
}

type BatchResult = { reviewed: Archetype[]; model: string; usage: { promptTokens: number; completionTokens: number } };

const EMPTY_USAGE = { promptTokens: 0, completionTokens: 0 };

async function runCriticBatch(candidates: Archetype[], provider?: LlmProvider): Promise<BatchResult> {
  const byId = new Map(candidates.map((a) => [a.archetype_id, a]));

  try {
    const { data, model, usage } = await getJsonCompletion({
      systemPrompt: buildCriticPrompt(),
      message: JSON.stringify(candidates),
      maxTokens: MAX_TOKENS,
      provider,
    });

    if (!Array.isArray(data)) {
      console.warn(`Stage 3 response was not a JSON array for a batch of ${candidates.length} candidate(s).`);
      return { reviewed: fallbackToReview(candidates, "Stage 3's response for this batch was not a JSON array."), model: "", usage: EMPTY_USAGE };
    }

    const reviewed: Archetype[] = [];
    const seenIds = new Set<string>();
    for (const rawItem of data) {
      // See textCoercion.ts's own comment -- isPlausibleReviewedArchetype
      // below doesn't check invariant_reasoning_structure's shape at all,
      // so an uncoerced array would otherwise pass straight through into
      // normalizeReviewed rather than being caught by any validation.
      const raw = coerceInvariantReasoningStructure(rawItem);
      if (isPlausibleReviewedArchetype(raw)) {
        reviewed.push(normalizeReviewed(raw, byId.get(raw.archetype_id)));
        seenIds.add(raw.archetype_id);
      } else {
        console.warn("Dropped an unusable reviewed Archetype from Stage 3 output:", JSON.stringify(raw).slice(0, 500));
      }
    }

    // The prompt requires every candidate to come back with a decision --
    // a model that silently omits one shouldn't leave it unreviewed with
    // no trace, same reasoning as a whole-batch failure just above.
    const missing = candidates.filter((c) => !seenIds.has(c.archetype_id));
    if (missing.length > 0) {
      console.warn(`Stage 3 did not return a decision for ${missing.length} of ${candidates.length} candidate(s) in this batch.`);
      reviewed.push(...fallbackToReview(missing, "Stage 3's response for this batch did not include a decision for this archetype."));
    }

    return { reviewed, model, usage };
  } catch (err) {
    console.warn(`Stage 3 failed for a batch of ${candidates.length} candidate(s):`, err);
    return {
      reviewed: fallbackToReview(candidates, `Stage 3 failed to review this batch: ${err instanceof Error ? err.message : String(err)}`),
      model: "",
      usage: EMPTY_USAGE,
    };
  }
}

export type CriticResult = {
  reviewed: Archetype[];
  model: string;
  usage: { promptTokens: number; completionTokens: number };
};

// One call per BATCH of up to BATCH_SIZE candidates from one
// education_context scope's full candidate catalogue (per the source
// doc's own INPUT description, now chunked upstream where the catalogue
// is large enough to need it -- see BATCH_SIZE's own comment). Never
// returns null and never drops a candidate silently: anything Stage 3
// couldn't actually get reviewed comes back with a synthesized REVIEW
// decision instead (see fallbackToReview).
export async function runCritic(candidates: Archetype[], provider?: LlmProvider): Promise<CriticResult> {
  if (candidates.length === 0) return { reviewed: [], model: "", usage: EMPTY_USAGE };

  const batches: Archetype[][] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) batches.push(candidates.slice(i, i + BATCH_SIZE));
  if (batches.length > 1) {
    console.warn(`Stage 3: catalogue of ${candidates.length} candidate(s) split into ${batches.length} batch(es) of up to ${BATCH_SIZE} each.`);
  }

  const reviewed: Archetype[] = [];
  let model = "";
  let promptTokens = 0;
  let completionTokens = 0;
  for (const batch of batches) {
    const result = await runCriticBatch(batch, provider);
    reviewed.push(...result.reviewed);
    model = result.model || model;
    promptTokens += result.usage.promptTokens;
    completionTokens += result.usage.completionTokens;
  }

  return { reviewed, model, usage: { promptTokens, completionTokens } };
}
