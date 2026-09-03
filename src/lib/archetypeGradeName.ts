import "server-only";

// Shared by every route that translates a syllabus-catalog grade name
// (grades.name, always "Grade N" -- confirmed live, e.g. "Grade 12") into
// the bare number archetype-miner submissions store in education_context.
// grade_or_year ("N", never "Grade N" -- admin-typed free text at
// ingestion time, confirmed live against real archetypes). Without this,
// any board/grade/subject filter passed to the archetype-miner's own
// tables (directly, or via the orchestrator's findArchetypesForTopic)
// silently matches nothing -- not an error, just an empty result, which
// is exactly what made this so easy to ship broken in four different
// places before anyone noticed: /api/topics/archetype-progress (fixed
// first), then /api/topics/[id]/exercises, .../exercises/patterns, and
// .../exercises/generate (all fixed together once the pattern was
// recognized as systemic rather than a one-off).
export function toArchetypeGradeOrYear(gradeName: string): string {
  return gradeName.replace(/^grade\s+/i, "").trim();
}
