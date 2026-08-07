"use server";

import crypto from "node:crypto";
import { Workbook, type Image, type Worksheet } from "exceljs";
import { revalidatePath } from "next/cache";
import { requireAdminPage } from "@/lib/auth";
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
}

// scope carries the row's *pre-edit* question (and everything else needed
// to evict the matching cache entry -- see AnswerBankScope) while the new
// question/answer text comes from formData; validation_status is left
// untouched, since editing content an admin is already looking at
// shouldn't silently change its review state the way approve/reject do.
// Answer can be blank, same as bulk import -- a question whose entire
// answer is an attached image has no text answer at all.
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
  const question = ((formData.get("question") as string | null) ?? "").trim();
  const answer = ((formData.get("answer") as string | null) ?? "").trim();
  if (!question) return {};

  const supabase = createAdminClient();
  await supabase.from("answered_questions").update({ question, answer }).eq("id", scope.id);
  // The cache is keyed by question text, so a stale entry under the old
  // phrasing (if the question changed) or the old answer (if just that
  // changed) would otherwise keep being served until its Redis TTL expires
  // on its own -- same reasoning as rejectAnswer.
  await invalidateCachedAnswer(scope);
  revalidatePath("/admin/answer-bank");
  return { success: true };
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

function parseImportBlocks(text: string): { question: string; answer: string }[] {
  // Normalize CRLF/CR up front -- pasting from a Windows-originated source
  // (or through some clipboard managers/editors) can leave "\r\n" line
  // endings, and a stray "\r" sitting right before the separator's "\n"
  // stops the split below from matching there at all, silently swallowing
  // every subsequent block into the answer of whatever came before it.
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n-{3,}\n/);
  const rows: { question: string; answer: string }[] = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;
    if (!QUESTION_PREFIX_PATTERN.test(block)) continue;

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

    if (!question) continue;
    rows.push({ question, answer });
  }

  return rows;
}

// Same threshold the orchestrator's own dedup checks use (answerBank.ts,
// answerValidation-adjacent) -- below this a full-text match is too weak to
// trust as "the same question," and above it, confident enough to skip
// re-inserting.
const MIN_RANK = 0.1;

export interface BulkImportState {
  error?: string;
  success?: {
    imported: number;
    skippedDuplicates: number;
    totalParsed: number;
    importedWithoutAnswer: number;
  };
}

// exceljs's own .d.ts declares an ambient `Buffer extends ArrayBuffer` type
// (not Node's real Buffer, which newer @types/node makes incompatible with
// it structurally) -- derived from Image itself rather than typed as
// `Buffer` here, so this doesn't fight that declaration.
type RowImage = { extension: string; buffer: NonNullable<Image["buffer"]> };

type ParsedImportRow = {
  question: string;
  answer: string;
  tags: string[];
  // Only ever set for a spreadsheet-sourced row (text-paste rows have
  // nothing analogous) -- images embedded in the sheet itself, matched to
  // this row by anchor position. See extractRowImages.
  imageBuffers?: RowImage[];
};

