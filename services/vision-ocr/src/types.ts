// Mirrors the archetype-miner OCR page's own MIME allowlist -- this service
// has no reason to accept anything the web app itself wouldn't first admit
// into the upload picker.
export type OcrMimeType =
  | "application/pdf"
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/bmp"
  | "image/tiff"
  | "image/gif";

export type OcrFileInput = {
  fileName: string;
  mimeType: OcrMimeType;
  // Base64, no data: URI prefix -- same convention the archetype-miner
  // service's own pdf_base64 field uses.
  base64: string;
};

export type OcrFileResult =
  | { fileName: string; ok: true; text: string }
  | { fileName: string; ok: false; error: string };

export type OcrBatchRequest = { files: OcrFileInput[] };
export type OcrBatchResponse = { results: OcrFileResult[] };
