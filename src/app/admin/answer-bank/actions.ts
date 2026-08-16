"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireAdminPage } from "@/lib/auth";
import { IMAGE_MARKER, IMAGE_PLACEHOLDER_PATTERN } from "@/lib/imageMarker";
import { invalidateCachedAnswer } from "@/lib/orchestratorClient";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Medium } from "@/lib/supabase/types";

// Public bucket created in 0017_answer_bank_image.sql -- see that migration
// for why no storage.objects policy is needed (only this service-role
// client ever writes). Each row gets its own "folder" (storage keys are
// just slash-delimited strings; Supabase Storage has no real directory
// concept) so a row can hold more than one image -- keyed `${id}/${uuid}`
// rather than a name derived from the upload, so two images with the same
// original filename never collide, and deleteAnswer below can clean up
// every image for a row with a single list() + remove().
const IMAGE_BUCKET = "answer-bank-images";

// The scope fields needed to evict the matching Redis entry -- the review
// page already has the full row loaded, so these are passed straight
// through rather than looked up again.
export type AnswerBankScope = {
  id: string;
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: Medium;
  question: string;
};

export async function approveAnswer(id: string) {
  await requireAdminPage("answer_bank");
  const supabase = createAdminClient();
  await supabase.from("answered_questions").update({ validation_status: "admin_approved" }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

export async function rejectAnswer(scope: AnswerBankScope) {
  await requireAdminPage("answer_bank");
  const supabase = createAdminClient();
  await supabase.from("answered_questions").update({ validation_status: "rejected" }).eq("id", scope.id);
  // A rejected answer must stop being served immediately, not whenever its
  // Redis TTL happens to expire.
  await invalidateCachedAnswer(scope);
  revalidatePath("/admin/answer-bank");
}

export interface EditAnswerState {
  success?: boolean;
  // "IMG: ..." references typed in this edit that couldn't be honored --
  // same reasons and same philosophy as bulk import's identical field: the
  // edit still saves, this is just surfaced so a typo is a quick fix
  // rather than a silent no-op.
  unmatchedImageRefs?: string[];
}

// scope carries the row's *pre-edit* question (and everything else needed
// to evict the matching cache entry -- see AnswerBankScope) while the new
// question/answer text comes from formData; validation_status is left
// untouched, since editing content an admin is already looking at
// shouldn't silently change its review state the way approve/reject do.
// Answer can be blank, same as bulk import -- a question whose entire
// answer is an attached image has no text answer at all.
//
// The submitted text can carry two kinds of image reference, both
// resolved to a real IMAGE_MARKER here, in whatever order they actually
// appear (spanning question then answer) -- see the combined regex below
// for why this can't be two separate .replace() passes:
//   - "[IMAGE N]" (IMAGE_PLACEHOLDER_PATTERN) -- repositions the row's
//     existing Nth image (1-based, current image_urls order), which the
//     Edit form's textarea shows this way in the first place specifically
//     because it can neither display nor let someone type
//     IMAGE_MARKER's real, invisible character.
//   - "IMG: filename.png" (IMAGE_LINE_PATTERN, the exact same bulk-import
//     syntax) -- attaches a brand-new file from this form's own picker.
// Any existing image never referenced by an "[IMAGE N]" placeholder is
// preserved as a trailing extra rather than silently dropped -- deletion
// stays the removeImage button's job alone, never an implicit side effect
// of a plain text edit.
//
// Takes (prevState, formData) rather than just (formData) -- unlike every
// other row-level action in this file -- specifically so the client side
// (edit-answer-form.tsx) can drive this through useActionState and see
// when a save actually landed, needed to close the <details> disclosure
// afterward: its open/closed state is native DOM state, not something a
// server re-render can touch on its own, so without this it stays open
// across the post-save refresh and reads as a second edit window popping
// up instead of the row just updating.
export async function editAnswer(
  scope: AnswerBankScope,
  _prevState: EditAnswerState,
  formData: FormData
): Promise<EditAnswerState> {
  await requireAdminPage("answer_bank");
  const rawQuestion = ((formData.get("question") as string | null) ?? "").trim();
  const rawAnswer = ((formData.get("answer") as string | null) ?? "").trim();

  const supabase = createAdminClient();

  const { data: currentRow } = await supabase
    .from("answered_questions")
    .select("image_urls")
    .eq("id", scope.id)
    .single();
  const existingImageUrls: string[] = currentRow?.image_urls ?? [];

  const newFiles = formData.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);
  const filesByName = new Map(newFiles.map((f) => [f.name, f]));

  const usedExistingIndices = new Set<number>();
  const unmatchedImageRefs = new Set<string>();
  type ResolvedMarker = { kind: "existing"; url: string } | { kind: "new"; filename: string };
  const resolvedMarkers: ResolvedMarker[] = [];

  function resolveImageRefs(text: string): string {
    return text.replace(
      COMBINED_IMAGE_REF_PATTERN,
      (_match, placeholderNum: string | undefined, imgNames: string | undefined) => {
        if (placeholderNum !== undefined) {
          const url = existingImageUrls[Number(placeholderNum) - 1];
          if (url === undefined) return ""; // stale/out-of-range reference -- drop silently
          usedExistingIndices.add(Number(placeholderNum) - 1);
          resolvedMarkers.push({ kind: "existing", url });
          return IMAGE_MARKER;
        }
        const list = (imgNames ?? "").split(",").map((n) => n.trim()).filter(Boolean);
        let marker = "";
        for (const filename of list) {
          const file = filesByName.get(filename);
          if (!file || file.size > MAX_IMAGE_BYTES || !ALLOWED_IMAGE_TYPES.has(file.type)) {
            unmatchedImageRefs.add(filename);
            continue;
          }
          resolvedMarkers.push({ kind: "new", filename });
          marker += IMAGE_MARKER;
        }
        return marker;
      }
    );
  }

  const question = resolveImageRefs(rawQuestion);
  const answer = resolveImageRefs(rawAnswer);
  if (!question) return { unmatchedImageRefs: [...unmatchedImageRefs] };

  // Upload every "new" resolved marker, by index into resolvedMarkers
  // rather than push -- same reasoning as bulk import's importParsedRows:
  // uploads run concurrently, so completion order isn't marker order.
  const newMarkerIndices = resolvedMarkers.flatMap((m, i) => (m.kind === "new" ? [i] : []));
  const uploadedUrlByIndex = new Map<number, string>();
  await mapWithConcurrency(newMarkerIndices, 8, async (index) => {
    const entry = resolvedMarkers[index];
    if (entry.kind !== "new") return;
    const file = filesByName.get(entry.filename);
    if (!file) return; // already validated present in resolveImageRefs above
    const path = `${scope.id}/${crypto.randomUUID()}`;
    const { error: uploadError } = await supabase.storage
      .from(IMAGE_BUCKET)
      .upload(path, file, { contentType: file.type });
    if (uploadError) {
      console.error("Edit image upload failed:", uploadError);
      unmatchedImageRefs.add(entry.filename);
      return;
    }
    const {
      data: { publicUrl },
    } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path);
    uploadedUrlByIndex.set(index, publicUrl);
  });

  // Resolves each marker to its final URL in order, dropping one whose
  // upload genuinely failed (rare) -- same accepted rough edge as bulk
  // import: that one marker's slot just renders nothing rather than
  // shifting every later image out of place.
  const resolvedUrls: string[] = [];
  resolvedMarkers.forEach((entry, i) => {
    if (entry.kind === "existing") {
      resolvedUrls.push(entry.url);
      return;
    }
    const url = uploadedUrlByIndex.get(i);
    if (url) resolvedUrls.push(url);
  });
  const preservedTrailing = existingImageUrls.filter((_, i) => !usedExistingIndices.has(i));
  const imageUrls = [...resolvedUrls, ...preservedTrailing];

  await supabase.from("answered_questions").update({ question, answer, image_urls: imageUrls }).eq("id", scope.id);
  // The cache is keyed by question text, so a stale entry under the old
  // phrasing (if the question changed) or the old answer (if just that
  // changed) would otherwise keep being served until its Redis TTL expires
  // on its own -- same reasoning as rejectAnswer.
  await invalidateCachedAnswer(scope);
  revalidatePath("/admin/answer-bank");
  return { success: true, unmatchedImageRefs: [...unmatchedImageRefs] };
}

