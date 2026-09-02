import { runDocumentAiOcr } from "./documentAiClient.js";
import { processImage } from "./imageProcessing.js";
import { splitPdfIntoPageChunks } from "./pdfPaging.js";
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

async function ocrOneFile(file: OcrFileInput): Promise<OcrFileResult> {
  const rawBuffer = Buffer.from(file.base64, "base64");
  const { buffer, mimeType } = await processImage(rawBuffer, file.mimeType, file.fileName);

  if (mimeType !== "application/pdf") {
    const result = await runDocumentAiOcr({ buffer, mimeType, fileName: file.fileName });
    return "text" in result
      ? { fileName: file.fileName, ok: true, text: result.text }
      : { fileName: file.fileName, ok: false, error: result.error };
  }

  // Document AI's synchronous endpoint has a hard page cap even in
  // imageless mode (see pdfPaging.ts) -- split first, always, rather than
  // trying the whole PDF and only splitting after a page-limit error, so
  // a predictably-oversized PDF doesn't spend a guaranteed-failing call
  // first. splitPdfIntoPageChunks returns the buffer unchanged (as a
  // single chunk covering every page) when it's already within the
  // limit, so a small PDF costs exactly the one call it always did.
  const pageChunks = await splitPdfIntoPageChunks(buffer);

  if (pageChunks.length === 1) {
    const result = await runDocumentAiOcr({ buffer: pageChunks[0].buffer, mimeType, fileName: file.fileName });
    return "text" in result
      ? { fileName: file.fileName, ok: true, text: result.text }
      : { fileName: file.fileName, ok: false, error: result.error };
  }

  // Multiple page-range calls for the SAME file -- run sequentially, not
  // fanned out through the outer batch's own concurrency pool, since one
  // file already turning into several Document AI calls is enough load
  // of its own without also parallelizing ITS OWN chunks against the
  // same per-second quota. Fails open per page-range: one bad chunk (a
  // corrupted page range, a transient error) doesn't lose the other
  // chunks' text, same "fail open per unit of work" posture as
  // everywhere else -- the combined result is only a hard failure when
  // EVERY chunk failed.
  const chunkTexts: string[] = [];
  const chunkErrors: string[] = [];
  for (const chunk of pageChunks) {
    const label = `pages ${chunk.startPage}-${chunk.endPage}`;
    const result = await runDocumentAiOcr({
      buffer: chunk.buffer,
      mimeType,
      fileName: `${file.fileName} (${label})`,
    });
    if ("text" in result) {
      chunkTexts.push(`--- ${label} ---\n${result.text}`);
    } else {
      chunkErrors.push(`${label}: ${result.error}`);
    }
  }

  if (chunkTexts.length === 0) {
    return { fileName: file.fileName, ok: false, error: chunkErrors.join("; ") };
  }
  const note = chunkErrors.length > 0 ? ` (${chunkErrors.length} of ${pageChunks.length} page range(s) failed: ${chunkErrors.join("; ")})` : "";
  return { fileName: file.fileName, ok: true, text: chunkTexts.join("\n\n") + (note ? `\n\n[${note.trim()}]` : "") };
}

// Image Processing -> Image-to-Text/Vision, per file, with each file's own
// success/failure kept independent of the rest of the batch (this
// codebase's "fail open per unit of work, never per run" convention).
export async function runOcrBatch(files: OcrFileInput[], concurrency: number): Promise<OcrFileResult[]> {
  return mapWithConcurrency(files, concurrency, async (file): Promise<OcrFileResult> => {
    try {
      return await ocrOneFile(file);
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
