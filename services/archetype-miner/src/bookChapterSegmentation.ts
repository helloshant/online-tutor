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
// sequential, cursor-based search instead:
//   - Every boundary after the first successfully-resolved one is
//     searched for starting AFTER the previous one's own resolved
//     position (never earlier) -- a real chapter's content can't occur
//     before the chapter before it, so this alone rules out matching
//     anything in the table of contents (always earlier in the book) for
//     every chapter except conceivably the very first.
//   - The FIRST boundary that resolves at all has no earlier boundary to
//     anchor past a table of contents with, so it instead takes the LAST
//     matching occurrence in the text from that point on, not the first
//     -- a table of contents mention is virtually always earlier than
//     the real chapter start, so the latest occurrence is the safer
//     choice specifically for this one boundary. (A recurring running
//     header repeating the same title on every page of a LATER chapter
//     could in principle push this too far forward; accepted as a much
//     smaller, much rarer risk than the table-of-contents case this
//     fixes, and only this one boundary ever takes this branch.)
function resolveBoundaries(
  text: string,
  candidates: { chapterTitle: string; heading: string }[]
): { resolved: { chapterTitle: string; index: number }[]; unresolved: UnresolvedBoundary[] } {
  const resolved: { chapterTitle: string; index: number }[] = [];
  const unresolved: UnresolvedBoundary[] = [];
  let searchFrom = 0;

  for (const candidate of candidates) {
    const variants = [candidate.heading];
    const withoutLabel = stripLabelPrefix(candidate.heading);
    if (withoutLabel) variants.push(withoutLabel);

    const occurrences = variants
      .flatMap((variant) => findAllOccurrences(text, variant))
      .filter((index) => index >= searchFrom)
      .sort((a, b) => a - b);

    if (occurrences.length === 0) {
      unresolved.push({ chapterTitle: candidate.chapterTitle, heading: candidate.heading });
      continue;
    }

    const index = resolved.length === 0 ? occurrences[occurrences.length - 1] : occurrences[0];
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
