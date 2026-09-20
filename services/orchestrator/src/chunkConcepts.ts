// Sibling of archetypeExercises.ts for subjects with nothing mined at all
// (WBBSE/ICSE -- confirmed zero archetypes for either board, see
// /v1/topic-exercises/subtopics's own comment). There's no exam-derived
// sub-topic data to fall back to there, but chapter content already writes
// one concept per chunk for `key_definitions`/`formulas_and_laws`-style
// field types -- close enough to a real sub-topic breakdown to use
// directly, with no new admin curation step required. Same "read shared
// tables directly, no extra HTTP hop" convention archetypeExercises.ts
// already uses for this service's own Supabase connection.
import { getSupabaseClient } from "./supabaseClient.js";
import type { TopicConcept } from "./types.js";

// Chunk field_type values written as one discrete concept per chunk (a
// term/law/method, not a whole-chapter overview or narrative). formulas/
// method_steps are verbatim-preserved alternates some Mathematics chapters
// carried over from source. Deliberately excludes overview/concept_summary/
// real_world_applications (chapter-wide, not single-concept) and
// common_mistakes (an errata note about an existing concept, not a
// standalone one worth its own exercise set).
const CONCEPT_FIELD_TYPES = ["key_definitions", "formulas_and_laws", "formulas", "method_steps"];

// Real chunk content across the live catalogue turns out to use several
// different label/emphasis conventions for its opening term, not just one
// -- confirmed directly against a live sample spanning many chapters, not
// assumed. In the order tried:
//   1. A leading Bengali or English label ("শব্দ:", "নাম:", "সূত্র:",
//      "সূত্রের নাম:", "Term:", "Formula:", "Law:") -- stripped before the
//      checks below run, so e.g. "শব্দ: *X* -- অর্থ: ..." and "*X*: ..."
//      (no label) both reach the same italic check next.
//   2. A **bold** term at the very start, e.g. "**Microsporogenesis** -- ...".
//   3. A *italic* term at the very start, e.g. "শব্দ: *তড়িৎ আধান* -- অর্থ: ..."
//      (after label-stripping) or "*মেন্ডেলিফের পর্যায় সূত্র*: ..." (no label).
//   4. No marker at all -- the term is just plain text up to the first
//      real separator (" -- ", " — ", a Bengali দাঁড়ি "।", or a bare ":"),
//      e.g. "প্লাস্টিসিটি: ..." or "নাম: ...কম্পাঙ্ক -- এটি বলে: ..."
//      (label-stripped, then split on " -- ").
// Falls back to a truncated content snippet only when none of these find a
// plausible-length term (no separator at all within FALLBACK_LABEL_LENGTH*2
// characters, or the label-stripped remainder itself is empty) -- never
// dropped, just less cleanly labeled in that case.
const LEADING_LABEL_PATTERN = /^(?:শব্দ|নাম|সূত্রের\s*নাম|সূত্র|Term|Formula|Law)\s*[:：]\s*/i;
const BOLD_TERM_PATTERN = /^\*\*([^*]+)\*\*/;
const ITALIC_TERM_PATTERN = /^\*([^*]+)\*/;
// Whichever of these appears FIRST in the (label-stripped) remainder ends
// the term -- checked as one alternation so "first occurring" is exactly
// what the regex naturally finds, rather than comparing several separate
// indexOf calls by hand.
const SEPARATOR_PATTERN = /\s--\s|\s—\s|।|:|：/;
const FALLBACK_LABEL_LENGTH = 60;
const MAX_PLAUSIBLE_TERM_LENGTH = 80;

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function truncatedSnippet(content: string): string {
  const trimmed = content.trim();
  const snippet = trimmed.slice(0, FALLBACK_LABEL_LENGTH);
  return trimmed.length > FALLBACK_LABEL_LENGTH ? `${snippet}…` : snippet;
}

function deriveTerm(content: string): string {
  const withoutLabel = content.trim().replace(LEADING_LABEL_PATTERN, "");

  const bold = withoutLabel.match(BOLD_TERM_PATTERN);
  if (bold) return bold[1].trim();

  const italic = withoutLabel.match(ITALIC_TERM_PATTERN);
  if (italic) return italic[1].trim();

  const separator = withoutLabel.match(SEPARATOR_PATTERN);
  if (separator && separator.index !== undefined && separator.index > 0) {
    const candidate = withoutLabel.slice(0, separator.index).trim();
    if (candidate.length > 0 && candidate.length <= MAX_PLAUSIBLE_TERM_LENGTH) return candidate;
  }

  return truncatedSnippet(content);
}

type ConceptGroup = { id: string; term: string; content: string };

// Groups this topic's own concept-eligible chunks by normalized term (a
// concept can legitimately span more than one chunk -- e.g. its own
// key_definitions entry AND a related formulas_and_laws entry) so one
// concept id maps to ALL of its own chunk content, joined, as generation
// grounding. Empty is normal for a chapter with no such chunks at all
// (narrative/literature-style topics) -- never an error.
async function getConceptGroups(topicId: string): Promise<ConceptGroup[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("chapter_document_chunks")
    .select("content, field_type, chunk_index")
    .eq("topic_id", topicId)
    .in("field_type", CONCEPT_FIELD_TYPES)
    .order("chunk_index");

  if (error) {
    console.error("Concept-chunk lookup for exercise generation failed (falling back to no concepts):", error);
    return [];
  }
  if (!data || data.length === 0) return [];

  const groups = new Map<string, ConceptGroup>();
  for (const row of data as { content: string; field_type: string | null }[]) {
    const term = deriveTerm(row.content);
    const key = normalize(term);
    const existing = groups.get(key);
    if (existing) {
      existing.content += `\n\n${row.content}`;
    } else {
      groups.set(key, { id: key, term, content: row.content });
    }
  }

  return Array.from(groups.values());
}

export async function findConceptsForTopic(topicId: string): Promise<TopicConcept[]> {
  const groups = await getConceptGroups(topicId);
  return groups.map((g) => ({ id: g.id, term: g.term }));
}

// null when conceptId doesn't match any current group for this topic --
// e.g. the chapter's content was edited between the picker being shown and
// the student clicking it. The caller treats this as "nothing to generate"
// rather than an error.
export async function findConceptContent(topicId: string, conceptId: string): Promise<{ term: string; content: string } | null> {
  const groups = await getConceptGroups(topicId);
  const match = groups.find((g) => g.id === conceptId);
  return match ? { term: match.term, content: match.content } : null;
}
