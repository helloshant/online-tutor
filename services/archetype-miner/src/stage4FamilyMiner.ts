import { randomUUID } from "node:crypto";
import { getJsonCompletion } from "./jsonCompletion.js";
import { buildFamilyMinerPrompt } from "./familyPrompt.js";
import type { Archetype, ArchetypeFamily } from "./types.js";

const MAX_TOKENS = 8000;

function isPlausibleFamily(value: unknown): value is Partial<ArchetypeFamily> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.family_name === "string" &&
    v.family_name.trim().length > 0 &&
    Array.isArray(v.member_archetype_ids) &&
    v.member_archetype_ids.every((id) => typeof id === "string") &&
    typeof v.progression_notes === "string" &&
    v.progression_notes.trim().length > 0
  );
}

export type FamilyMinerResult = {
  families: ArchetypeFamily[];
  model: string;
  usage: { promptTokens: number; completionTokens: number };
};

// One call over the WHOLE candidate pool for one subject_or_course (see
// server.ts's own comment on why callers must name a subject explicitly
// rather than this running over the entire catalogue unprompted). Only
// ever called with archetypes already accepted into their own catalogues
// (status reviewed/final, critic_decision KEEP/REVISE/ADD) -- the caller's
// job (see server.ts), not this function's, to have filtered out
// MERGE/REMOVE/REVIEW archetypes before this ever runs.
export async function runFamilyMiner(archetypes: Archetype[]): Promise<FamilyMinerResult | null> {
  if (archetypes.length === 0) {
    return { families: [], model: "", usage: { promptTokens: 0, completionTokens: 0 } };
  }

  const byId = new Set(archetypes.map((a) => a.archetype_id));
  const subjectOrCourse = archetypes[0].education_context.subject_or_course;

  try {
    const { data, model, usage } = await getJsonCompletion({
      systemPrompt: buildFamilyMinerPrompt(),
      message: JSON.stringify(archetypes),
      maxTokens: MAX_TOKENS,
    });

    if (!Array.isArray(data)) {
      console.warn("Stage 4 (Family Miner) response was not a JSON array");
      return null;
    }

    const families: ArchetypeFamily[] = [];
    for (const raw of data) {
      if (!isPlausibleFamily(raw)) {
        console.warn("Dropped an implausible ArchetypeFamily from Stage 4 output:", JSON.stringify(raw).slice(0, 500));
        continue;
      }
      // Every referenced archetype_id must actually be one this call was
      // given -- a hallucinated id here would otherwise silently persist a
      // family pointing at nothing (or, worse, at an unrelated archetype
      // that happens to share an id format from a different subject).
      const memberIds = (raw.member_archetype_ids as string[]).filter((id) => byId.has(id));
      const distinctScopes = new Set(
        memberIds.map((id) => {
          const a = archetypes.find((x) => x.archetype_id === id) as Archetype;
          return `${a.education_context.education_stage}::${a.education_context.grade_or_year}`;
        })
      );
      // Enforces the prompt's own "at least two members from at least two
      // different scopes" rule structurally too, not just as an
      // instruction the model might not follow -- a single-scope or
      // single-member "family" isn't a cross-level relationship at all.
      if (memberIds.length < 2 || distinctScopes.size < 2) {
        console.warn(
          `Dropped a family with insufficient cross-level evidence ("${raw.family_name}"): ` +
            `${memberIds.length} valid member(s) across ${distinctScopes.size} scope(s).`
        );
        continue;
      }

      families.push({
        family_id: typeof raw.family_id === "string" && raw.family_id ? raw.family_id : randomUUID(),
        family_name: raw.family_name as string,
        member_archetype_ids: memberIds,
        progression_notes: raw.progression_notes as string,
      });
    }

    return { families, model, usage };
  } catch (err) {
    console.warn(`Stage 4 (Family Miner) failed for subject "${subjectOrCourse}":`, err);
    return null;
  }
}
