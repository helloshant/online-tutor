// Reactive fallback for Stage 0 (Segmenter) hitting MAX_TOKENS on an
// unusually large paper (see jsonCompletion.ts's finishReason check) --
// splits the raw paper text at boundaries confident enough not to sever a
// shared stem/passage from its own sub-questions (which would reproduce
// the dangling parent_question_id bug this pipeline already had to fix
// once), so Stage 0 can be retried on each piece separately and
// pipelineRunner.ts can merge the results back into one paper's worth of
// SegmentedQuestion records.
//
// Deliberately conservative at every step: a missed boundary just means
// falling back to the next, coarser-or-narrower strategy (or, at the
// bottom, the existing clean "this paper is too large, split it yourself"
// failure) -- a WRONG boundary risks silently corrupting output, which is
// worse than a clean failure.

// Section/part headers -- the coarsest, safest boundary: a shared stem or
// case-based passage never spans two sections in a real exam paper.
// Covers the common English forms ("SECTION A", "SECTION - A", "PART I")
// and the Hindi खण्ड/भाग equivalents CBSE bilingual papers use, capturing
// the label itself so callers can recognize when the "same" section is
// being restated (see normalizeSectionLabel and its own comment below --
// this is the load-bearing part of the whole module).
const SECTION_BOUNDARY =
  /^(?:SECTION|PART)\s*[-–—:]?\s*(?<enLabel>[A-Za-z0-9]+)\b.*$|^(?:खण्ड|खंड|भाग)\s*[-–—:]?\s*(?<hiLabel>\S+?)[.:]?\s*$/gmu;

// CBSE's own five-section convention. An unrecognized Hindi label (a rare
// board/format this hasn't been tested against, or an OCR-mangled
// character) still gets treated as a genuine new boundary via its own
// unique bucket in normalizeSectionLabel below, rather than silently
// dropped -- better to over-split than to risk merging two different real
// sections together.
const HINDI_TO_LATIN_SECTION: Record<string, string> = {
  क: "A",
  ख: "B",
  ग: "C",
  घ: "D",
  ङ: "E",
  च: "F",
  छ: "G",
};

// Top-level question-number boundary: a bare "12." or "12)" at the very
// start of a line. Deliberately does NOT match a sub-part marker like
// "(i)"/"(a)" (those never start with a bare digit run followed
// immediately by "."/")" at the start of a line the way a top-level
// question number does) -- so this only ever splits BETWEEN two
// independent top-level questions, never between a stem and its own
// sub-parts. Used only as the narrower, riskier fallback (see
// splitPaperText below) when a single section is still too large on its
// own -- unlike the section-level split, this CAN sever a bilingual
// paper's Hindi/English pairing if a section's two language halves are
// each individually re-split, since both halves reuse the same numbering.
// Accepted as a rare, recoverable trade-off: Stage 3 (Critic)'s own MERGE
// decision exists precisely to consolidate two archetypes that turn out
// to be the same question in two languages, and a clean failure is the
// alternative to accepting this cost.
const QUESTION_BOUNDARY = /^\d{1,3}[.)]\s+\S/gm;

// Below this, a "boundary" is almost certainly noise (a stray number in
// running text, an OCR artifact) rather than a real structural break --
// merge it into the previous chunk instead of creating a near-empty one.
const MIN_CHUNK_CHARS = 400;

export type SplitStrategy = "section" | "question";
export type SplitResult = { chunks: string[]; strategy: SplitStrategy | "none" };

// A repeat of an already-seen section label -- most commonly a bilingual
// paper's English restatement of a Hindi section it already introduced
// (or vice versa) -- is NOT a new boundary: the whole point is keeping
// one section's Hindi+English content together in a single chunk, since
// splitting them apart would isolate each language's Stage 0 call from
// the other and reintroduce the bilingual-duplicate problem the Segmenter
// prompt's own BILINGUAL / DUAL-LANGUAGE PAPERS rule (see prompts.ts)
// exists to resolve WITHIN one call.
function normalizeSectionLabel(enLabel?: string, hiLabel?: string): string | null {
  if (enLabel) return enLabel.toUpperCase();
  if (hiLabel) {
    const firstChar = hiLabel.trim().charAt(0);
    return HINDI_TO_LATIN_SECTION[firstChar] ?? `HI:${hiLabel.trim()}`;
  }
  return null;
}

function findSectionBoundaries(text: string): number[] {
  const seenLabels = new Set<string>();
  const indices: number[] = [];
  for (const match of text.matchAll(SECTION_BOUNDARY)) {
    if (match.index == null) continue;
    const label = normalizeSectionLabel(match.groups?.enLabel, match.groups?.hiLabel);
    if (!label || seenLabels.has(label)) continue;
    seenLabels.add(label);
    indices.push(match.index);
  }
  return indices;
}

function findQuestionBoundaries(text: string): number[] {
  const indices: number[] = [];
  for (const match of text.matchAll(QUESTION_BOUNDARY)) {
    if (match.index != null) indices.push(match.index);
  }
  return indices;
}

function chunksFromBoundaries(text: string, boundaryIndices: number[]): string[] {
  // Everything before the first boundary (a cover page, general
  // instructions, etc.) is prepended to the first real chunk rather than
  // becoming its own tiny fragment -- it's never independently
  // segmentable, but Stage 0 may still want the context (e.g. total marks
  // stated there).
  const starts = boundaryIndices[0] === 0 ? boundaryIndices : [0, ...boundaryIndices];
  const raw = starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length));

  // Merge any chunk under MIN_CHUNK_CHARS into its predecessor instead of
  // sending a near-empty fragment through its own LLM call.
  const merged: string[] = [];
  for (const chunk of raw) {
    if (merged.length > 0 && chunk.trim().length < MIN_CHUNK_CHARS) {
      merged[merged.length - 1] += chunk;
    } else {
      merged.push(chunk);
    }
  }
  return merged.filter((c) => c.trim().length > 0);
}

// Tries section-level splitting first (coarsest, safest, and the only
// strategy that reliably preserves a bilingual paper's language pairing);
// if that doesn't yield at least two real chunks (no recognizable section
// markers at all, or only one section total), falls back to question-
// number splitting. Returns strategy "none" with the original text
// unchanged when neither strategy finds enough boundaries -- the caller
// treats that as "cannot split further" and lets the existing truncation
// failure surface normally.
export function splitPaperText(text: string): SplitResult {
  const sectionIndices = findSectionBoundaries(text);
  if (sectionIndices.length >= 2) {
    const chunks = chunksFromBoundaries(text, sectionIndices);
    if (chunks.length >= 2) return { chunks, strategy: "section" };
  }

  const questionIndices = findQuestionBoundaries(text);
  if (questionIndices.length >= 2) {
    const chunks = chunksFromBoundaries(text, questionIndices);
    if (chunks.length >= 2) return { chunks, strategy: "question" };
  }

  return { chunks: [text], strategy: "none" };
}
