import sharp from "sharp";
import type { OcrMimeType } from "./types.js";

export type ProcessedImage = { buffer: Buffer; mimeType: OcrMimeType };

// Image Processing stage. Only applies to actual raster images -- a PDF is
// left untouched and passed straight through to Document AI, which reads
// PDFs natively (including multi-page ones); sharp has no PDF support and
// nothing here would improve on Document AI's own PDF handling anyway.
//
// Three concrete, well-understood corrections, not a vague "enhance":
//   - rotate(): auto-orients using the image's own EXIF orientation tag --
//     a phone photo taken sideways/upside-down is the single most common
//     way a scanned/photographed paper confuses an OCR engine before it
//     even gets to reading a character.
//   - resize(): caps the longest edge -- a modern phone photo (12MP+) is
//     far larger than Document AI's OCR needs, and larger-than-needed
//     input only costs latency/quota headroom, not accuracy, past a
//     certain resolution.
//   - normalize(): stretches contrast to use the full tonal range -- a
//     washed-out or dim scan/photo is a second common real-world failure
//     mode alongside rotation.
// Re-encoded as PNG (lossless) regardless of the source format, both to
// undo any input compression artifacts before OCR sees it and so Document
// AI always receives one predictable, well-supported MIME type for
// whatever raster format was uploaded.
//
// Fails open per file, not per batch (this codebase's own convention, see
// the archetype-miner service's pipelineRunner.ts): if sharp can't process
// a particular image (corrupt file, unsupported variant), the original
// buffer is handed to Document AI as-is rather than failing the file
// outright -- worse OCR odds are better than none at all.
const MAX_DIMENSION = 3000;

export async function processImage(buffer: Buffer, mimeType: OcrMimeType, fileName: string): Promise<ProcessedImage> {
  if (mimeType === "application/pdf") {
    return { buffer, mimeType };
  }

  try {
    const processed = await sharp(buffer)
      .rotate()
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
      .normalize()
      .png()
      .toBuffer();
    return { buffer: processed, mimeType: "image/png" };
  } catch (err) {
    console.warn(`Image processing failed for "${fileName}", passing the original through unmodified:`, err);
    return { buffer, mimeType };
  }
}
