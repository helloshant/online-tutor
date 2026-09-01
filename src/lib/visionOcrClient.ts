import "server-only";

// Client for the vision-ocr service (Image Processing -> Image-to-Text/
// Vision stages). Today the only caller is admin/archetype-miner/ocr's
// actions.ts -- an admin uploads image(s)/PDF(s) of a scanned/photographed
// paper, this returns each file's extracted text for review, never
// touching an LLM or the archetype-miner pipeline itself. See
// services/vision-ocr for why this lives in its own service rather than
// calling Google Document AI directly from here, as it originally did.

export type VisionOcrMimeType =
  | "application/pdf"
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/bmp"
  | "image/tiff"
  | "image/gif";

export type VisionOcrFileInput = { fileName: string; mimeType: VisionOcrMimeType; base64: string };

export type VisionOcrFileResult =
  | { fileName: string; ok: true; text: string }
  | { fileName: string; ok: false; error: string };

function getVisionOcrUrl(): string {
  const url = process.env.VISION_OCR_URL;
  if (!url) throw new Error("Missing VISION_OCR_URL environment variable");
  return url;
}

// One HTTP call, batched -- the service itself runs each file's Image
// Processing + Document AI OCR with bounded concurrency (see
// services/vision-ocr/src/ocrPipeline.ts), so there's no reason to fan
// this out into one request per file from here.
export async function runVisionOcr(files: VisionOcrFileInput[]): Promise<VisionOcrFileResult[]> {
  const url = `${getVisionOcrUrl().replace(/\/$/, "")}/v1/ocr`;
  const sharedSecret = process.env.VISION_OCR_SHARED_SECRET;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sharedSecret ? { "x-internal-api-key": sharedSecret } : {}),
    },
    body: JSON.stringify({ files }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `Vision OCR service returned ${res.status}`);
  }

  const data = (await res.json()) as { results: VisionOcrFileResult[] };
  return data.results;
}
