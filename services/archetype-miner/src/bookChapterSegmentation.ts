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

// Reported live: a real (cleaned, back-matter-trimmed) book blew Azure
// OpenAI's gpt-4o context window in one call: "maximum context length is
// 128000 tokens... your messages resulted in 138341 tokens" for a text
// whose own JS string .length (UTF-16 code units -- what this constant is
// compared against, same unit `text.length` uses everywhere else in this
// file) was only 237,808 -- ~1.72 characters per token. Bengali text is
// genuinely this token-DENSE (nowhere near the "~4 characters per token"
// rule of thumb that holds for plain English); an earlier version of this
// constant was sized against the wrong unit (this same text's BYTE length,
// 611,139, not its JS character length) and would have kept failing.
// Targets a comfortable ~70,000 input tokens per chunk at that same
// density (128K minus real margin for the system prompt, MAX_TOKENS's own
// output budget, and whichever LLM provider -- see llm.ts -- ends up
// serving the call; Anthropic's own context window is comfortably larger,
// so this is sized for the tightest supported provider, not the average
// one), rounded down for safety against an even more token-dense book.
const MAX_CHUNK_CHARS = 120_000;

// A small overlap between consecutive chunks so a heading whose own
// surrounding context (an author byline, an opening line confirming it's
// a real heading and not a stray title mention) would otherwise land
// right at a chunk's own cut point still has a decent chance of being
// recognized as a heading by at least one of the two chunks that see it.
// Harmless if a chapter genuinely gets proposed by both chunks it
// straddles -- resolveBoundaries's own sequential search naturally treats
// a repeat candidate as a no-op (nothing new left to find once the first
// occurrence already consumed it), not a duplicate chapter.
const CHUNK_OVERLAP_CHARS = 4_000;

// A book's own front matter -- title page, any table of contents or
// index -- sits at the very start of its text, which lands in chunk 1
// only. buildBookChapterSegmentationPrompt() explicitly tells the model
// to use exactly that kind of index as authoritative for chapter count
// and names when one is present, but a later chunk (covering, say, the
// back half of a 100+ page book) never sees it at all under plain
// splitTextIntoChunks -- confirmed live: a History textbook's own
// QR-code chapter index sits on its first two pages, and chapters
// covered by later chunks resolved inconsistently (some correctly split
// per the index, some merged together, some split by every internal
// sub-heading) exactly where that index wasn't available to compare
// against, while chapters in the same chunk as the index behaved
// correctly. Re-including this fixed excerpt in every chunk keeps the
// index available throughout, not just to whichever chunk happens to
// start at page 1. Sized generously above what a title page + index
// table actually runs (a few thousand characters, confirmed against the
// same History textbook) -- a book with no such front matter just pays
// a harmless few thousand extra input characters per non-first chunk.
const FRONT_MATTER_CHARS = 6_000;

// How far back from a target split point to look for a real line break to
// split on, rather than slicing mid-line/mid-word -- keeps a chunk's own
// trailing/leading text readable to the model instead of starting or
// ending on a fragment. Falls back to a hard cut at the target itself
// when nothing turns up within this window (only possible for a pathological
// input with no line breaks at all across a very long stretch).
const SPLIT_SEARCH_WINDOW = 2_000;

// Splits `text` into sequential, slightly-overlapping windows, each at
// most `maxChars` -- mirrors the vision-ocr service's own pdfPaging.ts
// (splitting a whole book past ONE service's own request-size ceiling is
// an already-established pattern in this codebase, just a different
// ceiling: an LLM's context window here instead of Document AI's request
// size there). Returns a single-element array unchanged when `text`
// already fits, so a normal-sized book pays no extra cost or behavior
// change from this existing before.
function splitTextIntoChunks(text: string, maxChars: number, overlapChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      // Prefer splitting at the last line break within SPLIT_SEARCH_WINDOW
      // of the target end, searching backward from it.
      const searchFrom = Math.max(start, end - SPLIT_SEARCH_WINDOW);
      const lastBreak = text.lastIndexOf("\n", end);
      if (lastBreak > searchFrom) end = lastBreak + 1;
    }
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}

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

// Tolerated between two of `candidate`'s own words IN ADDITION TO plain
// whitespace -- a single stray hyphen/dash/bullet-style character,
// itself surrounded by whitespace, exactly the shape a line-wrapped OCR
// separator leaves behind. Confirmed live: a heading printed in the
// source as "Topic - Subtopic" line-wrapped across three OCR lines as
// "Topic" / "-" / "Subtopic" -- the model's own heading excerpt (reasonably)
// didn't include that stranded "-" as one of its own words, so the plain
// \s+-only join below could never match across it, and this chapter's
// entire boundary silently failed to resolve. OPTIONAL, so this can only
// ever match something a stricter join already matched too -- ordinary
// word-to-word whitespace with no such character present still matches
// exactly as before.
const JUNK_BETWEEN_WORDS = "\\s+(?:[-\u2010-\u2015*\u2022]\\s+)?";

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
  return new RegExp(words.map(escapeRegExp).join(JUNK_BETWEEN_WORDS), "gi");
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

