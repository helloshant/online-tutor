import { DocumentProcessorServiceClient } from "@google-cloud/documentai";

// Image-to-Text / Vision stage. Google Document AI was chosen specifically
// for its strong Devanagari/Indic-script OCR support -- the real gap that
// motivated this whole service (see imageProcessing.ts's own comment and
// the web app's admin/archetype-miner/actions.ts corruption-detection
// comment for the Hindi-paper case this was built against).
//
// Uses a service-account client, not a mounted credentials file -- this app
// has nowhere sane to mount one across every deployment target it runs on
// -- client_email/private_key are supplied directly as separate env vars,
// the same "small number of plain single-line secrets" pattern every other
// credential in this app already follows, rather than one multi-line JSON
// blob.

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
        // .env value (also just text), those need converting back to real
        // newlines before the auth library can parse the key.
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

export type DocumentAiResult = { text: string } | { error: string };

// Reported directly: OCR for a real CBSE Grade 12 Mathematics paper
// (65-7-1, diagram/graph-heavy -- typical of a Math paper, unlike a
// mostly-text Hindi/English paper) failed with "GoogleError: Total
// timeout ... exceeded 300000 milliseconds" after a DEADLINE_EXCEEDED --
// not a transient failure to retry away, but this exact RPC's own client-
// bundled retry budget (300s total, confirmed in
// document_processor_service_client_config.json) being too tight for a
// large, complex scanned document. That same bundled config's own retry
// GROUP (used by ProcessDocument) separately declares 600s (10 min) as a
// legitimate total_timeout_millis for other RPCs sharing it -- so this
// isn't inventing an arbitrary number, just applying a ceiling the
// library's own authors already consider reasonable for this API to
// ProcessDocument specifically, which the generated client's per-method
// entry doesn't. Every other value below mirrors that same bundled group
// exactly (delay/backoff/per-attempt timeout unchanged) -- only
// totalTimeoutMillis is raised.
//
// A plain object literal, not google-gax's own RetryOptions/
// BackoffSettings classes -- CallOptions.retry accepts
// Partial<RetryOptions> structurally, and google-gax is only ever a
// transitive dependency here (via @google-cloud/documentai), not
// something this service declares and pins itself.
const PROCESS_DOCUMENT_CALL_OPTIONS = {
  retry: {
    // DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, UNAVAILABLE -- the same
    // "deadline_exceeded_resource_exhausted_unavailable" group
    // ProcessDocument's own bundled config already retries.
    retryCodes: [4, 8, 14],
    backoffSettings: {
      initialRetryDelayMillis: 1000,
      retryDelayMultiplier: 9,
      maxRetryDelayMillis: 90000,
      initialRpcTimeoutMillis: 60000,
      rpcTimeoutMultiplier: 1,
      maxRpcTimeoutMillis: 60000,
      totalTimeoutMillis: 540000, // 9 minutes -- under the library's own 10-minute ceiling for this retry group.
    },
  },
};

// One call per file -- Document AI's synchronous processDocument endpoint
// (what this uses) is inherently single-document; the caller loops over
// this itself (see ocrPipeline.ts), which also lets each file's own error
// surface individually rather than one bad file failing an entire batch.
export async function runDocumentAiOcr(params: {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<DocumentAiResult> {
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
    const [response] = await client.processDocument(
      {
        name,
        rawDocument: { content: buffer, mimeType },
        // Document AI's synchronous processDocument caps a PDF at 15 pages
        // in the default mode, 30 in "imageless" mode (which just omits
        // page images from the response) -- this service only ever reads
        // response.document.text, never the page images, so there's no
        // downside to always requesting the higher cap.
        imagelessMode: true,
      },
      PROCESS_DOCUMENT_CALL_OPTIONS
    );
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
