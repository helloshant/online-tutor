import { runDocumentAiOcr } from "./documentAiClient.js";
import { processImage } from "./imageProcessing.js";
import type { OcrFileInput, OcrFileResult } from "./types.js";

// Runs a handful of async tasks with bounded concurrency -- a batch can
// legitimately be 100+ small images (see server.ts's own MAX_FILES
// comment) run sequentially would take minutes; run fully in parallel,
// that many simultaneous requests risks tripping Document AI's own
// per-second quota on a new/modest GCP project. A small fixed pool is a
// reasonable middle ground without building a real job queue for what's
// meant to stay a plain utility.
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// Image Processing -> Image-to-Text/Vision, per file, with each file's own
// success/failure kept independent of the rest of the batch (this
// codebase's "fail open per unit of work, never per run" convention).
export async function runOcrBatch(files: OcrFileInput[], concurrency: number): Promise<OcrFileResult[]> {
  return mapWithConcurrency(files, concurrency, async (file): Promise<OcrFileResult> => {
    try {
      const rawBuffer = Buffer.from(file.base64, "base64");
      const { buffer, mimeType } = await processImage(rawBuffer, file.mimeType, file.fileName);
      const result = await runDocumentAiOcr({ buffer, mimeType, fileName: file.fileName });
      return "text" in result
        ? { fileName: file.fileName, ok: true, text: result.text }
        : { fileName: file.fileName, ok: false, error: result.error };
    } catch (err) {
      console.error(`OCR pipeline failed for "${file.fileName}":`, err);
      return {
        fileName: file.fileName,
        ok: false,
        error: err instanceof Error ? err.message : `OCR failed for "${file.fileName}".`,
      };
    }
  });
}
