"use server";

import { requireAdminPage } from "@/lib/auth";
import { runVisionOcr, type VisionOcrMimeType } from "@/lib/visionOcrClient";
import { segmentBookIntoChapters, type BookChapterChunk, type UnresolvedBookBoundary } from "@/lib/archetypeMinerClient";

// A whole scanned BOOK, not just a paper -- raised from the 20MB single-
// file cap this page started with (sized for a short exam paper) once "OCR
// a scanned paper" grew into "OCR a scanned paper or book": a real full
// book scan (100+ pages) can comfortably run well past that. The
// vision-ocr service's own pipeline already copes with a file this size --
// see that service's pdfPaging.ts, which now also splits a PDF page-range
// chunk further whenever its OWN size would still exceed Document AI's
// synchronous request-content limit, not just its page-count limit.
// Matches next.config.ts's own serverActions.bodySizeLimit/
// proxyClientMaxBodySize (raised alongside this) so neither side is the
// tighter constraint for a single large upload.
const MAX_FILE_BYTES = 75 * 1024 * 1024;
// Generous on purpose -- the case this page exists for (extracting text
// from a .docx's own embedded image fragments after a bad PDF-to-Word
// conversion) can genuinely mean uploading 100+ small image pieces at
// once, see admin/archetype-miner/actions.ts's own corruption-detection
// comment for the real example this was built against. Must match the
// vision-ocr service's own MAX_FILES.
const MAX_FILES = 200;
const ACCEPTED_TYPES = new Set<VisionOcrMimeType>([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/gif",
]);

export type OcrFileResult = { fileName: string; ok: boolean; note?: string };
export type OcrState = {
  error?: string;
  result?: { text: string; fileResults: OcrFileResult[] };
};

// useActionState-shaped (returns { error } instead of throwing), same
// convention every file-upload form in this app follows -- see
// admin/archetype-miner/actions.ts's own submitRunAction for why.
//
// Image Processing and Image-to-Text/Vision (Document AI) both run in the
// separate vision-ocr service (see src/lib/visionOcrClient.ts) -- this
// action's own job is just validating the upload, base64-encoding it for
// that one HTTP call, and shaping the per-file results for the form.
export async function runOcrAction(_prevState: OcrState, formData: FormData): Promise<OcrState> {
  await requireAdminPage("archetype_miner");

  const files = formData.getAll("ocrFile").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) {
    return { error: "Choose one or more image or PDF files to OCR." };
  }
  if (files.length > MAX_FILES) {
    return { error: `Select at most ${MAX_FILES} files at once.` };
  }
  for (const file of files) {
    if (!ACCEPTED_TYPES.has(file.type as VisionOcrMimeType)) {
      return { error: `"${file.name}" is a "${file.type || "unknown"}" file -- only PDF and common image types are supported.` };
    }
    if (file.size > MAX_FILE_BYTES) {
      return { error: `"${file.name}" is too large (max ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))}MB).` };
    }
  }

  const encoded = await Promise.all(
    files.map(async (file) => ({
      fileName: file.name,
      mimeType: file.type as VisionOcrMimeType,
      base64: Buffer.from(await file.arrayBuffer()).toString("base64"),
    }))
  );

  let ocrResults;
  try {
    ocrResults = await runVisionOcr(encoded);
  } catch (err) {
    console.error("Vision OCR service request failed:", err);
    return { error: "The OCR service is temporarily unavailable. Please try again shortly." };
  }

  const fileResults: OcrFileResult[] = ocrResults.map((r) => ({
    fileName: r.fileName,
    ok: r.ok,
    // A successful multi-page-range PDF (a book) can still have SOME page
    // ranges fail underneath an overall ok:true -- see OcrFileResult's own
    // comment in visionOcrClient.ts. Surfaced here too, not just inline in
    // the extracted text itself, so a partial failure on a long book is
    // visible in this short per-file list rather than only discoverable by
    // scrolling/searching through possibly tens of thousands of words.
    note: r.ok ? r.note : r.error,
  }));

  // Order matches the order files were selected in the picker -- the only
  // ordering signal available without also building an "extract this
  // .docx's own images out in their real document order" step, which is a
  // separate, bigger feature of its own (see the chat discussion this page
  // came out of) rather than something this plain OCR utility takes on.
  const text = ocrResults
    .filter((r): r is { fileName: string; ok: true; text: string } => r.ok)
    .map((r) => `--- ${r.fileName} ---\n${r.text}`)
    .join("\n\n");

  if (!text.trim()) {
    return { error: "Every file failed OCR -- see the per-file results below.", result: { text: "", fileResults } };
  }

  return { result: { text, fileResults } };
}

// Mirrors the archetype-miner service's own MAX_BOOK_TEXT_CHARS
// (server.ts) -- checked here too so an oversized submission fails fast,
// with a message specific to this page, rather than only after the round
// trip to that service.
const MAX_BOOK_TEXT_CHARS = 2_000_000;

export type SegmentBookState = {
  error?: string;
  result?: { chunks: BookChapterChunk[]; unresolved: UnresolvedBookBoundary[] };
};

// The "feed this into Chapter Notes" step -- takes whatever text is
// currently in the extracted-text box (which the admin may have already
// reviewed/corrected, see runOcrAction's own "review this before using it"
// framing) and asks the archetype-miner service to find its real chapter
// boundaries. Never runs automatically on raw OCR output; always a
// separate, explicit click on text an admin has already looked at once.
// See the service's own bookChapterSegmentation.ts for how this actually
// works and why it never asks the model to reproduce chapter text itself.
export async function segmentBookAction(_prevState: SegmentBookState, formData: FormData): Promise<SegmentBookState> {
  await requireAdminPage("archetype_miner");

  const text = ((formData.get("text") as string | null) ?? "").trim();
  if (!text) {
    return { error: "There's no extracted text to split yet -- run OCR first." };
  }
  if (text.length > MAX_BOOK_TEXT_CHARS) {
    return { error: `That text is too large (max ${MAX_BOOK_TEXT_CHARS.toLocaleString()} characters).` };
  }

  try {
    const { chunks, unresolved } = await segmentBookIntoChapters(text);
    if (chunks.length === 0) {
      return {
        error:
          "Couldn't find any clear chapter boundaries in this text. Try reviewing/cleaning the extracted text above and retry, or use the plain text with the archetype-miner submit-run form instead.",
      };
    }
    return { result: { chunks, unresolved } };
  } catch (err) {
    console.error("Book chapter segmentation request failed:", err);
    return { error: "The archetype-miner service is temporarily unavailable. Please try again shortly." };
  }
}
