import { NextResponse } from "next/server";
import { requireAdminPage } from "@/lib/auth";
import { getEmphasisRun } from "@/lib/emphasisRunStore";

// Polled every couple seconds by add-emphasis-all-progress.tsx while a bulk
// run is in flight -- see /api/admin/chapter-notes/emphasis-run's own
// top comment for how the run itself gets started and kept alive in the
// background.
//
// Every code path below must return through NextResponse.json -- this
// top-level catch is the backstop so an unexpected throw never reaches the
// client as an empty/non-JSON body. Same pattern as /api/chat.
export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    return await handleStatus(await params);
  } catch (err) {
    console.error("Unexpected error in GET /api/admin/chapter-notes/emphasis-run/[runId]:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

async function handleStatus({ runId }: { runId: string }) {
  await requireAdminPage("chapter_notes");

  const run = getEmphasisRun(runId);
  if (!run) {
    // Either a typo'd/foreign runId, or a real one whose entry already
    // expired (see emphasisRunStore.ts's own FINISHED_RUN_TTL_MS) -- either
    // way there's nothing left to report for it.
    return NextResponse.json(
      { error: "This run could not be found. It may have finished a while ago." },
      { status: 404 }
    );
  }

  return NextResponse.json(run);
}
