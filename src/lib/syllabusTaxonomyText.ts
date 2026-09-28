import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Auto-derives Stage 1's own "SUPPLIED CURRICULUM TAXONOMY" document
// (archetype_curriculum_taxonomies.taxonomy_text -- see the archetype-
// miner service's own curriculumTaxonomy.ts) directly from this app's own
// syllabus_topics catalogue, instead of leaving it to an admin to
// hand-type and keep in sync separately. Confirmed live: ZERO rows
// existed in archetype_curriculum_taxonomies at all before this -- every
// mining run classified curriculum.chapter/topic purely from the model's
// own judgment, with no anchor to this app's actual curated syllabus
// text. That's the direct, confirmed cause of mined archetypes using
// chapter names ("Biotechnology Principles and Processes", "Origin of
// Life and Evolution") that don't exactly match syllabus_topics' own
// wording ("Biotechnology: Principles and Processes", "Evolution"),
// silently breaking every exact-string match this app does between the
// two (year-coverage, archetype-progress, the pattern picker's own topic
// lookup) -- a real archetype from a real 2026 paper just never shows up
// under its actual topic.
//
// Grouped by grade+subject and printed as literal chapter/topic pairs (not
// just topic names) since curriculum.chapter and curriculum.topic are
// separate fields Stage 1 must match independently -- see
// archetypeCoverage.ts's own comment on why syllabus_topics itself uses
// two different granularity conventions (chapter sometimes IS the real
// chapter, sometimes is just the subject name repeated with the real
// chapter in topic instead) -- printing both fields verbatim sidesteps
// needing to know which convention applies for a given board/subject.
export async function buildTaxonomyTextFromSyllabus(admin: SupabaseClient, boardName: string): Promise<string | null> {
  const { data: board } = await admin.from("boards").select("id").eq("name", boardName).maybeSingle();
  if (!board) return null;

  // No medium filter: for a board like CBSE, every medium's rows describe
  // the same chapters/topics, so this changes nothing there -- the
  // chapter+topic dedup below already collapses the resulting identical
  // pairs. But for a board like West Bengal Board, a grade+subject scope
  // can have GENUINELY DIFFERENT syllabus_topics rows depending on medium
  // (e.g. Bengali-medium History exists, English-medium History doesn't,
  // for the exact same board/grade/subject) -- filtering to one medium
  // silently produces an incomplete taxonomy for every subject that isn't
  // offered in that medium, which then makes Stage 1 invent its own
  // phrasing for that missing content instead of anchoring to the real
  // syllabus wording (confirmed live: this is exactly what made every
  // West Bengal Board mining run need a manual Curriculum reconciliation
  // pass afterward).
  const { data, error } = await admin
    .from("syllabus_topics")
    .select("chapter, topic, grade:grades(name), subject:subjects(name)")
    .eq("board_id", board.id);
  if (error || !data || data.length === 0) return null;

  type Row = { chapter: string; topic: string; grade: { name: string } | null; subject: { name: string } | null };
  const rows = data as unknown as Row[];

  // Grouped with actual object keys, not joined/split strings -- grade
  // names ("Grade 12"), chapters, and topics all routinely contain spaces
  // of their own, which would silently mis-split a naive `"a b".split(" ")`
  // round-trip.
  type Group = { gradeName: string; subjectName: string; pairs: Map<string, { chapter: string; topic: string }> };
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const gradeName = r.grade?.name ?? "(grade not set)";
    const subjectName = r.subject?.name ?? "(subject not set)";
    const groupKey = JSON.stringify([gradeName, subjectName]);
    let group = groups.get(groupKey);
    if (!group) {
      group = { gradeName, subjectName, pairs: new Map() };
      groups.set(groupKey, group);
    }
    group.pairs.set(JSON.stringify([r.chapter, r.topic]), { chapter: r.chapter, topic: r.topic });
  }

  const sections = Array.from(groups.values())
    .sort((a, b) => (a.gradeName + a.subjectName).localeCompare(b.gradeName + b.subjectName))
    .map((group) => {
      const lines = Array.from(group.pairs.values())
        .sort((a, b) => (a.chapter + a.topic).localeCompare(b.chapter + b.topic))
        .map((p) => `- chapter: "${p.chapter}", topic: "${p.topic}"`);
      return `== ${group.gradeName} · ${group.subjectName} ==\n${lines.join("\n")}`;
    });

  return `Curriculum topics for ${boardName}, generated directly from this app's own syllabus catalogue
(regenerate this document from the taxonomies page whenever the syllabus catalogue changes, rather
than hand-editing it -- it's meant to always mirror that source of truth exactly).

Use these EXACT chapter and topic names -- verbatim, same spelling, spacing, and punctuation -- when
classifying curriculum.chapter and curriculum.topic below, even when a close paraphrase feels equally
natural. If a question's real chapter/topic genuinely isn't in this list (e.g. a chapter since removed
from the syllabus, or an out-of-scope elective), propose the closest reasonable name and flag it via
taxonomy_match = "no_match" rather than forcing a wrong exact match.

${sections.join("\n\n")}`;
}