// Shared by both import entry points below (pasted text and spreadsheet
// upload) -- everything from here on (dedup, insert, the returned counts)
// is identical either way; only how `rows` got produced differs. Bulk-
// imported content is admin-curated (a real textbook or exam paper), not
// LLM output -- it skips validateAnswerForStorage entirely (that heuristic
// exists to catch a generated answer hedging or reading like a question
// asked back, neither of which applies to hand-sourced content) and is
// stored admin_approved so it's immediately servable, same trust level as
// manually approving a pending_review entry.
async function importParsedRows(
  rows: ParsedImportRow[],
  scope: { boardId: string; gradeId: string; subjectId: string; medium: Medium; topicId: string | null }
): Promise<BulkImportState> {
  const supabase = createAdminClient();

  // Per-row dedup against whatever's already banked for this board/grade/
  // subject/medium (the same RPC the chat pipeline and exercise generation
  // use for their own dedup checks) -- re-importing the same source a
  // second time (e.g. after fixing a typo elsewhere in it) would otherwise
  // silently pile up duplicate rows forever, since bulk import has no other
  // write-time safeguard the way LLM-generated content does.
  //
  // Each surviving row gets a client-generated id up front, inserted
  // explicitly rather than left to the column's default -- that's what
  // lets any of its images be uploaded to a known storage path right after
  // the insert, without depending on .insert().select() preserving array
  // order (which Postgres/PostgREST don't actually guarantee).
  const toInsert: (ParsedImportRow & { id: string })[] = [];
  let skippedDuplicates = 0;
  for (const row of rows) {
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
    if (data) {
      skippedDuplicates += 1;
      continue;
    }
    toInsert.push({ ...row, id: crypto.randomUUID() });
  }

  if (toInsert.length > 0) {
    const { error } = await supabase.from("answered_questions").insert(
      toInsert.map((r) => ({
        id: r.id,
        board_id: scope.boardId,
        grade_id: scope.gradeId,
        subject_id: scope.subjectId,
        medium: scope.medium,
        topic_id: scope.topicId,
        question: r.question,
        answer: r.answer,
        validation_status: "admin_approved" as const,
        tags: r.tags,
      }))
    );
    if (error) {
      console.error("Bulk import insert failed:", error);
      return { error: "Something went wrong while saving. Please try again." };
    }

    // Uploaded the same way addImage does (its own random path per image
    // under the row's "folder") -- only reachable here, after the row
    // actually exists, since the path is keyed off its id.
    for (const row of toInsert) {
      if (!row.imageBuffers || row.imageBuffers.length === 0) continue;
      const imageUrls: string[] = [];
      for (const img of row.imageBuffers) {
        const path = `${row.id}/${crypto.randomUUID()}`;
        const { error: uploadError } = await supabase.storage
          .from(IMAGE_BUCKET)
          .upload(path, img.buffer, { contentType: `image/${img.extension}` });
        if (uploadError) {
          console.error("Spreadsheet row image upload failed:", uploadError);
          continue;
        }
        const {
          data: { publicUrl },
        } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path);
        imageUrls.push(publicUrl);
      }
      if (imageUrls.length > 0) {
        await supabase.from("answered_questions").update({ image_urls: imageUrls }).eq("id", row.id);
      }
    }
  }

  revalidatePath("/admin/answer-bank");
  return {
    success: {
      imported: toInsert.length,
      skippedDuplicates,
      totalParsed: rows.length,
      importedWithoutAnswer: toInsert.filter((r) => !r.answer).length,
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

  // The two input methods (pasted text vs. a spreadsheet upload) share this
  // one action, distinguished by which of these two fields is actually
  // present, rather than being two separate actions/forms -- the scope
  // fields above are identical for either, and BulkImportForm's toggle just
  // swaps which content input is shown.
  const file = formData.get("file") as File | null;
  if (file && file.size > 0) {
    return importSpreadsheet(file, tags, { boardId, gradeId, subjectId, medium, topicId });
  }

  const text = (formData.get("bulkText") as string | null) ?? "";
  if (!text.trim()) {
    return { error: "Paste some Q:/A: text, or choose a spreadsheet file, to import." };
  }

  const rows = parseImportBlocks(text).map((r) => ({ ...r, tags }));
  if (rows.length === 0) {
    return {
      error:
        'Could not find any "Q: ..." blocks in that text. Check the format and that entries are ' +
        "separated by a line of three or more dashes (---).",
    };
  }

  return importParsedRows(rows, { boardId, gradeId, subjectId, medium, topicId });
}

const ALLOWED_SPREADSHEET_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  // Browsers are inconsistent about the MIME type they report for .xlsx --
  // some send this generic octet-stream type instead, so the actual gate
  // is the .xlsx extension check below, not this set.
  "application/octet-stream",
]);
// Generous for a spreadsheet of banked questions with a handful of
// embedded images -- plain text alone would never come close to this, but
// photos of textbook pages add up fast.
const MAX_SPREADSHEET_BYTES = 20 * 1024 * 1024;

