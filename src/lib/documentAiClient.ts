import "server-only";

import { DocumentProcessorServiceClient } from "@google-cloud/documentai";

// Standalone OCR utility (/admin/archetype-miner/ocr) -- entirely separate
// from the archetype-miner pipeline/service: this never touches an LLM or
// the mining pipeline, it's a plain image/PDF -> text conversion an admin
// runs by hand, reviews, and copies into the archetype-miner submission
// form themselves (or anywhere else). Built specifically for scanned/
// photographed papers whose text came through unreadable any other way
// this app already tries -- most concretely, Hindi/Devanagari content
// mangled by mammoth's plain DOCX text extraction (see actions.ts's own
// corruption check) or by whatever tool produced a bad PDF-to-Word
// conversion in the first place. Google Document AI was chosen specifically
// for its strong Devanagari/Indic-script OCR support, which is exactly the
// gap that broke everything else in that case.
//
// Uses a service-account client, NOT a file path (this app has nowhere
// sane to mount a credentials file across every deployment target it
// runs on) -- client_email/private_key are supplied directly as separate
// env vars, the same "small number of plain single-line secrets" pattern
// every other credential in this app already follows, rather than one
// multi-line JSON blob.

let cachedClient: DocumentProcessorServiceClient | null = null;

function getClient(): DocumentProcessorServiceClient {
  if (!cachedClient) {
    const clientEmail = process.env.GOOGLE_DOCUMENT_AI_CLIENT_EMAIL;
    const privateKey = process.env.GOOGLE_DOCUMENT_AI_PRIVATE_KEY;
    const location = process.env.GOOGLE_DOCUMENT_AI_LOCATION;
    if (!clientEmail) throw new Error("Missing GOOGLE_DOCUMENT_AI_CLIENT_EMAIL environment variable");
    if (!privateKey) throw new Error("Missing GOOGLE_DOCUMENT_AI_PRIVATE_KEY environment variable");
    if (!location) throw new Error("Missing GOOGLE_DOCUMENT_AI_LOCATION environment variable");

    cachedClient = new DocumentProcessorServiceClient({
      credentials: {
        client_email: clientEmail,
        // The service account JSON's own private_key field is a single
        // JSON string with literal "\n" escape sequences standing in for
        // real newlines in the PEM block -- pasted as-is into a plain
        // .env value (also just text), those need converting back to
        // real newlines before the auth library can parse the key.
        private_key: privateKey.replace(/\\n/g, "\n"),
      },
      // Document AI is a regionalized product -- the client's default
      // (non-regional) endpoint does not serve actual processing calls,
      // only certain global operations, so this must be set explicitly
      // regardless of which region "location" is (including "us").
      apiEndpoint: `${location}-documentai.googleapis.com`,
    });
  }
  return cachedClient;
}

export type OcrResult = { text: string } | { error: string };

// One call per file -- Document AI's synchronous processDocument endpoint
// (what this uses) is inherently single-document; a caller wanting to OCR
// several files loops over this itself (see ocr/actions.ts), which also
// lets each file's own error surface individually rather than one bad
// file failing an entire batch.
export async function runDocumentAiOcr(params: { buffer: Buffer; mimeType: string; fileName: string }): Promise<OcrResult> {
  const { buffer, mimeType, fileName } = params;
  const projectId = process.env.GOOGLE_DOCUMENT_AI_PROJECT_ID;
  const location = process.env.GOOGLE_DOCUMENT_AI_LOCATION;
  const processorId = process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID;
  if (!projectId) return { error: "Missing GOOGLE_DOCUMENT_AI_PROJECT_ID environment variable" };
  if (!location) return { error: "Missing GOOGLE_DOCUMENT_AI_LOCATION environment variable" };
  if (!processorId) return { error: "Missing GOOGLE_DOCUMENT_AI_PROCESSOR_ID environment variable" };

  try {
    const client = getClient();
    const name = client.processorPath(projectId, location, processorId);
    const [response] = await client.processDocument({
      name,
      rawDocument: { content: buffer, mimeType },
    });
    const text = response.document?.text ?? "";
    if (!text.trim()) {
      return { error: `Document AI found no text in "${fileName}".` };
    }
    return { text };
  } catch (err) {
    console.error(`Document AI OCR failed for "${fileName}":`, err);
    return { error: err instanceof Error ? err.message : `Document AI OCR failed for "${fileName}".` };
  }
}
