import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { listUnmatchedChapters } from "@/lib/archetypeMinerClient";
import { UnmatchedChaptersTable } from "./unmatched-chapters-table";

// The human-in-the-loop counterpart to curriculum-reconciliation/page.tsx
// -- that page runs an LLM over one board/grade/subject scope at a time,
// seeing only the bare mined chapter string. This is what curriculum-
// reconciliation's own residual "N chapter value(s) left unmatched"
// number was always missing: a place to actually LOOK at what those
// leftover values are, with real sample question text (not just the
// label) so a human can judge safely -- confirmed directly, more than
// once, that a label alone ("Geometrical Optics", "Simple Interest") isn't
// enough to tell a genuine Stage-1 mis-classification (the real chapter
// IS in the syllabus, just described oddly) from truly off-syllabus
// content. Covers every board/grade/subject at once rather than making an
// admin pick a scope first -- filtering happens client-side against the
// one full list this page fetches (see UnmatchedChaptersTable's own
// comment).
//
// Two actions per row: "Attach" writes the mined chapter's real syllabus
// match (same effect as curriculum reconciliation's own LLM-driven
// mapping, just human-chosen); "Ignore" marks it reviewed-and-genuinely-
// unmatched (CHAPTER_UNMATCHED_IGNORED_FLAG) so it stops resurfacing here
// AND stops being sent to the LLM pass, without forcing a fake chapter
// onto content that doesn't have a real match (exam boilerplate
// mis-extracted as a question, wrong-grade content, a chapter since
// removed from the syllabus).
export default async function UnmatchedChaptersPage() {
  await requireAdminPage("archetype_miner");

  // Best-effort, same "never break the page over this" posture every
  // other archetype-miner-service read already uses on this admin site --
  // a failure shows an error banner instead of a broken page. Unlike this
  // file's siblings this is a genuinely expensive read (a full-catalogue
  // scan across every scope, not one board/grade/subject), so it can take
  // a few seconds -- that's an accepted trade-off for a page an admin
  // visits deliberately, not one rendered on every request.
  const entries = await listUnmatchedChapters().catch(() => null);

  return (
    <div>
      <Link href="/admin/archetype-miner" className="text-sm text-brand hover:underline">
        ← Archetype Miner
      </Link>

      <h1 className="mt-4 text-xl font-semibold">Unmatched chapters</h1>
      <p className="mt-1 max-w-3xl text-sm text-foreground/60">
        Every already-mined chapter value, across every board/grade/subject, that doesn&apos;t exactly
        match this app&apos;s own curated syllabus_topics wording -- the same values curriculum
        reconciliation&apos;s own LLM pass tries first, but with real sample question text so a human
        can judge the ones it couldn&apos;t confidently place. Attaching one writes the real syllabus
        chapter onto every mined question carrying that value; ignoring one marks it reviewed and
        genuinely unmatched so it stops resurfacing without forcing a wrong answer onto it.
      </p>

      {!entries && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          Could not reach the archetype-miner service to list unmatched chapters -- check its health
          and try again. This is a long-running read (a full-catalogue scan); if the service is
          healthy but slow, a retry after a moment may still succeed.
        </p>
      )}

      {entries && entries.length === 0 && (
        <p className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800">
          Nothing unmatched anywhere in the catalogue right now.
        </p>
      )}

      {entries && entries.length > 0 && <UnmatchedChaptersTable entries={entries} />}
    </div>
  );
}
