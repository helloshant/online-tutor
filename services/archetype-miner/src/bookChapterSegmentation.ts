import { getJsonCompletion } from "./jsonCompletion.js";
import { buildBookChapterSegmentationPrompt } from "./prompts.js";

// Turns a whole scanned book's raw OCR text (see the web app's
// admin/archetype-miner/ocr page -- "OCR a scanned paper or book") into
// per-chapter chunks ready to drop straight into the Chapter Notes admin
// page's own "Import chunks" JSON format (chapter_number/chapter_title/
// text -- see src/app/admin/chapter-notes/import-chunks-form.tsx and
// importChapterChunksJson in that page's actions.ts). A book's own natural
// chapter structure is exactly the shape that import already expects, so
// this closes the loop from "photo of a book" to "ready-to-upload file"
// without an admin manually copy-pasting chapter breaks by hand.
//
// Deliberately never asks the model to reproduce chapter TEXT -- only
// where each chapter starts (see buildBookChapterSegmentationPrompt's own
// comment on why: a whole book echoed back through a JSON response is
// both an unreasonable output size and a real corruption risk). The
// model's proposed boundary is a verbatim excerpt from the input; this
// file finds that excerpt's REAL position in the original text itself
// (never trusting the model's own account of where it is) and slices
// deterministically, so the actual chapter text delivered downstream is
// always exactly what Document AI produced -- never re-typed by an LLM.

const MAX_TOKENS = 8000;

type RawBoundary = { chapter_title: string; heading: string };

export type BookChapterChunk = { chapter_number: number; chapter_title: string; text: string };

// A boundary the model proposed whose own "heading" excerpt couldn't
// actually be located (at all, or in the right place -- see
// resolveBoundaries's own comment) in the source text -- surfaced rather
// than silently dropped, same "fail open per unit, but tell the admin"
// convention as ocrPipeline.ts's own per-page-range chunkErrors. Keeps the
// model's own attempted `heading` text, not just the chapter_title --
// without it, there's no way to tell WHY a match failed short of
// re-deriving it blind (confirmed directly: this is exactly what let a
// real table-of-contents mismatch get diagnosed at all, see
// resolveBoundaries's own comment).
export type UnresolvedBoundary = { chapterTitle: string; heading: string };

export type SegmentBookResult = {
  chunks: BookChapterChunk[];
  unresolved: UnresolvedBoundary[];
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strips a leading "Lesson 6", "Chapter 12:", "Unit 3 -", "6.", "(6)" style
// label from a candidate heading, or returns null if there isn't one.
// Confirmed live: given a book whose table of contents lists entries as
// "Lesson 6 Sea Fever", the model prefixed EVERY proposed heading with
// that same "Lesson N" label -- even though the chapter's own body text
// just starts with the bare title ("Sea Fever"), with no such label
// physically adjacent to it at that exact spot. A reasonable, very common
// thing for a model to do (echoing the table of contents' own numbering
// convention) that no amount of "copy it verbatim" prompt wording alone
// reliably prevents, so this exists as a second candidate excerpt to
// search for, alongside the heading exactly as given.
const LABEL_PREFIX = /^(lesson|chapter|unit|poem|story|part)\s*\d+\s*[:.)-]?\s+|^\(?\d+\)?\s*[:.)-]\s+/i;

function stripLabelPrefix(heading: string): string | null {
  const stripped = heading.replace(LABEL_PREFIX, "");
  return stripped !== heading && stripped.trim() ? stripped.trim() : null;
}

// Confirmed live, same underlying problem as LABEL_PREFIX but in Bengali:
// a table of contents listing entries as "দ্বিতীয় পাঠ [title]" ("Second
// Lesson [title]") made the model prefix every proposed heading with that
// same ordinal-word label, even though the chapter's own body just starts
// with the bare title -- LABEL_PREFIX doesn't catch this because it only
// recognizes English label WORDS ("Lesson", "Chapter", ...) followed by an
// Arabic numeral, not an ordinal spelled out as a word in another script
// (Bengali "দ্বিতীয়", Hindi "दूसरा"/"द्वितीय", and whatever else this app
// might eventually need to support). Enumerating every language's own
// ordinal words is a losing game; stripping the heading's own leading
// words one at a time, most conservative first, generalizes to ANY label
// convention without knowing what language or word it's written in --
// added to resolveBoundaries's own variant pool (see that function's own
// comment on why POOLED, not tried only once everything else fails: the
// label-heavy full heading here often matches ONLY in the table of
// contents, never in the body at all, so stopping as soon as that one
// (wrong) match is found would never even try the variant that finds the
// real one).
//
// Capped both by how much is stripped and how much must remain: a short,
// generic residual string is far more likely to match somewhere spurious
// (a running header, an unrelated sentence) than a genuinely mismatched
// label prefix is to need more than a few words stripped from it.
// Reported live: a real book's own titles were often genuinely just 1-2
// words long ("একাকারে", "অভিষেক") -- an EARLIER, higher floor here (3)
// blocked stripping far enough to ever reach them, since "label (2 words)
// + 2-word title" only has 2 words left once the label's gone. Lowered to
// 2 for that reason; genuine 1-word titles are covered separately below
// by chapter_title itself, not by stripping this thin.
const MAX_LEADING_WORDS_STRIPPED = 4;
const MIN_REMAINING_WORDS = 2;

