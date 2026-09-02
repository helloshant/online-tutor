import { PDFDocument } from "pdf-lib";

// Document AI's synchronous processDocument endpoint (what documentAiClient.ts
// uses) caps a PDF at 30 pages even in imageless mode -- there is no higher
// limit to ask for on that endpoint; going further requires either the
// asynchronous batchProcessDocuments API (writes results to a GCS bucket --
// meaningfully more infrastructure for what's meant to stay a plain utility
// service) or splitting the PDF into page-range pieces ourselves and calling
// the same synchronous endpoint once per piece. This does the latter, since
// it needs nothing new provisioned and this service already accepts/merges
// a batch of independent files the same way (see ocrPipeline.ts).
export const MAX_PAGES_PER_CALL = 30;

export type PdfPageChunk = { buffer: Buffer; startPage: number; endPage: number };

// Splits a PDF into consecutive page-range chunks of at most
// maxPagesPerChunk pages each (1-indexed, inclusive page numbers, so a
// caller can label combined text by the real page range each chunk
// covers). Returns the original buffer unchanged (wrapped in a single-
// element array) when it's already within the limit, so a caller can
// treat every PDF uniformly without a separate "do I need to split this"
// branch of its own.
export async function splitPdfIntoPageChunks(buffer: Buffer, maxPagesPerChunk: number = MAX_PAGES_PER_CALL): Promise<PdfPageChunk[]> {
  const source = await PDFDocument.load(buffer);
  const pageCount = source.getPageCount();
  if (pageCount <= maxPagesPerChunk) {
    return [{ buffer, startPage: 1, endPage: pageCount }];
  }

  const chunks: PdfPageChunk[] = [];
  for (let start = 0; start < pageCount; start += maxPagesPerChunk) {
    const end = Math.min(start + maxPagesPerChunk, pageCount);
    const chunkDoc = await PDFDocument.create();
    const pageIndices = Array.from({ length: end - start }, (_, i) => start + i);
    const copiedPages = await chunkDoc.copyPages(source, pageIndices);
    for (const page of copiedPages) chunkDoc.addPage(page);
    chunks.push({ buffer: Buffer.from(await chunkDoc.save()), startPage: start + 1, endPage: end });
  }
  return chunks;
}
