import express from "express";
import type { NextFunction, Request, Response } from "express";
import { runOcrBatch } from "./ocrPipeline.js";
import type { OcrBatchRequest, OcrBatchResponse, OcrFileInput, OcrMimeType } from "./types.js";

const PORT = Number(process.env.PORT) || 4500;
const SHARED_SECRET = process.env.VISION_OCR_SHARED_SECRET;
const CONCURRENCY = 4;
const MAX_FILES = 200;
// Generous on purpose -- the case this service exists for (extracting text
// from a .docx's own embedded image fragments after a bad PDF-to-Word
// conversion) can genuinely mean a batch of 100+ small image pieces, and
// base64 runs ~33% larger than the source bytes on top of that. Real
// batches are nowhere near this in practice; this is a safety ceiling, not
// a target.
const MAX_REQUEST_BODY = "200mb";

const ACCEPTED_MIME_TYPES = new Set<OcrMimeType>([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/gif",
]);

if (!SHARED_SECRET) {
  console.warn(
    "WARNING: VISION_OCR_SHARED_SECRET is not set. This service will accept requests from anyone " +
      "who can reach it on the network. Set it before exposing this service beyond a trusted " +
      "internal network (e.g. the docker-compose network)."
  );
}

const app = express();
app.use(express.json({ limit: MAX_REQUEST_BODY }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    documentAi: {
      configured: Boolean(
        process.env.GOOGLE_DOCUMENT_AI_PROJECT_ID &&
          process.env.GOOGLE_DOCUMENT_AI_LOCATION &&
          process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID &&
          process.env.GOOGLE_DOCUMENT_AI_CLIENT_EMAIL &&
          process.env.GOOGLE_DOCUMENT_AI_PRIVATE_KEY
      ),
    },
  });
});

function requireSharedSecret(req: Request, res: Response, next: NextFunction) {
  if (!SHARED_SECRET) {
    next();
    return;
  }
  if (req.header("x-internal-api-key") !== SHARED_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function validateFiles(raw: unknown): { files?: OcrFileInput[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "files must be a non-empty array" };
  }
  if (raw.length > MAX_FILES) {
    return { error: `At most ${MAX_FILES} files are allowed per request` };
  }
  const files: OcrFileInput[] = [];
  for (const entry of raw) {
    const { fileName, mimeType, base64 } = (entry ?? {}) as Partial<OcrFileInput>;
    if (typeof fileName !== "string" || !fileName) {
      return { error: "Each file requires a fileName" };
    }
    if (typeof mimeType !== "string" || !ACCEPTED_MIME_TYPES.has(mimeType as OcrMimeType)) {
      return { error: `"${fileName}" has an unsupported mimeType -- only PDF and common image types are supported` };
    }
    if (typeof base64 !== "string" || !base64) {
      return { error: `"${fileName}" is missing its base64 content` };
    }
    files.push({ fileName, mimeType: mimeType as OcrMimeType, base64 });
  }
  return { files };
}

// Image Processing -> Image-to-Text/Vision, batched. Called by the web
// app's admin/archetype-miner/ocr page (see src/lib/visionOcrClient.ts) --
// the only caller today, but kept as a plain, self-contained batch OCR
// endpoint rather than anything specific to that page, so anything else in
// this app that later needs the same two stages can call it the same way.
app.post("/v1/ocr", requireSharedSecret, async (req: Request, res: Response) => {
  const body = req.body as Partial<OcrBatchRequest> | undefined;
  const { files, error } = validateFiles(body?.files);
  if (error || !files) {
    res.status(400).json({ error });
    return;
  }

  const results = await runOcrBatch(files, CONCURRENCY);
  const response: OcrBatchResponse = { results };
  res.json(response);
});

app.listen(PORT, () => {
  console.log(`Vision OCR service listening on port ${PORT}`);
});