function stripLeadingWords(heading: string, count: number): string | null {
  const words = heading.split(/\s+/).filter(Boolean);
  if (words.length - count < MIN_REMAINING_WORDS) return null;
  return words.slice(count).join(" ");
}

// One case-insensitive, whitespace-tolerant regex for `candidate` --
// strictly matches everything an exact, case-sensitive substring search
// would too (a run of exactly the same whitespace the candidate has is
// still a valid \s+ match), so one regex covers "copied verbatim" all the
// way down to "same words, different case/line-wrap" in a single pass.
// Runs of whitespace in `candidate` match ANY run of whitespace in the
// text -- an OCR line-wrap or a stray double space between the same words
// doesn't defeat an otherwise-correct match. Returns null for an
// all-whitespace candidate (nothing meaningful to search for).
function buildHeadingRegex(candidate: string): RegExp | null {
  const words = candidate.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return new RegExp(words.map(escapeRegExp).join("\\s+"), "gi");
}

// Every position `candidate` matches in `text`, in order -- not just the
// first. Needed because the SAME title can legitimately appear more than
// once in a real book (most concretely: once in a table of contents near
// the front, once again at the chapter's own real starting point) --
// see resolveBoundaries's own comment for why which occurrence is chosen
// matters.
function findAllOccurrences(text: string, candidate: string): number[] {
  const regex = buildHeadingRegex(candidate);
  if (!regex) return [];
  const indices: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    indices.push(match.index);
    // Defensive only -- buildHeadingRegex never produces a pattern that
    // can match an empty string (every candidate has at least one real
    // word), so this never actually fires; it just guards against an
    // infinite loop if that ever stopped being true.
    if (match[0].length === 0) regex.lastIndex++;
  }
  return indices;
}

// Resolves every proposed boundary to a real position in `text`, in the
// SAME order the model returned them (the prompt asks for chapters "in
// the order they appear in the text" -- trusted here specifically to
// decide the ORDER boundaries are searched in, not blindly trusted for
// their final position, which is still only ever the result of finding a
// real occurrence).
//
// Reported live, confirmed directly: independently searching the WHOLE
// text for each heading's FIRST occurrence (the original, simpler
// approach) put 6 of 8 real chapters in the wrong place -- their titles
// also appeared, all clustered together, in the book's own table of
// contents near the front, and the first-occurrence search landed there
// instead of at each chapter's real starting point. Fixed with a
// sequential, cursor-based search instead: every boundary after the first
// successfully-resolved one is searched for starting AFTER the previous
// one's own resolved position (never earlier) -- a real chapter's content
// can't occur before the chapter before it, so this alone rules out
// matching anything in the table of contents (always earlier in the book)
// for every chapter except conceivably the very first.
//
// The FIRST boundary that resolves at all has no earlier boundary to
// anchor past a table of contents with, so it establishes its OWN anchor
// instead: this candidate's own preciseVariants (the full heading, label
// intact) are searched for on their own first, and if that finds
// anything, the LAST such match is treated as roughly where the table of
// contents ends for this candidate -- the same reasoning the original
// "just take the last occurrence overall" rule used, but now applied only
// to the precise tier, before the full (pooled, includes short/generic
// variants) search runs again from just past that anchor. Once genuinely
// past the table of contents, the FIRST remaining match is the real
// heading -- not the last -- since a short/generic pooled variant
// (chapter_title, an aggressively stripped heading) can otherwise ALSO
// match something later still: an immediately-following author-name line,
// or the same short title word recurring later in that chapter's own
// prose. Confirmed live, via a synthetic stress test built while adding
// chapter_title/short-variant pooling: blindly keeping "last occurrence
// overall" once those shorter variants were added let exactly that happen
// -- overshooting past the real heading into a later, wrong line and
// silently truncating the chapter.
//
// The anchor is only trusted when something genuinely remains past it,
// specifically past the full length of the anchoring match, not just its
// start index (a shorter pooled variant can match again as a plain
// SUBSTRING within that same span, which isn't a separate later
// occurrence at all -- confirmed live, this exact self-overlap broke the
// single-chapter/no-table-of-contents case, where the precise tier's one
// match already IS the real heading). When nothing remains, the table of
// contents most likely doesn't separately mention this chapter at all (or
// there isn't one), so this falls back to the original, simpler "last
// occurrence overall" rule, unaffected by any of this. (A recurring
// running header repeating the same title on every page of a LATER
// chapter could in principle still push an anchor-less resolution too far
// forward; accepted as a much smaller, much rarer risk than the table-of-
// contents case this all exists to fix, same as before this file's own
// generalization.)
//
// The heading exactly as given, plus (when LABEL_PREFIX recognizes one) a
// version with an English-style "Lesson N"/"Chapter N:" label stripped --
// the ORIGINAL, pre-generalization variant set. Used on its own, not just
// as part of the full pool below, specifically as a position ANCHOR for
// the very first boundary -- see resolveBoundaries's own comment on why.
function preciseVariants(heading: string): string[] {
  const variants = [heading];
  const withoutLabel = stripLabelPrefix(heading);
  if (withoutLabel) variants.push(withoutLabel);
  return variants;
}

