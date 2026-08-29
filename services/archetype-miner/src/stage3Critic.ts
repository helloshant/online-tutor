import { getJsonCompletion } from "./jsonCompletion.js";
import { buildCriticPrompt } from "./prompts.js";
import type { Archetype, CriticDecision } from "./types.js";

const MAX_TOKENS = 16000;

const VALID_DECISIONS: CriticDecision[] = ["KEEP", "MERGE", "SPLIT", "REVISE", "REVIEW", "ADD", "REMOVE"];

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
    stats: raw.stats ?? {
      question_count: raw.supporting_question_ids?.length ?? 0,
      years_observed: [],
      first_observed_year: null,
      last_observed_year: null,
      marks_distribution: {},
      formats: {},
      difficulty_distribution: { Easy: 0, Medium: 0, Hard: 0 },
      grade_or_year_distribution: {},
    },
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

export type CriticResult = {
  reviewed: Archetype[];
  model: string;
  usage: { promptTokens: number; completionTokens: number };
};

// One call per education_context scope's full candidate catalogue (per the
// source doc's own INPUT description). Callers with a catalogue too large
// for one context window should chunk upstream -- not something this
// service's first version does yet; see the README section for where that
// would slot in.
export async function runCritic(candidates: Archetype[]): Promise<CriticResult | null> {
  if (candidates.length === 0) return { reviewed: [], model: "", usage: { promptTokens: 0, completionTokens: 0 } };

  const byId = new Map(candidates.map((a) => [a.archetype_id, a]));

  try {
    const { data, model, usage } = await getJsonCompletion({
      systemPrompt: buildCriticPrompt(),
      message: JSON.stringify(candidates),
      maxTokens: MAX_TOKENS,
    });

    if (!Array.isArray(data)) {
      console.warn("Stage 3 response was not a JSON array");
      return null;
    }

    const reviewed: Archetype[] = [];
    for (const raw of data) {
      if (isPlausibleReviewedArchetype(raw)) {
        reviewed.push(normalizeReviewed(raw, byId.get(raw.archetype_id)));
      } else {
        console.warn("Dropped an unusable reviewed Archetype from Stage 3 output:", JSON.stringify(raw).slice(0, 500));
      }
    }

    return { reviewed, model, usage };
  } catch (err) {
    console.warn("Stage 3 failed for this catalogue:", err);
    return null;
  }
}
