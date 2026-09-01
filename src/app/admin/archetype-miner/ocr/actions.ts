"use server";

import { requireAdminPage } from "@/lib/auth";
import { runDocumentAiOcr } from "@/lib/documentAiClient";

// Same cap the exam-answer-sheet/archetype-miner PDF uploads already use
// for a single file, reused here since Document AI's own synchronous
// processDocument endpoint has a comparable real-world ceiling.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Generous on purpose -- the case this page exists for (extracting text
// from a .docx's own embedded image fragments after a bad PDF-to-Word
// conversion) can genuinely mean uploading 100+ small image pieces at
// once, see admin/archetype-miner/actions.ts's own corruption-detection
// comment for the real example this was built against.
const MAX_FILES = 200;
const ACCEPTED_TYPES = new Set([
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

// Runs a handful of async tasks with bounded concurrency -- 149 individual
// small images (the real case this page was built for) run sequentially
// would take minutes; run fully in parallel, that many simultaneous
// requests risks tripping Document AI's own per-second quota on a new/
// modest GCP project. A small fixed pool is a reasonable middle ground
// without building a real job queue for what's meant to stay a plain
// utility page.
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// useActionState-shaped (returns { error } instead of throwing), same
// convention every file-upload form in this app follows -- see
// admin/archetype-miner/actions.ts's own submitRunAction for why.
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
    if (!ACCEPTED_TYPES.has(file.type)) {
      return { error: `"${file.name}" is a "${file.type || "unknown"}" file -- only PDF and common image types are supported.` };
    }
    if (file.size > MAX_FILE_BYTES) {
      return { error: `"${file.name}" is too large (max ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))}MB).` };
    }
  }

  const ocrResults = await mapWithConcurrency(files, 4, async (file) => {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await runDocumentAiOcr({ buffer, mimeType: file.type, fileName: file.name });
    return "text" in result
      ? { fileName: file.name, ok: true as const, text: result.text }
      : { fileName: file.name, ok: false as const, note: result.error };
  });

  const fileResults: OcrFileResult[] = ocrResults.map((r) => ({ fileName: r.fileName, ok: r.ok, note: r.ok ? undefined : r.note }));

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
