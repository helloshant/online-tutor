"use server";

import { requireAdminPage } from "@/lib/auth";
import { runVisionOcr, type VisionOcrMimeType } from "@/lib/visionOcrClient";

// Same cap the exam-answer-sheet/archetype-miner PDF uploads already use
// for a single file, reused here since Document AI's own synchronous
// processDocument endpoint has a comparable real-world ceiling.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
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
    note: r.ok ? undefined : r.error,
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
