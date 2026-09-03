// Shared by Stage 2 (Miner) and Stage 3 (Critic): Archetype.invariant_
// reasoning_structure is meant to be ONE descriptive string, but a model
// occasionally produces it as an array of steps instead -- the same shape
// as a QuestionSignature's own reasoning_pattern field, an easy confusion
// given Stage 2's own input is full of those (see prompts.ts's own note on
// this in the Miner SCHEMA). Rather than dropping an otherwise well-formed
// archetype over one field's shape, join an array of strings into one;
// anything else unusable returns null so the caller's own validation still
// catches a genuinely malformed value.
export function coerceToString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")) {
    return value.join(" -> ");
  }
  return null;
}

// Applies coerceToString to one raw parsed-JSON object's own
// invariant_reasoning_structure field, ahead of the caller's own shape
// validation (isPlausibleArchetype's strict typeof check in Stage 2;
// silently passed through uncoerced into normalizeReviewed otherwise in
// Stage 3, since isPlausibleReviewedArchetype doesn't check this field at
// all). Leaves the value/object alone whenever there's nothing to coerce
// (not an object, no such field, or coerceToString itself can't recover
// it) so the caller's own validation still sees whatever was actually
// there.
export function coerceInvariantReasoningStructure(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("invariant_reasoning_structure" in value)) return value;
  const coerced = coerceToString((value as { invariant_reasoning_structure: unknown }).invariant_reasoning_structure);
  return coerced === null ? value : { ...value, invariant_reasoning_structure: coerced };
}

type ArchetypeStats = {
  question_count: number;
  years_observed: number[];
  first_observed_year: number | null;
  last_observed_year: number | null;
  marks_distribution: Record<string, number>;
  formats: Record<string, number>;
  difficulty_distribution: { Easy: number; Medium: number; Hard: number };
  grade_or_year_distribution: Record<string, number>;
};

// Shared by Stage 2 and Stage 3: both previously fell back to a fully
// default `stats` object only when the model omitted `stats` ENTIRELY
// (`raw.stats ?? {defaults}`) -- but a model can also emit a `stats` object
// that's present yet has an individual field wrong-shaped, most often
// `years_observed: null` instead of `[]` (confirmed live in production:
// archetypes.archetype->stats->years_observed stored as JSON null for
// several real rows, including at least one that made it all the way to
// status "reviewed"/critic_decision "KEEP"). That slipped straight through
// the whole-object fallback since raw.stats itself was truthy, and then
// crashed admin/archetype-miner/coverage's own .join(", ") call on it at
// render time. Normalize field-by-field instead so one malformed field
// can't smuggle itself through just because its siblings look fine.
export function normalizeStats(raw: unknown, fallbackQuestionCount: number): ArchetypeStats {
  const s = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<ArchetypeStats>;
  return {
    question_count: typeof s.question_count === "number" ? s.question_count : fallbackQuestionCount,
    years_observed: Array.isArray(s.years_observed) ? s.years_observed : [],
    first_observed_year: typeof s.first_observed_year === "number" ? s.first_observed_year : null,
    last_observed_year: typeof s.last_observed_year === "number" ? s.last_observed_year : null,
    marks_distribution: typeof s.marks_distribution === "object" && s.marks_distribution !== null ? s.marks_distribution : {},
    formats: typeof s.formats === "object" && s.formats !== null ? s.formats : {},
    difficulty_distribution: {
      Easy: typeof s.difficulty_distribution?.Easy === "number" ? s.difficulty_distribution.Easy : 0,
      Medium: typeof s.difficulty_distribution?.Medium === "number" ? s.difficulty_distribution.Medium : 0,
      Hard: typeof s.difficulty_distribution?.Hard === "number" ? s.difficulty_distribution.Hard : 0,
    },
    grade_or_year_distribution:
      typeof s.grade_or_year_distribution === "object" && s.grade_or_year_distribution !== null ? s.grade_or_year_distribution : {},
  };
}
