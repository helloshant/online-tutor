import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { listUnmatchedTopics } from "@/lib/archetypeMinerClient";
import { UnmatchedTopicsTable } from "./unmatched-topics-table";

// The human-in-the-loop counterpart to unmatched-chapters/page.tsx, one
// level deeper -- see the service's own topicReconciliation.ts top comment
// for the full reasoning. That page fixes a mined chapter value against
// the real syllabus; this one is for a chapter that's already correct --
// a real, shared "book section" covering several real topics (e.g. a
// Bengali grammar section, a story anthology) -- where the mined topic
// value itself doesn't say which one of that section's real topics a
// question belongs to. Confirmed live: a label alone ("line analysis",
// "যৌক্তিক প্রকাশ") isn't enough to tell which real topic it's about --
// only the actual question text is, same reasoning the chapter-level page
// already established.
//
// Two actions per row: "Attach" writes the chosen real topic onto
// curriculum.chapter for every question carrying that mined (chapter,
// topic) pair -- the mined topic value itself is left untouched, now
// correctly understood as a genuine within-topic concept rather than an
// ambiguous label; "Ignore" marks it reviewed-and-genuinely-unplaceable
// (TOPIC_UNMATCHED_IGNORED_FLAG) so it stops resurfacing without forcing
// a guess onto content that doesn't have a real match.
export default async function UnmatchedTopicsPage() {
  await requireAdminPage("archetype_miner");

  // Best-effort, same posture as unmatched-chapters/page.tsx's own fetch --
  // a genuinely expensive, full-catalogue read, so an error banner instead
  // of a broken page, and an accepted few-seconds cost for a page an admin
  // visits deliberately.
  const entries = await listUnmatchedTopics().catch(() => null);

  return (
    <div>
      <Link href="/admin/archetype-miner" className="text-sm text-brand hover:underline">
        ← Archetype Miner
      </Link>

      <h1 className="mt-4 text-xl font-semibold">Unmatched topics</h1>
      <p className="mt-1 max-w-3xl text-sm text-foreground/75">
        Mined topic values sitting under a shared &quot;book section&quot; chapter (several real syllabus
        topics under one chapter value, e.g. a grammar section or a story anthology) that don&apos;t
        identify which one of that section&apos;s real topics they belong to -- shown with real sample
        question text (and the mined concept, which often independently confirms the right answer) so a
        human can judge the ones no automated pass could place. Attaching one writes the real topic onto
        every mined question carrying that (chapter, topic) pair; ignoring one marks it reviewed and
        genuinely unplaceable so it stops resurfacing without forcing a guess onto it.
      </p>

      {!entries && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          Could not reach the archetype-miner service to list unmatched topics -- check its health and
          try again. This is a long-running read (a full-catalogue scan); if the service is healthy but
          slow, a retry after a moment may still succeed.
        </p>
      )}

      {entries && entries.length === 0 && (
        <p className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800">
          Nothing unmatched anywhere in the catalogue right now.
        </p>
      )}

      {entries && entries.length > 0 && <UnmatchedTopicsTable entries={entries} />}
    </div>
  );
}