// First row is headers (case-insensitive, any order): "question" (required
// per row), "answer" (optional -- blank means the answer is an image,
// attached afterward the normal way), "tags" (optional, comma-separated
// within the cell, merged with the batch-level tags field rather than
// replacing it -- e.g. every row already gets "Koshe Dekho 3.1" from the
// form, and a few specific rows can add "hard" or "WBJEE 2023" on top). A
// picture inserted (Excel's own Insert > Picture) anywhere within a row --
// doesn't matter which column -- is attached to that row's answer the same
// way addImage attaches one manually, so an image-only answer can be
// pasted straight into the sheet instead of typed out and uploaded later.
async function importSpreadsheet(
  file: File,
  batchTags: string[],
  scope: { boardId: string; gradeId: string; subjectId: string; medium: Medium; topicId: string | null }
): Promise<BulkImportState> {
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    return { error: "Only .xlsx spreadsheet files are supported." };
  }
  if (file.size > MAX_SPREADSHEET_BYTES) {
    return { error: "That file is too large (max 20MB)." };
  }
  if (!ALLOWED_SPREADSHEET_TYPES.has(file.type)) {
    return { error: "That doesn't look like a valid .xlsx file." };
  }

  let rows: ParsedImportRow[];
  try {
    const workbook = new Workbook();
    // exceljs's own .d.ts declares an ambient `Buffer extends ArrayBuffer`
    // type for this parameter (not Node's real Buffer, which newer
    // @types/node makes incompatible with it structurally) -- passing the
    // raw ArrayBuffer directly satisfies that declared type without a
    // pointless Buffer.from() copy in between.
    await workbook.xlsx.load(await file.arrayBuffer());
    const worksheet = workbook.worksheets[0];
    const rowImages = worksheet ? extractRowImages(workbook, worksheet) : new Map<number, RowImage[]>();
    rows = parseSpreadsheetRows(worksheet, batchTags, rowImages);
  } catch (err) {
    console.error("Spreadsheet parse failed:", err);
    return { error: "Could not read that file. Make sure it's a valid, uncorrupted .xlsx spreadsheet." };
  }

  if (rows.length === 0) {
    return {
      error:
        'No rows with a "question" column filled in were found. The first row should have column ' +
        'headers ("question", "answer", "tags") -- "answer" and "tags" are optional per row.',
    };
  }

  return importParsedRows(rows, scope);
}

// Images are floating drawings anchored to a position, not cell values --
// eachRow's per-cell walk below never sees them, so they're extracted in
// this completely separate pass and matched to a data row by anchor
// position instead. Keyed by the same 1-indexed row numbering eachRow
// uses, so parseSpreadsheetRows can look a row's images up directly by its
// own `rowNumber`.
function extractRowImages(workbook: Workbook, worksheet: Worksheet): Map<number, RowImage[]> {
  const byRow = new Map<number, RowImage[]>();

  for (const img of worksheet.getImages()) {
    const media = workbook.getImage(Number(img.imageId));
    if (!media.buffer) continue;
    // Anchor rows are 0-indexed (row 0 is the header row) -- +1 converts to
    // eachRow's 1-indexed numbering. Floored since an image dragged to sit
    // fully inside a row can still have a fractional offset from that
    // row's exact top edge; its top-left corner is what tells us which row
    // it visually belongs to.
    const rowNumber = Math.floor(img.range.tl.row) + 1;
    const list = byRow.get(rowNumber) ?? [];
    list.push({ extension: media.extension, buffer: media.buffer });
    byRow.set(rowNumber, list);
  }

  return byRow;
}

function parseSpreadsheetRows(
  worksheet: Worksheet | undefined,
  batchTags: string[],
  rowImages: Map<number, RowImage[]>
): ParsedImportRow[] {
  if (!worksheet) return [];

  let headers: string[] = [];
  const rows: ParsedImportRow[] = [];

  worksheet.eachRow((row, rowNumber) => {
    const cells = Array.isArray(row.values) ? row.values : [];
    // ExcelJS is 1-indexed (cells[0] is always empty, cells[1] is column A)
    // -- carried through below rather than normalized away, since it's the
    // same indexing `headers` ends up with.
    if (rowNumber === 1) {
      headers = cells.map((v) => (v == null ? "" : String(v).trim().toLowerCase()));
      return;
    }

    const record: Record<string, string> = {};
    headers.forEach((header, i) => {
      if (!header) return;
      const value = cells[i];
      record[header] = value == null ? "" : String(value).trim();
    });

    const question = record.question ?? "";
    // Same requirement as the text-paste format -- "question" is always
    // needed, even for an image-only answer, both because the dedup check
    // matches on question text (a shared placeholder for every image-only
    // row would make the second one onward silently match the first as a
    // false-positive "duplicate" on any later re-import) and because it's
    // what's actually shown as the question everywhere in the app.
    if (!question) return;
    const answer = record.answer ?? "";
    const rowTags = (record.tags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    rows.push({
      question,
      answer,
      tags: Array.from(new Set([...batchTags, ...rowTags])),
      imageBuffers: rowImages.get(rowNumber),
    });
  });

  return rows;
}