// Undoes an approve/reject decision back to the implicit-validation default,
// so a mistaken click isn't permanent. No cache eviction needed here -- an
// auto_approved row is servable again, and the next matching question just
// repopulates the cache from the database as usual.
export async function restoreAnswer(id: string) {
  await requireAdminPage("answer_bank");
  const supabase = createAdminClient();
  await supabase.from("answered_questions").update({ validation_status: "auto_approved" }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

export async function deleteAnswer(scope: AnswerBankScope) {
  await requireAdminPage("answer_bank");
  const supabase = createAdminClient();

  // Otherwise every attached image would be orphaned in storage forever
  // once the row itself is gone -- list() rather than reading image_urls
  // off the row, since this only needs the storage keys (all under this
  // row's own "folder"), not the public URLs.
  const { data: files } = await supabase.storage.from(IMAGE_BUCKET).list(scope.id);
  if (files && files.length > 0) {
    await supabase.storage.from(IMAGE_BUCKET).remove(files.map((f) => `${scope.id}/${f.name}`));
  }

  await supabase.from("answered_questions").delete().eq("id", scope.id);
  await invalidateCachedAnswer(scope);
  revalidatePath("/admin/answer-bank");
}

// Read-then-write rather than a Postgres array_append/remove RPC -- this is
// an admin-only tool with effectively no concurrent-edit risk, so the extra
// round trip is a fine trade for not needing two more RPCs.
export async function addTag(id: string, formData: FormData) {
  await requireAdminPage("answer_bank");
  const tag = ((formData.get("tag") as string | null) ?? "").trim();
  if (!tag) return;

  const supabase = createAdminClient();
  const { data } = await supabase.from("answered_questions").select("tags").eq("id", id).single();
  const tags = Array.from(new Set([...(data?.tags ?? []), tag]));
  await supabase.from("answered_questions").update({ tags }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

export async function removeTag(id: string, tag: string) {
  await requireAdminPage("answer_bank");
  const supabase = createAdminClient();
  const { data } = await supabase.from("answered_questions").select("tags").eq("id", id).single();
  const tags = (data?.tags ?? []).filter((t: string) => t !== tag);
  await supabase.from("answered_questions").update({ tags }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
// Well under Supabase Storage's own limits -- a textbook page photo doesn't
// need to be huge to be legible, and this keeps upload latency reasonable
// on the admin's connection.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// Silently no-ops on an invalid/missing file, same philosophy as addTag
// above (a simple per-row action with no dedicated feedback UI) -- there's
// no useActionState wired up for this row-level form, so there's nowhere to
// surface an error message anyway. Read-then-write and appends rather than
// replaces (same pattern as addTag) -- a row can accumulate several images
// "one after another" instead of each upload overwriting the last.
export async function addImage(id: string, formData: FormData) {
  await requireAdminPage("answer_bank");
  const file = formData.get("image") as File | null;
  if (!file || file.size === 0 || file.size > MAX_IMAGE_BYTES || !ALLOWED_IMAGE_TYPES.has(file.type)) {
    return;
  }

  const supabase = createAdminClient();
  const path = `${id}/${crypto.randomUUID()}`;
  const { error: uploadError } = await supabase.storage
    .from(IMAGE_BUCKET)
    .upload(path, file, { contentType: file.type });
  if (uploadError) {
    console.error("Answer bank image upload failed:", uploadError);
    return;
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path);

  const { data } = await supabase.from("answered_questions").select("image_urls").eq("id", id).single();
  const imageUrls = [...(data?.image_urls ?? []), publicUrl];
  await supabase.from("answered_questions").update({ image_urls: imageUrls }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

// imageUrl identifies which of the row's (possibly several) images to
// remove -- both from the array and from storage, by recovering the
// storage path from the tail of its public URL.
export async function removeImage(id: string, imageUrl: string) {
  await requireAdminPage("answer_bank");
  const supabase = createAdminClient();

  const { data } = await supabase.from("answered_questions").select("image_urls").eq("id", id).single();
  const imageUrls = (data?.image_urls ?? []).filter((url: string) => url !== imageUrl);
  await supabase.from("answered_questions").update({ image_urls: imageUrls }).eq("id", id);

  const marker = `/object/public/${IMAGE_BUCKET}/`;
  const markerIndex = imageUrl.indexOf(marker);
  if (markerIndex >= 0) {
    await supabase.storage.from(IMAGE_BUCKET).remove([imageUrl.slice(markerIndex + marker.length)]);
  }
  revalidatePath("/admin/answer-bank");
}

// Same Q:/A:/--- block format the orchestrator's exercise generation uses
// (services/orchestrator/src/exerciseParser.ts) -- deliberately duplicated
// rather than shared, same as every other type/parser this web app
// mirrors from the orchestrator, since the two are independently deployed
// packages with no shared code path. "A:" is optional -- a question whose
// entire answer is a diagram/handwritten working (image-only, no text) is
// imported with an empty answer, then the admin attaches the image(s)
// afterward via addImage on that row in the main list.
const QUESTION_PREFIX_PATTERN = /^Q:\s*/i;
// Not anchored to the very start of the remaining text (unlike
// QUESTION_PREFIX_PATTERN) -- it's searched for anywhere via .match() below,
// which is what lets a multi-line question be told apart from a one-line
// question with no answer at all: a lazy quantifier with an *optional*
// "\nA:" suffix would instead just stop at the block's first line break
// (its earliest opportunity to satisfy $ in multiline mode) whenever no
// "A:" line is present, silently truncating anything after it.
const ANSWER_LINE_PATTERN = /\r?\n^A:\s*/im;

export type ParsedImportRow = { question: string; answer: string; imageFilenames: string[] };

// An "IMG: file1.png, file2.png" line lets one block reference the diagram(s)
// that go with it out of a separate multi-file picker (matched by filename,
// not position -- far more robust than the spreadsheet import's old
// cell-anchor-based matching, and doesn't depend on any particular file
// order). Replaced in place with one IMAGE_MARKER per filename listed
// (rather than deleted outright) -- wherever the line sat in the block,
// that's exactly where its image(s) should render, e.g. right after one
// sub-part's solution and before the next one's, not always trailing at
// the end of the whole answer. A render pass (text-with-inline-images.tsx)
// splits on the marker to place each image back where its line was.
const IMAGE_LINE_PATTERN = /^[ \t]*IMG:\s*(.+)$/gim;

// editAnswer's two accepted image references, combined into one pattern so
// a single .replace() pass resolves them in true left-to-right document
// order -- two separate passes (all "[IMAGE N]" first, then all "IMG:"
// lines) would get that order wrong whenever the two are interleaved in
// the same field. Built from .source rather than written out again, so
// the two patterns this has to stay in sync with can't quietly drift.
const COMBINED_IMAGE_REF_PATTERN = new RegExp(
  `${IMAGE_PLACEHOLDER_PATTERN.source}|${IMAGE_LINE_PATTERN.source}`,
  "gim"
);

function parseBlock(rawBlock: string): ParsedImportRow | null {
  const imageFilenames: string[] = [];
  const withoutImageLines = rawBlock.replace(IMAGE_LINE_PATTERN, (_match, names: string) => {
    const list = names.split(",").map((n) => n.trim()).filter(Boolean);
    imageFilenames.push(...list);
    return IMAGE_MARKER.repeat(list.length);
  });

  const block = withoutImageLines.trim();
  if (!block) return null;
  if (!QUESTION_PREFIX_PATTERN.test(block)) return null;

  const withoutPrefix = block.replace(QUESTION_PREFIX_PATTERN, "");
  const answerMatch = withoutPrefix.match(ANSWER_LINE_PATTERN);

  let question: string;
  let answer: string;
  if (answerMatch && answerMatch.index !== undefined) {
    question = withoutPrefix.slice(0, answerMatch.index).trim();
    answer = withoutPrefix.slice(answerMatch.index + answerMatch[0].length).trim();
  } else {
    question = withoutPrefix.trim();
    answer = "";
  }

  if (!question) return null;
  return { question, answer, imageFilenames };
}

function parseImportBlocks(text: string): ParsedImportRow[] {
  // Normalize CRLF/CR up front -- pasting from a Windows-originated source
  // (or through some clipboard managers/editors) can leave "\r\n" line
  // endings, and a stray "\r" sitting right before the separator's "\n"
  // stops the split below from matching there at all, silently swallowing
  // every subsequent block into the answer of whatever came before it.
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Tolerates a trailing (or leading) space/tab on the "---" line itself --
  // a mobile keyboard or some clipboard managers can leave one there, and
  // without this the *entire* paste (every "---" line, not just one)
  // silently fails to split at all, merging everything into one block that
  // then either gets rejected outright (doesn't start with "Q:") or, worse,
  // imported as a single giant garbled question if it happens to.
  const blocks = normalized.split(/\n[ \t]*-{3,}[ \t]*\n/);
  const rows: ParsedImportRow[] = [];

  for (const rawBlock of blocks) {
    const row = parseBlock(rawBlock);
    if (row) rows.push(row);
  }

  return rows;
}

// Same threshold the orchestrator's own dedup checks use (answerBank.ts,
// answerValidation-adjacent) -- below this a full-text match is too weak to
// trust as "the same question," and above it, confident enough to skip
// re-inserting.
const MIN_RANK = 0.1;

// search_answer_bank's dedup is scoped entirely to `question` text, which is
// the right call for its primary use (the orchestrator matching a student's
// live question against banked ones, where there's no answer to compare
// yet). But bulk-imported MCQ blocks are often structured as a generic,
// per-chapter-recurring heading -- e.g. "১১. বহু বিকল্পীয় প্রশ্ন (M.C.Q.)" --
// with all the actual distinguishing content pushed into the answer. Two
// different chapters that happen to number their MCQ section the same way
// then collide as a false-positive full-text match on `question` alone, even
// though their `answer` content is completely unrelated. This re-checks the
// candidate against the *answer* text of whatever row search_answer_bank
// matched (already returned by that RPC, just previously unused beyond
// truthiness) before trusting the match.
function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

// Jaccard similarity (intersection over union) of the two answers' word-
// token sets. Calibrated against real colliding rows from this bank: two
// genuinely different MCQ answer sets scored 0.28 (shared boilerplate like
// "উত্তর: (a)/(b)/(c)/(d)" alone gets you most of the way there), while a
// true duplicate (verbatim or lightly reworded) scored 1.0 -- 0.5 sits
// cleanly between the two with room either side.
function answerSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

const MIN_ANSWER_SIMILARITY = 0.5;

export interface BulkImportState {
  error?: string;
  success?: {
    imported: number;
    skippedDuplicates: number;
    totalParsed: number;
    importedWithoutAnswer: number;
    imagesAttached: number;
    // "IMG: ..." references that couldn't be honored -- no file with that
    // exact name was in the picker, or it existed but failed the same
    // type/size check addImage applies. Surfaced by name rather than just a
    // count so a typo is a two-second fix instead of a re-read of the
    // whole import.
    unmatchedImageRefs: string[];
  };
}

function countOccurrences(text: string, char: string): number {
  let count = 0;
  for (const ch of text) if (ch === char) count++;
  return count;
}

// Single pass so removing several ordinals from the same string can't shift
// the ordinal numbering out from under a later removal the way calling this
// once per ordinal would.
function stripMarkersAt(text: string, ordinalsToRemove: Set<number>): string {
  if (ordinalsToRemove.size === 0) return text;
  let ordinal = -1;
  let result = "";
  for (const ch of text) {
    if (ch === IMAGE_MARKER) {
      ordinal++;
      if (ordinalsToRemove.has(ordinal)) continue;
    }
    result += ch;
  }
  return result;
}

// Runs `fn` over `items` with at most `limit` in flight at once. A plain
// sequential loop here was, by far, the slowest part of a several-hundred-
// row import (one Postgres round trip per row, one after another); firing
// them all via a bare Promise.all instead would open as many concurrent
// connections as there are rows, which doesn't scale the same way. This is
// the middle ground -- meaningfully faster without hammering the database.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Shared by both import entry points below (pasted text and an uploaded
// .txt file) -- everything from here on (dedup, image matching, insert, the
// returned counts) is identical regardless; only how `rows` got produced
// differs. Bulk-imported content is admin-curated (a
// real textbook or exam paper), not LLM output -- it skips
// validateAnswerForStorage entirely (that heuristic exists to catch a
// generated answer hedging or reading like a question asked back, neither
// of which applies to hand-sourced content) and is stored admin_approved so
// it's immediately servable, same trust level as manually approving a
// pending_review entry.
async function importParsedRows(
  rows: ParsedImportRow[],
  tags: string[],
  scope: { boardId: string; gradeId: string; subjectId: string; medium: Medium; topicId: string | null },
  imageFiles: File[]
): Promise<BulkImportState> {
  const supabase = createAdminClient();

  // Per-row dedup against whatever's already banked for this board/grade/
  // subject/medium (the same RPC the chat pipeline and exercise generation
  // use for their own dedup checks) -- re-importing the same source a
  // second time (e.g. after fixing a typo elsewhere in it) would otherwise
  // silently pile up duplicate rows forever, since bulk import has no other
  // write-time safeguard the way LLM-generated content does.
  const isDuplicate = await mapWithConcurrency(rows, 8, async (row) => {
    const { data, error } = await supabase
      .rpc("search_answer_bank", {
        p_board_id: scope.boardId,
        p_grade_id: scope.gradeId,
        p_subject_id: scope.subjectId,
        p_medium: scope.medium,
        p_query: row.question,
        p_min_rank: MIN_RANK,
      })
      .maybeSingle();

    if (error) {
      // Fail open, same philosophy as every other answer-bank lookup in
      // this app -- a broken dedup check shouldn't block the import, it
      // should just risk an occasional duplicate instead.
      console.error("Bulk import dedup check failed:", error);
    }
    if (!data) return false;
    // A question-text match alone isn't enough -- see answerSimilarity's
    // comment above. Only trust it as a real duplicate once the matched
    // row's answer content actually overlaps with this one too.
    return answerSimilarity(data.answer ?? "", row.answer) >= MIN_ANSWER_SIMILARITY;
  });

  const toInsert = rows.filter((_row, i) => !isDuplicate[i]);
  const skippedDuplicates = rows.length - toInsert.length;

  // Each row gets its id assigned here rather than left to insert()'s
  // default, so an image can be uploaded to its final "${id}/${uuid}"
  // storage path (the same convention addImage uses) and included in the
  // very same insert -- no separate update pass needed once the row
  // exists, and no window where the row is briefly imageless.
  type InsertRow = ParsedImportRow & { id: string; imageUrls: (string | null)[] };
  const withIds: InsertRow[] = toInsert.map((r) => ({ ...r, id: crypto.randomUUID(), imageUrls: [] }));

  // Images are matched to a row by filename (from that block's "IMG:"
  // line), against whatever was actually included in the multi-file
  // picker -- not by upload order or position, which is exactly the
  // fragile matching the old spreadsheet-embedded-image import relied on
  // and this replaces.
  const filesByName = new Map(imageFiles.filter((f) => f.size > 0).map((f) => [f.name, f]));
  const unmatchedImageRefs = new Set<string>();
  let imagesAttached = 0;

  // A reference that can't be resolved to a real, valid file (typo, or a
  // file left out of the picker) is decided synchronously, before any
  // upload -- so its IMAGE_MARKER can be stripped from the row's text
  // right away, keeping "marker count" and "final image_urls length"
  // exactly aligned for the inline-placement render pass. Uploads for the
  // remaining, resolved filenames run concurrently below and are assigned
  // by index (not pushed), since completion order isn't submission order
  // and a multi-image row needs its images to land in the same order its
  // markers appear in the text.
  const uploadTasks: { row: InsertRow; index: number; filename: string; file: File }[] = [];
  for (const row of withIds) {
    const questionMarkerCount = countOccurrences(row.question, IMAGE_MARKER);
    const removeOrdinals: number[] = [];
    const matchedFilenames: string[] = [];

    row.imageFilenames.forEach((filename, ordinal) => {
      const file = filesByName.get(filename);
      if (!file || file.size > MAX_IMAGE_BYTES || !ALLOWED_IMAGE_TYPES.has(file.type)) {
        unmatchedImageRefs.add(filename);
        removeOrdinals.push(ordinal);
        return;
      }
      matchedFilenames.push(filename);
    });

    if (removeOrdinals.length > 0) {
      const removeSet = new Set(removeOrdinals);
      const questionRemove = new Set([...removeSet].filter((o) => o < questionMarkerCount));
      const answerRemove = new Set(
        [...removeSet].filter((o) => o >= questionMarkerCount).map((o) => o - questionMarkerCount)
      );
      row.question = stripMarkersAt(row.question, questionRemove);
      row.answer = stripMarkersAt(row.answer, answerRemove);
    }

    row.imageUrls = new Array(matchedFilenames.length).fill(null);
    matchedFilenames.forEach((filename, index) => {
      const file = filesByName.get(filename);
      if (file) uploadTasks.push({ row, index, filename, file });
    });
  }

  await mapWithConcurrency(uploadTasks, 8, async ({ row, index, filename, file }) => {
    const path = `${row.id}/${crypto.randomUUID()}`;
    const { error: uploadError } = await supabase.storage
      .from(IMAGE_BUCKET)
      .upload(path, file, { contentType: file.type });
    if (uploadError) {
      console.error("Bulk import image upload failed:", uploadError);
      // A rare, genuine upload failure (as opposed to the synchronous
      // "no matching file" case above) leaves this one marker in the text
      // with no image behind it -- the render side treats that slot as
      // simply empty rather than erroring, so this degrades gracefully
      // instead of breaking the page.
      unmatchedImageRefs.add(filename);
      return;
    }
    const {
      data: { publicUrl },
    } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path);
    row.imageUrls[index] = publicUrl;
    imagesAttached += 1;
  });

  if (withIds.length > 0) {
    const { error } = await supabase.from("answered_questions").insert(
      withIds.map((r) => ({
        id: r.id,
        board_id: scope.boardId,
        grade_id: scope.gradeId,
        subject_id: scope.subjectId,
        medium: scope.medium,
        topic_id: scope.topicId,
        question: r.question,
        answer: r.answer,
        validation_status: "admin_approved" as const,
        tags,
        // Compacts away any null left by a rare mid-upload failure (as
        // opposed to a synchronously-unmatched filename, whose marker was
        // already stripped from question/answer above and so never left a
        // gap here to begin with).
        image_urls: r.imageUrls.filter((u): u is string => u !== null),
      }))
    );
    if (error) {
      console.error("Bulk import insert failed:", error);
      return { error: "Something went wrong while saving. Please try again." };
    }
  }

  revalidatePath("/admin/answer-bank");
  return {
    success: {
      imported: withIds.length,
      skippedDuplicates,
      totalParsed: rows.length,
      importedWithoutAnswer: withIds.filter((r) => !r.answer).length,
      imagesAttached,
      unmatchedImageRefs: [...unmatchedImageRefs],
    },
  };
}

export async function bulkImportAnswers(
  _prevState: BulkImportState,
  formData: FormData
): Promise<BulkImportState> {
  await requireAdminPage("answer_bank");

  const boardId = formData.get("boardId") as string | null;
  const gradeId = formData.get("gradeId") as string | null;
  const subjectId = formData.get("subjectId") as string | null;
  const medium = formData.get("medium") as Medium | null;
  const topicId = (formData.get("topicId") as string | null) || null;
  const tags = ((formData.get("tags") as string | null) ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (!boardId || !gradeId || !subjectId || !medium) {
    return { error: "Board, grade, subject, and medium are all required." };
  }

  const scope = { boardId, gradeId, subjectId, medium, topicId };

  // One multi-file picker regardless of content source below -- each image
  // is matched to a row by its own "IMG:" reference (see parseBlock), not
  // by which mode the form happened to be in.
  const imageFiles = formData.getAll("images").filter((f): f is File => f instanceof File);

  // Two ways to supply the actual Q:/A: content, distinguished by which of
  // these fields is actually present -- the scope fields and image picker
  // above are identical regardless. A .txt upload takes priority over the
  // textarea when both are present -- it exists specifically for a paste
  // too large to comfortably type/edit in a browser textarea, so if it's
  // there, it's the intended source.
  const textFile = formData.get("textFile") as File | null;
  let text: string;
  if (textFile && textFile.size > 0) {
    if (!textFile.name.toLowerCase().endsWith(".txt")) {
      return { error: "Only .txt files are supported for the text upload." };
    }
    if (textFile.size > MAX_TEXT_FILE_BYTES) {
      return { error: "That file is too large (max 5MB of text)." };
    }
    text = await textFile.text();
  } else {
    text = (formData.get("bulkText") as string | null) ?? "";
  }

  if (!text.trim()) {
    return { error: "Paste some Q:/A: text, or upload a .txt file, to import." };
  }

  const rows = parseImportBlocks(text);
  if (rows.length === 0) {
    return {
      error:
        'Could not find any "Q: ..." blocks in that text. Check the format and that entries are ' +
        "separated by a line of three or more dashes (---).",
    };
  }

  return importParsedRows(rows, tags, scope, imageFiles);
}

const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