// Every reasonable excerpt worth searching for, POOLED into one combined
// set of occurrences downstream, not tried one at a time stopping at the
// first that finds anything -- deliberately, even though stripLeadingWords's
// own variants are individually less precise than the heading as given.
// Confirmed live: a label-heavy heading (the full TOC-style excerpt, e.g.
// "দ্বিতীয় পাঠ [title] [author]") often matches ONLY inside the table of
// contents itself, never anywhere in the body -- stopping as soon as that
// one (wrong) match was found would never even try the stripped variant
// that finds the real, later occurrence, defeating the very TOC-skip logic
// this whole file exists to get right. Pooling lets every variant's
// matches compete on equal footing; resolveBoundaries's own selection
// rules handle picking the right one out of however many turn up.
//
// Also pools in chapter_title itself, not just excerpts derived from
// heading -- a real book's own titles are sometimes genuinely just one
// word ("একাকারে", "অভিষেক"), too short to reach via stripLeadingWords
// without dropping MIN_REMAINING_WORDS low enough to risk spurious
// matches on ordinary short strings. chapter_title is a DIFFERENT kind of
// signal: the model's own cleaned, deliberate account of the real title
// (with the whole document in view, not a mechanical strip), reported
// separately from heading precisely because it isn't promised to be a
// verbatim excerpt -- so it may simply fail to match at all (a heavily
// "cleaned" title that no longer matches the raw OCR text verbatim), same
// harmless no-op as any other variant that doesn't appear in the text.
function candidateVariants(candidate: { chapterTitle: string; heading: string }): string[] {
  const { chapterTitle, heading } = candidate;
  const variants = [...preciseVariants(heading), chapterTitle];
  for (let strip = 1; strip <= MAX_LEADING_WORDS_STRIPPED; strip++) {
    const stripped = stripLeadingWords(heading, strip);
    if (stripped) variants.push(stripped);
  }
  return variants;
}

// True when `index` is the first character of its own line (a real
// printed heading's own position, virtually always) rather than embedded
// mid-line or mid-sentence. Confirmed live, via a synthetic stress test
// built while verifying this file's own short-variant/chapter_title
// pooling (added once real titles turned out to be too short for
// stripLeadingWords's own word-count floor alone): pooling in a bare,
// generic title (a single word, or one short enough to plausibly recur)
// makes it possible for that SAME word to also appear again later, mid-
// sentence, inside its own chapter's running prose -- and for the very
// first boundary specifically, whose selection rule takes the LAST
// pooled occurrence (see this function's own top comment on why), that
// later, wrong, self-referential mention can outrank the real heading
// entirely, silently truncating the chapter. A genuine chapter heading
// and a table-of-contents entry are both printed on their own line; an
// incidental repeat of the same word inside a paragraph is not -- so this
// is used to prefer occurrences that look like an actual heading over
// ones that merely contain the same text.
function isAtLineStart(text: string, index: number): boolean {
  return index === 0 || text[index - 1] === "\n";
}

