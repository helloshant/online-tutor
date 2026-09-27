// Sibling of archetypeExercises.ts for subjects with nothing mined at all
// (WBBSE/ICSE -- confirmed zero archetypes for either board, see
// /v1/topic-exercises/subtopics's own comment). There's no exam-derived
// sub-topic data to fall back to there, but chapter content already writes
// one or more concepts per chunk for `key_definitions`/`formulas_and_laws`-
// style field types (split apart below, see splitIntoConceptBlocks) --
// close enough to a real sub-topic breakdown to use directly, with no new
// admin curation step required. Same "read shared tables directly, no
// extra HTTP hop" convention archetypeExercises.ts already uses for this
// service's own Supabase connection.
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
//      "সূত্রের নাম:", "রাশি:", "পদ:", "পরিভাষা:", "সূত্র/নীতি:",
//      "সূত্র/নিয়ম:", "Term:", "Formula:", "Law:") -- stripped before the
//      checks below run, so e.g. "শব্দ: *X* -- অর্থ: ..." and "*X*: ..."
//      (no label) both reach the same italic check next. The label itself
//      is sometimes bold-wrapped, and confirmed live in two different ways
//      that both need their own branch: closing ** AFTER the colon, on its
//      own line, as "**রাশি:**\n**X** -- ..." (e.g. a Physical Science
//      surface-tension/viscosity chunk), and closing ** BEFORE the colon,
//      inline, as "**রাশি**: **X** -- ..." (e.g. a Geography/Biology
//      definition chunk). Each is matched as one atomic unit (opening **
//      through closing **, both required together, in whichever order that
//      variant uses) so the closing ** can't be mistaken for the *opening*
//      ** of the real term that follows -- a plain permissive "few
//      asterisks either side" pattern would eat that opening ** too and
//      break the bold-term check below.
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
// Separately, some Biology/Life-Science chunks bake a chapter/subsection
// number into the bold term itself, e.g. "**২.B জনন**" or "**৩.A বংশগতি**"
// (confirmed live) -- stripped from whichever candidate wins above so the
// displayed term is just "জনন"/"বংশগতি", not "২.B জনন".
const LABEL_WORDS = "শব্দ|নাম|সূত্রের\\s*নাম|সূত্র\\s*/\\s*(?:নীতি|নিয়ম)|সূত্র|রাশি|পদ|পরিভাষা|Term|Formula|Law";
const LEADING_LABEL_PATTERN = new RegExp(
  `^(?:\\*\\*(?:${LABEL_WORDS})\\s*[:：]\\*\\*|\\*\\*(?:${LABEL_WORDS})\\*\\*\\s*[:：]|(?:${LABEL_WORDS})\\s*[:：])\\s*`,
  "i",
);
const BOLD_TERM_PATTERN = /^\*\*([^*]+)\*\*/;
const ITALIC_TERM_PATTERN = /^\*([^*]+)\*/;
// Whichever of these appears FIRST in the (label-stripped) remainder ends
// the term -- checked as one alternation so "first occurring" is exactly
// what the regex naturally finds, rather than comparing several separate
// indexOf calls by hand.
const SEPARATOR_PATTERN = /\s--\s|\s—\s|।|:|：/;
const FALLBACK_LABEL_LENGTH = 60;
const MAX_PLAUSIBLE_TERM_LENGTH = 80;
const NUMBERING_PREFIX_PATTERN = /^[০-৯0-9]+\s*\.\s*[A-Za-zঅ-হ]\s+/;

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function stripNumberingPrefix(term: string): string {
  return term.replace(NUMBERING_PREFIX_PATTERN, "").trim();
}

function truncatedSnippet(content: string): string {
  const trimmed = content.trim();
  const snippet = trimmed.slice(0, FALLBACK_LABEL_LENGTH);
  return trimmed.length > FALLBACK_LABEL_LENGTH ? `${snippet}…` : snippet;
}

function deriveTerm(content: string): string {
  const withoutLabel = content.trim().replace(LEADING_LABEL_PATTERN, "");

  const bold = withoutLabel.match(BOLD_TERM_PATTERN);
  if (bold) return stripNumberingPrefix(bold[1].trim());

  const italic = withoutLabel.match(ITALIC_TERM_PATTERN);
  if (italic) return stripNumberingPrefix(italic[1].trim());

  const separator = withoutLabel.match(SEPARATOR_PATTERN);
  if (separator && separator.index !== undefined && separator.index > 0) {
    const candidate = withoutLabel.slice(0, separator.index).trim();
    if (candidate.length > 0 && candidate.length <= MAX_PLAUSIBLE_TERM_LENGTH) return stripNumberingPrefix(candidate);
  }

  return truncatedSnippet(content);
}

// A single chunk row sometimes batches several back-to-back definitions
// under one field_type instead of one each, e.g. a Physics chunk covering
// "series resistors", "parallel resistors", "electrical power", "watt", and
// "kilowatt-hour" as five "শব্দ: **X** -- অর্থ: ..." paragraphs in one row
// (confirmed live, not a hypothetical -- along with an 8-concept Maths
// example covering distinct differential-equation definitions the same
// way). deriveTerm() only ever reads the start of its input, so left
// whole, a row like that surfaces as a single sub-topic pick under
// whichever concept happened to be written first, silently hiding the
// rest. A paragraph (blank-line-separated) that itself looks like a new
// concept's opening -- by the same label/bold/italic signatures deriveTerm
// already recognizes, just requiring the bold/italic case to be followed
// by a real separator so a narrative aside that merely opens with a bold
// phrase isn't mistaken for a new concept -- starts a new block; anything
// else (an elaborating paragraph, a trailing "exercise questions" summary)
// stays attached to whichever block precedes it, same as today for a
// single-concept row with multiple paragraphs.
const BOLD_CONCEPT_START_PATTERN = /^\*\*[^*]+\*\*\s*(?:--|—|[:：])/;
const ITALIC_CONCEPT_START_PATTERN = /^\*[^*]+\*\s*(?:--|—|[:：])/;

function looksLikeNewConcept(paragraph: string): boolean {
  return (
    LEADING_LABEL_PATTERN.test(paragraph) ||
    BOLD_CONCEPT_START_PATTERN.test(paragraph) ||
    ITALIC_CONCEPT_START_PATTERN.test(paragraph)
  );
}

function splitIntoConceptBlocks(content: string): string[] {
  const paragraphs = content
    .trim()
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return [content];

  const blocks: string[] = [];
  let current = [paragraphs[0]];
  for (let i = 1; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    if (looksLikeNewConcept(paragraph)) {
      blocks.push(current.join("\n\n"));
      current = [paragraph];
    } else {
      current.push(paragraph);
    }
  }
  blocks.push(current.join("\n\n"));
  return blocks;
}

type ConceptGroup = { id: string; term: string; content: string };

// Groups this topic's own concept-eligible chunks -- split into individual
// concept blocks first, since one row can hold several (see
// splitIntoConceptBlocks) -- by normalized term (a concept can legitimately
// span more than one chunk or block -- e.g. its own key_definitions entry
// AND a related formulas_and_laws entry) so one concept id maps to ALL of
// its own block content, joined, as generation grounding. Empty is normal
// for a chapter with no such chunks at all (narrative/literature-style
// topics) -- never an error.
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
    for (const block of splitIntoConceptBlocks(row.content)) {
      const term = deriveTerm(block);
      const key = normalize(term);
      const existing = groups.get(key);
      if (existing) {
        existing.content += `\n\n${block}`;
      } else {
        groups.set(key, { id: key, term, content: block });
      }
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
