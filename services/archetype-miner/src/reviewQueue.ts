import type { ReviewQueueSource } from "./types.js";

// Design doc §6: "Populate this queue from: any Stage 1 signature with
// confidence.overall below a chosen threshold (e.g. 0.5), any Stage 2
// cluster marked 'ambiguous' or 'incomplete,' and every Stage 3
// critic_decision: REVIEW." 0.5 is that chosen threshold -- override via
// ARCHETYPE_REVIEW_CONFIDENCE_THRESHOLD if a corpus's own confidence
// distribution calls for a different bar.
export function lowConfidenceThreshold(): number {
  const raw = Number(process.env.ARCHETYPE_REVIEW_CONFIDENCE_THRESHOLD);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.5;
}

export type ReviewQueueCandidate = {
  source: ReviewQueueSource;
  reference_id: string;
  reason: string;
  confidence: number | null;
};

// Row shape for a plain insert into archetype_review_queue -- run_id is
// added by the caller (pipelineRunner), which is the only place that
// actually knows which run these rows belong to.
export function toInsertRow(runId: string, candidate: ReviewQueueCandidate) {
  return {
    run_id: runId,
    source: candidate.source,
    reference_id: candidate.reference_id,
    reason: candidate.reason,
    confidence: candidate.confidence,
    status: "pending" as const,
  };
}
