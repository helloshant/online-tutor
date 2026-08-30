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