// Parses one LLM call's own raw `data` into candidates, same validation
// every chunk's response goes through -- factored out so segmentBookIntoChapters
// can call it once per chunk without repeating the shape-checking inline.
function parseCandidates(data: unknown): { chapterTitle: string; heading: string }[] {
  if (!Array.isArray(data)) return [];
  const candidates: { chapterTitle: string; heading: string }[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const b = item as Partial<RawBoundary>;
    if (typeof b.chapter_title !== "string" || !b.chapter_title.trim()) continue;
    if (typeof b.heading !== "string" || !b.heading.trim()) continue;
    candidates.push({ chapterTitle: b.chapter_title.trim(), heading: b.heading.trim() });
  }
  return candidates;
}

// Chunk 0 (and the only chunk, for a book that fits in one call) already
// starts at the book's own front matter, so it's sent unwrapped. Every
// later chunk gets that front matter re-attached as a clearly-marked
// reference block ahead of its own real text (see FRONT_MATTER_CHARS's
// own comment for why) -- explicitly told it's reference-only so the
// model doesn't propose a boundary from inside it, which would resolve
// to the wrong position (the front matter, not wherever this chunk
// actually starts) once boundary resolution runs against the real text.
function buildChunkMessage(fullText: string, textChunk: string, chunkIndex: number): string {
  if (chunkIndex === 0) return textChunk;
  const frontMatter = fullText.slice(0, FRONT_MATTER_CHARS);
  return (
    "REFERENCE ONLY -- this is the book's own front matter (title page, " +
    "table of contents, or index), included so you can use it exactly as " +
    "the ROLE/TASK instructions describe, even though this chunk itself " +
    "picks up partway through the book. Do NOT propose a chapter boundary " +
    "from anywhere in this reference block -- it is not part of the text " +
    "you are segmenting.\n\n" +
    frontMatter +
    "\n\n--- END OF REFERENCE. The text below is what you are actually segmenting. ---\n\n" +
    textChunk
  );
}

// The whole point of this file. `text` is the admin-reviewed raw OCR
// output (see the OCR page's own "review this before using it" posture --
// this runs only once an admin has already looked it over, never
// automatically on raw OCR output). Any text before the first resolved
// chapter boundary (front matter, a table of contents, OCR noise ahead of
// the real content) is dropped, same as this app's own established "not
// every byte survives, only the real content" posture elsewhere (e.g.
// off-scope content scanning).
//
// A real book can comfortably exceed a single LLM call's own context
// window (see MAX_CHUNK_CHARS's own comment for the live report that
// motivated this) -- split first, always, same "predictable cost, never a
// guaranteed-failing call first" posture pdfPaging.ts already established
// for Document AI's own request-size ceiling. Every chunk is asked to
// propose boundaries independently (each chunk stands in for "the text"
// as far as that one call is concerned), but boundary RESOLUTION still
// runs exactly once, against the whole original `text` -- never per
// chunk -- so a heading proposed from deep in a later chunk still gets
// the SAME real-position search, same table-of-contents-skip, and same
// sequential ordering guarantees as a normal, single-call run.
//
// One chunk's own LLM call failing (a parse error surviving all of
// getJsonCompletion's own retries, a truncated response) is logged and
// skipped, not a hard failure for the whole request -- this codebase's
// established "fail open per unit of work" convention (see ocrPipeline.ts's
// own per-page-range chunkErrors): whatever chapters that one chunk would
// have proposed are simply missing from the result, same as if the model
// itself had missed them, rather than losing every OTHER chunk's already-
// successful work too.
export async function segmentBookIntoChapters(params: { text: string }): Promise<SegmentBookResult> {
  const textChunks = splitTextIntoChunks(params.text, MAX_CHUNK_CHARS, CHUNK_OVERLAP_CHARS);

  const candidates: { chapterTitle: string; heading: string }[] = [];
  for (const [i, textChunk] of textChunks.entries()) {
    try {
      const { data } = await getJsonCompletion({
        systemPrompt: buildBookChapterSegmentationPrompt(),
        message: buildChunkMessage(params.text, textChunk, i),
        maxTokens: MAX_TOKENS,
      });
      candidates.push(...parseCandidates(data));
    } catch (err) {
      console.error(`Book chapter segmentation failed for chunk ${i + 1} of ${textChunks.length}:`, err);
    }
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
