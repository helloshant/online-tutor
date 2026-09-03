import { getJsonCompletion } from "./jsonCompletion.js";
import { buildMinerPrompt } from "./prompts.js";
import { coerceInvariantReasoningStructure, normalizeStats } from "./textCoercion.js";
import type { LlmProvider } from "./llm.js";
import type { Archetype, ClusterInput } from "./types.js";

const MAX_TOKENS = 8000;

function isPlausibleArchetype(value: unknown): value is Partial<Archetype> & { archetype_id: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.archetype_id === "string" &&
    v.archetype_id.length > 0 &&
    typeof v.name === "string" &&
    typeof v.concept === "string" &&
    typeof v.invariant_reasoning_structure === "string" &&
    Array.isArray(v.supporting_question_ids) &&
    typeof v.mining_confidence === "number"
  );
}

// Stage 2's own output only ever partially fills the Archetype schema --
// status:"candidate" and the critic_* fields are Stage 3's job, not
// Stage 2's, so this fills in the fields Stage 2 has no business setting
// yet rather than trusting the model to have included empty placeholders
// for all of them on every single archetype it proposes.
function normalizeCandidate(raw: Partial<Archetype> & { archetype_id: string }, educationContext: ClusterInput["education_context"]): Archetype {
  return {
    archetype_id: raw.archetype_id,
    education_context: educationContext,
    name: raw.name ?? "",
    concept: raw.concept ?? "",
    learning_objective: raw.learning_objective ?? "",
    invariant_reasoning_structure: raw.invariant_reasoning_structure ?? "",
    variations: Array.isArray(raw.variations) ? raw.variations : [],
    supporting_question_ids: raw.supporting_question_ids ?? [],
    stats: normalizeStats(raw.stats, raw.supporting_question_ids?.length ?? 0),
    generator_usable: raw.generator_usable ?? false,
    generator_usability_rationale: raw.generator_usability_rationale ?? "",
    mining_confidence: raw.mining_confidence ?? 0,
    status: "candidate",
    critic_decision: null,
    critic_rationale: null,
    critic_evidence: [],
    merge_target_id: null,
    split_result_ids: [],
    possible_duplicate_of: Array.isArray(raw.possible_duplicate_of) ? raw.possible_duplicate_of : [],
  };
}

export type MinerResult = {
  archetypes: Archetype[];
  // question_ids Stage 2 itself flagged as belonging to no proposed
  // archetype ("do not force-fit") -- pipelineRunner routes these to the
  // review queue rather than silently discarding them, since Stage 3's own
  // ADD responsibility explicitly expects to see them.
  unassignedQuestionIds: string[];
  model: string;
  usage: { promptTokens: number; completionTokens: number };
};

// One call per ClusterInput. Returns null on a malformed/unusable response
// after retries -- the caller routes the WHOLE cluster's questions to the
// review queue (source: 'stage2_ambiguous_cluster') rather than losing
// them silently, matching the "every escalation has a defined destination"
// design principle.
export async function runMiner(cluster: ClusterInput, provider?: LlmProvider): Promise<MinerResult | null> {
  try {
    const { data, model, usage } = await getJsonCompletion({
      systemPrompt: buildMinerPrompt(),
      message: JSON.stringify(cluster),
      maxTokens: MAX_TOKENS,
      provider,
    });

    if (!Array.isArray(data)) {
      console.warn(`Stage 2 response for cluster ${cluster.cluster_id} was not a JSON array`);
      return null;
    }

    const archetypes: Archetype[] = [];
    for (const rawItem of data) {
      const raw = coerceInvariantReasoningStructure(rawItem);
      if (isPlausibleArchetype(raw)) {
        archetypes.push(normalizeCandidate(raw, cluster.education_context));
      } else {
        console.warn(
          `Dropped an implausible Archetype from Stage 2 output (cluster ${cluster.cluster_id}):`,
          JSON.stringify(raw).slice(0, 500)
        );
      }
    }

    const assignedIds = new Set(archetypes.flatMap((a) => a.supporting_question_ids));
    const unassignedQuestionIds = cluster.member_signatures
      .map((s) => s.question_id)
      .filter((id) => !assignedIds.has(id));

    return { archetypes, unassignedQuestionIds, model, usage };
  } catch (err) {
    console.warn(`Stage 2 failed for cluster ${cluster.cluster_id}:`, err);
    return null;
  }
}
