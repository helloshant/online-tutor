import "server-only";

// Progress tracking for the "Add emphasis to all" bulk chapter-document
// run (see /api/admin/chapter-notes/emphasis-run) -- a whole-library sweep
// runs far longer than any single request should stay open for, so the
// start route kicks it off in the background and returns immediately with
// a runId; the admin page then polls a status route for this run's own
// progress to drive a progress bar.
//
// Deliberately just an in-memory Map, not a Postgres table or Redis key:
// this app runs as a persistent Node process per container (see the
// orchestrator's own docker-compose comment in server.ts), not a
// per-request serverless function, so a module-level Map here lives
// exactly as long as a run needs it to -- there's no requirement this
// survive a restart, and a real table would be pure overhead for state
// nobody but this one admin page's polling ever reads. The one thing this
// genuinely gives up versus a shared store is visibility across multiple
// web app instances behind a load balancer; this app doesn't run that way
// today, and if it ever does, this is the file to swap for Redis (the
// orchestrator already depends on it for caching).
export type EmphasisRunStatus = {
  runId: string;
  total: number;
  processed: number;
  changed: number;
  failed: number;
  // Title of the document currently being processed -- null once the run
  // finishes (or if it started with zero documents). Purely cosmetic, for
  // the progress bar's "working on: ..." line.
  currentTitle: string | null;
  done: boolean;
  startedAt: number;
  finishedAt: number | null;
};

const runs = new Map<string, EmphasisRunStatus>();

// How long a finished run's status stays queryable after it completes --
// long enough that a slow poll tick or a brief network hiccup right at the
// end doesn't lose the final summary, short enough that a run from an old
// page load doesn't linger in memory indefinitely.
const FINISHED_RUN_TTL_MS = 10 * 60 * 1000;

export function createEmphasisRun(total: number): EmphasisRunStatus {
  const runId = crypto.randomUUID();
  const now = Date.now();
  const status: EmphasisRunStatus = {
    runId,
    total,
    processed: 0,
    changed: 0,
    failed: 0,
    currentTitle: null,
    // A run started with nothing to process (e.g. no chapter documents
    // exist yet) is done the instant it's created -- nothing will ever
    // call updateEmphasisRun for it.
    done: total === 0,
    startedAt: now,
    finishedAt: total === 0 ? now : null,
  };
  runs.set(runId, status);
  return status;
}

// Mutates the stored run in place and returns it -- callers read the
// returned object (or call getEmphasisRun again) rather than trust a copy,
// since this store's whole contract is "the latest state for this runId,"
// never a point-in-time snapshot.
export function updateEmphasisRun(runId: string, patch: Partial<Omit<EmphasisRunStatus, "runId">>): EmphasisRunStatus | null {
  const existing = runs.get(runId);
  if (!existing) return null;
  Object.assign(existing, patch);
  if (existing.done) {
    const timer = setTimeout(() => runs.delete(runId), FINISHED_RUN_TTL_MS);
    // Never hold the process open just to expire a finished run's entry --
    // same reasoning as any other cleanup timer in this app.
    timer.unref?.();
  }
  return existing;
}

export function getEmphasisRun(runId: string): EmphasisRunStatus | null {
  return runs.get(runId) ?? null;
}