// Every occurrence of any of `variants` in `text` at or after `from`, in
// order -- the shared building block both the main pooled search and the
// precise-tier anchor search use.
function occurrencesFrom(text: string, variants: string[], from: number): number[] {
  return variants
    .flatMap((variant) => findAllOccurrences(text, variant))
    .filter((index) => index >= from)
    .sort((a, b) => a - b);
}

// Prefer line-start occurrences when there are any -- see isAtLineStart's
// own comment. Falls back to the unfiltered set when NONE start a line
// (OCR line-wrap noise can genuinely put a real heading's own text mid-
// line), so this can only ever narrow toward a better match, never
// manufacture a brand new "unresolved" failure that wouldn't already have
// happened before this existed.
function preferLineStart(text: string, occurrences: number[]): number[] {
  const lineStart = occurrences.filter((index) => isAtLineStart(text, index));
  return lineStart.length > 0 ? lineStart : occurrences;
}

function resolveBoundaries(
  text: string,
  candidates: { chapterTitle: string; heading: string }[]
): { resolved: { chapterTitle: string; index: number }[]; unresolved: UnresolvedBoundary[] } {
  const resolved: { chapterTitle: string; index: number }[] = [];
  const unresolved: UnresolvedBoundary[] = [];
  let searchFrom = 0;

  for (const candidate of candidates) {
    const isFirstBoundary = resolved.length === 0;
    let occurrences = preferLineStart(text, occurrencesFrom(text, candidateVariants(candidate), searchFrom));
    let useFirst = !isFirstBoundary;

    if (isFirstBoundary) {
      const preciseOccurrences = occurrencesFrom(text, preciseVariants(candidate.heading), searchFrom);
      if (preciseOccurrences.length > 0) {
        // Past the full length of the anchoring match, not just its start
        // index -- see this function's own top comment on why (a shorter
        // pooled variant matching as a plain substring WITHIN that same
        // span is not a separate, later occurrence).
        const anchor = Math.max(...preciseOccurrences) + candidate.heading.length;
        const afterAnchor = preferLineStart(text, occurrencesFrom(text, candidateVariants(candidate), anchor));
        if (afterAnchor.length > 0) {
          occurrences = afterAnchor;
          useFirst = true;
        }
        // else: nothing genuinely remains past the anchor -- keep the
        // original, unanchored `occurrences` and its "last occurrence
        // overall" selection below, unaffected.
      }
    }

    if (occurrences.length === 0) {
      unresolved.push({ chapterTitle: candidate.chapterTitle, heading: candidate.heading });
      continue;
    }

    const index = useFirst ? occurrences[0] : occurrences[occurrences.length - 1];
    resolved.push({ chapterTitle: candidate.chapterTitle, index });
    searchFrom = index + 1;
  }

  return { resolved, unresolved };
}

// The whole point of this file. `text` is the admin-reviewed raw OCR
// output (see the OCR page's own "review this before using it" posture --
// this runs only once an admin has already looked it over, never
// automatically on raw OCR output). Any text before the first resolved
// chapter boundary (front matter, a table of contents, OCR noise ahead of
// the real content) is dropped, same as this app's own established "not
// every byte survives, only the real content" posture elsewhere (e.g.
// off-scope content scanning).
export async function segmentBookIntoChapters(params: { text: string }): Promise<SegmentBookResult> {
  const { data } = await getJsonCompletion({
    systemPrompt: buildBookChapterSegmentationPrompt(),
    message: params.text,
    maxTokens: MAX_TOKENS,
  });

  if (!Array.isArray(data)) {
    return { chunks: [], unresolved: [] };
  }

  const candidates: { chapterTitle: string; heading: string }[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const b = item as Partial<RawBoundary>;
    if (typeof b.chapter_title !== "string" || !b.chapter_title.trim()) continue;
    if (typeof b.heading !== "string" || !b.heading.trim()) continue;
    candidates.push({ chapterTitle: b.chapter_title.trim(), heading: b.heading.trim() });
  }

  const { resolved, unresolved } = resolveBoundaries(params.text, candidates);

  const chunks: BookChapterChunk[] = resolved.map((boundary, i) => {
    const start = boundary.index;
    const end = i + 1 < resolved.length ? resolved[i + 1].index : params.text.length;
    return {
      chapter_number: i + 1,
      chapter_title: boundary.chapterTitle,
      text: params.text.slice(start, end).trim(),
    };
  });

  return { chunks, unresolved };
}
