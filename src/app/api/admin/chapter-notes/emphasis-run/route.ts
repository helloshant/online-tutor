import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { requireAdminPage } from "@/lib/auth";
import { runEmphasisPass } from "@/lib/chapterDocumentEmphasis";
import { createEmphasisRun, updateEmphasisRun } from "@/lib/emphasisRunStore";
import { createAdminClient } from "@/lib/supabase/admin";

// Kicks off the "Add emphasis to all" bulk sweep (see
// add-emphasis-all-progress.tsx) and returns a runId immediately, rather
// than blocking the request until every document is done -- the sweep
// itself keeps running in the background on this same process (see
// emphasisRunStore.ts's own comment on why that's safe here) while the
// admin page polls GET /emphasis-run/[runId] for progress.
//
// Every code path below must return through NextResponse.json -- this
// top-level catch is the backstop so an unexpected throw never reaches the
// client as an empty/non-JSON body. Same pattern as /api/chat.
export async function POST() {
  try {
    return await handleStart();
  } catch (err) {
    console.error("Unexpected error in POST /api/admin/chapter-notes/emphasis-run:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

async function handleStart() {
  await requireAdminPage("chapter_notes");
  const supabase = createAdminClient();

  const { data, error } = await supabase.from("chapter_documents").select("id, topic_id, title, content");
  if (error) {
    console.error("Failed to load chapter documents for bulk emphasis run:", error);
    return NextResponse.json({ error: "Could not load chapter documents. Please try again." }, { status: 500 });
  }

  const docs = data ?? [];
  const run = createEmphasisRun(docs.length);

  // Fire-and-forget: deliberately not awaited. The loop below keeps
  // running on this process after the response for this request is sent
  // -- see emphasisRunStore.ts's own comment on why that's a safe
  // assumption for how this app is deployed.
  void runAllDocuments(run.runId, supabase, docs);

  return NextResponse.json({ runId: run.runId, total: docs.length });
}

async function runAllDocuments(
  runId: string,
  supabase: ReturnType<typeof createAdminClient>,
  docs: { id: string; topic_id: string; title: string; content: string }[]
) {
  let processed = 0;
  let changed = 0;
  let failed = 0;

  for (const doc of docs) {
    updateEmphasisRun(runId, { currentTitle: doc.title });

    let outcome: "changed" | "unchanged" | "failed";
    try {
      const result = await runEmphasisPass(supabase, doc);
      outcome = result === null ? "failed" : result.changed ? "changed" : "unchanged";
    } catch (err) {
      // runEmphasisPass already catches its own network/DB failures and
      // returns null -- this is only a backstop against something
      // genuinely unexpected, so the whole sweep can't die partway
      // through on one bad document.
      console.error(`Unexpected error running emphasis pass for document ${doc.id}:`, err);
      outcome = "failed";
    }

    processed++;
    if (outcome === "changed") changed++;
    else if (outcome === "failed") failed++;
    updateEmphasisRun(runId, { processed, changed, failed });
  }

  updateEmphasisRun(runId, { currentTitle: null, done: true, finishedAt: Date.now() });
  // The document list's own preview text (page.tsx) and per-document forms
  // read straight from Postgres on every render -- revalidate once at the
  // end of the sweep, not per document, so this doesn't invalidate the
  // page hundreds of times over for a large run.
  revalidatePath("/admin/chapter-notes");
}
