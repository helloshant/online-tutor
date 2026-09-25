"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { EmphasisRunStatus } from "@/lib/emphasisRunStore";

// How often to poll GET /emphasis-run/[runId] while a run is active.
// Frequent enough that the bar visibly moves per-document rather than
// jumping in big steps, cheap enough (one small JSON request) that it
// doesn't matter if a sweep runs for several minutes.
const POLL_INTERVAL_MS = 1500;

type Phase = "idle" | "starting" | "running" | "done" | "error";

// Replaces the old plain server-action bulk button: that one blocked the
// browser on a single request for the ENTIRE sweep with no visibility at
// all (see this file's own PR/commit history) -- this starts the sweep via
// POST /emphasis-run, then polls its progress so the admin can actually
// see it moving rather than staring at a spinning tab wondering if it's
// stuck. See /api/admin/chapter-notes/emphasis-run's own top comment for
// how the sweep keeps running server-side between polls.
export function AddEmphasisAllProgress() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState<EmphasisRunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function pollOnce(runId: string) {
    let res: Response;
    try {
      res = await fetch(`/api/admin/chapter-notes/emphasis-run/${runId}`);
    } catch {
      // A single dropped poll tick isn't fatal -- the next one a couple
      // seconds later will most likely succeed -- so this doesn't stop
      // polling or surface an error on its own.
      return;
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || typeof body.processed !== "number") {
      stopPolling();
      setPhase("error");
      setError(body?.error ?? "Lost track of this run. Refresh the page to check its result.");
      return;
    }
    setStatus(body as EmphasisRunStatus);
    if (body.done) {
      stopPolling();
      setPhase("done");
      // Refreshes this Server Component page's own data (the document
      // list and each preview) so anything the sweep actually changed
      // shows up without a manual reload.
      router.refresh();
    }
  }

  async function start() {
    if (
      !confirm(
        "Add markdown emphasis to every chapter document? Each one is checked individually and only saved if the result verifies as unchanged apart from the added emphasis -- this can take a while for a lot of documents."
      )
    ) {
      return;
    }

    setPhase("starting");
    setError(null);
    setStatus(null);

    let res: Response;
    try {
      res = await fetch("/api/admin/chapter-notes/emphasis-run", { method: "POST" });
    } catch {
      setPhase("error");
      setError("Could not reach the server. Please try again.");
      return;
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.runId) {
      setPhase("error");
      setError(body?.error ?? "Could not start the run. Please try again.");
      return;
    }

    setPhase("running");
    setStatus({
      runId: body.runId,
      total: body.total,
      processed: 0,
      changed: 0,
      failed: 0,
      currentTitle: null,
      done: body.total === 0,
      startedAt: Date.now(),
      finishedAt: null,
    });
    if (body.total === 0) {
      setPhase("done");
      return;
    }

    pollOnce(body.runId);
    pollRef.current = setInterval(() => pollOnce(body.runId), POLL_INTERVAL_MS);
  }

  const running = phase === "starting" || phase === "running";
  const pct = status && status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;

  return (
    <div>
      <button
        type="button"
        onClick={start}
        disabled={running}
        className="rounded-lg border border-brand px-3 py-1.5 text-sm font-medium text-brand hover:bg-brand/5 disabled:opacity-60"
      >
        {running ? "Adding emphasis…" : "Add emphasis to all"}
      </button>

      {running && status && (
        <div className="mt-2 max-w-md">
          <div className="h-2 w-full overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-brand transition-[width] duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-foreground/75">
            {status.processed} / {status.total} checked ({pct}%)
            {status.currentTitle && <> — currently: {status.currentTitle}</>}
          </p>
        </div>
      )}

      {phase === "done" && status && (
        <p className="mt-2 text-sm text-green-700">
          Checked {status.total} document{status.total === 1 ? "" : "s"} — {status.changed} formatted with new
          emphasis, {status.failed} couldn&rsquo;t be reached or saved.
        </p>
      )}

      {phase === "error" && error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
