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

// The SAME synchronous endpoint separately caps the raw request content at
// roughly 20MB regardless of page count -- a real risk once a PDF is
// genuinely book-scale: a short exam paper at ordinary scan resolution
// almost never gets close, but a full scanned book at real page counts can
// comfortably exceed this well before hitting the 30-page cap above (this
// only became worth guarding once "OCR a scanned paper" grew into "OCR a
// scanned book"). A safety margin under the documented ~20MB limit, not
// the limit itself, since pdf-lib's own re-saved byte count for a page
// range isn't guaranteed to match Google's own accounting exactly.
export const MAX_BYTES_PER_CALL = 18 * 1024 * 1024;

export type PdfPageChunk = { buffer: Buffer; startPage: number; endPage: number };

// Builds one page-range chunk as its own standalone PDF -- startPage/
// endPage are 1-indexed and inclusive (matching PdfPageChunk's own
// convention, used to label combined text by the real page range each
// chunk covers), converted to pdf-lib's 0-indexed page array internally.
async function buildChunk(source: PDFDocument, startPage: number, endPage: number): Promise<PdfPageChunk> {
  const chunkDoc = await PDFDocument.create();
  const pageIndices = Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage - 1 + i);
  const copiedPages = await chunkDoc.copyPages(source, pageIndices);
  for (const page of copiedPages) chunkDoc.addPage(page);
  return { buffer: Buffer.from(await chunkDoc.save()), startPage, endPage };
}

// Splits one already page-count-bounded chunk FURTHER whenever its own
// built size is still over MAX_BYTES_PER_CALL -- halving its page range
// and recursing on each half, until every resulting piece clears both
// ceilings. Stops at a single page (nothing left to split) even if that
// one page is still oversized -- rather than looping forever, it's handed
// to Document AI as-is and whatever error that call itself returns
// surfaces normally, the same "fail open per unit of work" posture
// ocrPipeline.ts's own per-chunk handling already uses one level up.
async function splitByBytes(source: PDFDocument, chunk: PdfPageChunk): Promise<PdfPageChunk[]> {
  if (chunk.buffer.length <= MAX_BYTES_PER_CALL || chunk.startPage === chunk.endPage) {
    return [chunk];
  }
  const mid = chunk.startPage + Math.floor((chunk.endPage - chunk.startPage) / 2);
  const [first, second] = await Promise.all([buildChunk(source, chunk.startPage, mid), buildChunk(source, mid + 1, chunk.endPage)]);
  const [firstSplit, secondSplit] = await Promise.all([splitByBytes(source, first), splitByBytes(source, second)]);
  return [...firstSplit, ...secondSplit];
}

// Splits a PDF into consecutive page-range chunks, each at most
// maxPagesPerChunk pages AND at most MAX_BYTES_PER_CALL bytes. Returns the
// original buffer completely unchanged (wrapped in a single-element array,
// not a pdf-lib resave) when it's already within BOTH limits -- the common
// case for an ordinary paper -- so a caller can treat every PDF uniformly
// without a separate "do I need to split this" branch of its own, and the
// typical case pays no extra cost for a check that will almost always pass.
export async function splitPdfIntoPageChunks(buffer: Buffer, maxPagesPerChunk: number = MAX_PAGES_PER_CALL): Promise<PdfPageChunk[]> {
  const source = await PDFDocument.load(buffer);
  const pageCount = source.getPageCount();

  if (pageCount <= maxPagesPerChunk && buffer.length <= MAX_BYTES_PER_CALL) {
    return [{ buffer, startPage: 1, endPage: pageCount }];
  }

  const pageChunks: PdfPageChunk[] = [];
  for (let start = 1; start <= pageCount; start += maxPagesPerChunk) {
    const end = Math.min(start + maxPagesPerChunk - 1, pageCount);
    pageChunks.push(await buildChunk(source, start, end));
  }

  const sized = await Promise.all(pageChunks.map((chunk) => splitByBytes(source, chunk)));
  return sized.flat();
}
