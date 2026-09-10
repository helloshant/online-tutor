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

export type SegmentBookResult = {
  chunks: BookChapterChunk[];
  // Chapter titles the model proposed but whose own "heading" excerpt
  // couldn't actually be found in the source text (a paraphrase slipped
  // through despite the prompt's own instruction, or a heading spanning
  // an OCR line-break oddly enough that even the whitespace-tolerant
  // search below still misses it) -- surfaced rather than silently
  // dropped, same "fail open per unit, but tell the admin" convention as
  // ocrPipeline.ts's own per-page-range chunkErrors.
  unresolvedChapterTitles: string[];
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Finds `heading`'s real position in `text` -- a plain indexOf first (the
// common case: the model copied it verbatim, as instructed), falling back
// to case-insensitive and whitespace-tolerant variants (in that order) for
// two real, confirmed-live sources of drift between what the model
// returned and the literal source bytes:
//   - CASE: a printed book's own chapter/poem headings are very often
//     rendered in full caps ("SEA FEVER"), but the model's own idea of a
//     "clean" heading -- even asked to copy verbatim -- can still come
//     back title-cased ("Sea Fever"). Confirmed directly: three real
//     poem titles in a live book (Sea Fever, The Cat, The Snail) went
//     unresolved and silently folded into a neighboring chapter's text
//     purely because of this, before case-insensitive matching existed.
//   - WHITESPACE: an OCR line-wrap or a stray double space between the
//     same words (runs of whitespace in `heading` match ANY run of
//     whitespace in `text`).
// Returns -1, never throws, when nothing matches even with both
// tolerances -- the caller reports that boundary as unresolved rather
// than guessing.
function findHeadingIndex(text: string, heading: string): number {
  const trimmed = heading.trim();
  if (!trimmed) return -1;

  const direct = text.indexOf(trimmed);
  if (direct !== -1) return direct;

  const caseInsensitive = text.toLowerCase().indexOf(trimmed.toLowerCase());
  if (caseInsensitive !== -1) return caseInsensitive;

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0) return -1;
  const pattern = words.map(escapeRegExp).join("\\s+");
  const match = new RegExp(pattern, "i").exec(text);
  return match ? match.index : -1;
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
    return { chunks: [], unresolvedChapterTitles: [] };
  }

  const resolved: { chapterTitle: string; index: number }[] = [];
  const unresolvedChapterTitles: string[] = [];

  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const b = item as Partial<RawBoundary>;
    if (typeof b.chapter_title !== "string" || !b.chapter_title.trim()) continue;
    if (typeof b.heading !== "string" || !b.heading.trim()) continue;

    const index = findHeadingIndex(params.text, b.heading);
    if (index === -1) {
      unresolvedChapterTitles.push(b.chapter_title.trim());
      continue;
    }
    resolved.push({ chapterTitle: b.chapter_title.trim(), index });
  }

  // Ordered by where each boundary ACTUALLY occurs in the source text --
  // the model's own output order isn't trusted for this, only the
  // verbatim match found above is (a model can list boundaries out of
  // order without that being a sign anything else is wrong).
  resolved.sort((a, b) => a.index - b.index);

  const chunks: BookChapterChunk[] = resolved.map((boundary, i) => {
    const start = boundary.index;
    const end = i + 1 < resolved.length ? resolved[i + 1].index : params.text.length;
    return {
      chapter_number: i + 1,
      chapter_title: boundary.chapterTitle,
      text: params.text.slice(start, end).trim(),
    };
  });

  return { chunks, unresolvedChapterTitles };
}
