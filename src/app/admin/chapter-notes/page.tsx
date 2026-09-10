import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ChapterDocumentSourceType, Medium } from "@/lib/supabase/types";
import { deleteChapterDocument } from "./actions";
import { EditChapterDocumentForm } from "./edit-document-form";
import { ImportChunksForm } from "./import-chunks-form";
import { NewChapterDocumentForm } from "./new-document-form";

// Purely for a readable preview in the list below -- the full text is what
// gets sent to embedding/retrieval, this truncation never touches storage.
const PREVIEW_CHARS = 220;

const SOURCE_TYPE_LABELS: Record<string, string> = {
  original: "Original",
  public_domain: "Public domain",
  cc_licensed: "CC-licensed",
  ncert_or_diksha: "NCERT/DIKSHA",
  other: "Other source",
};

const SOURCE_TYPES = Object.keys(SOURCE_TYPE_LABELS) as ChapterDocumentSourceType[];
const MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];

export default async function ChapterNotesPage({
  searchParams,
}: {
  searchParams: Promise<{
    board?: string;
    grade?: string;
    subject?: string;
    medium?: string;
    sourceType?: string;
    search?: string;
  }>;
}) {
  await requireAdminPage("chapter_notes");
  const { board, grade, subject, medium, sourceType, search } = await searchParams;
  const activeBoard = board || null;
  const activeGrade = grade || null;
  const activeSubject = subject || null;
  const activeMedium = (medium as Medium | undefined) || null;
  const activeSourceType = (sourceType as ChapterDocumentSourceType | undefined) || null;
  const activeSearch = search?.trim() || null;
  const hasActiveFilter = Boolean(
    activeBoard || activeGrade || activeSubject || activeMedium || activeSourceType || activeSearch
  );

  // chapter_documents has RLS enabled with zero client-facing policies
  // (see 0024_chapter_documents_rag.sql) -- same "backend-only table"
  // posture as answered_questions, so this needs the service-role client
  // the same way the Answer Bank admin page does; the ordinary
  // session-scoped client would silently see zero rows.
  const supabase = createAdminClient();

  // topic_id is NOT NULL with ON DELETE CASCADE (see
  // 0024_chapter_documents_rag.sql) -- a chapter_documents row can never
  // outlive its topic, so the `!inner` join hint below (needed for
  // PostgREST to actually apply .eq() filters on the embedded
  // syllabus_topics columns) never excludes a row that would otherwise show.
  let documentsQuery = supabase
    .from("chapter_documents")
    .select(
      "*, syllabus_topics!inner(chapter, topic, board_id, grade_id, subject_id, medium, boards(name), grades(name), subjects(name))"
    )
    .order("created_at", { ascending: false });
  if (activeBoard) documentsQuery = documentsQuery.eq("syllabus_topics.board_id", activeBoard);
  if (activeGrade) documentsQuery = documentsQuery.eq("syllabus_topics.grade_id", activeGrade);
  if (activeSubject) documentsQuery = documentsQuery.eq("syllabus_topics.subject_id", activeSubject);
  if (activeMedium) documentsQuery = documentsQuery.eq("syllabus_topics.medium", activeMedium);
  if (activeSourceType) documentsQuery = documentsQuery.eq("source_type", activeSourceType);
  if (activeSearch) documentsQuery = documentsQuery.ilike("title", `%${activeSearch}%`);

  const [{ data: boards }, { data: grades }, { data: subjects }, { data: documents }, { data: allTopics }, { data: ingestedTopicRows }, { data: offeringRows }] =
    await Promise.all([
      supabase.from("boards").select("*").order("name"),
      supabase.from("grades").select("*").order("level"),
      supabase.from("subjects").select("*").order("name"),
      documentsQuery,
      // Every topic in the catalog, for the coverage section below --
      // syllabus_topics is readable by any authenticated user under RLS
      // (used the same way by the student-facing syllabus panel), but this
      // page already needs the service-role client for chapter_documents
      // anyway, so it's simplest to fetch this through the same client.
      supabase
        .from("syllabus_topics")
        .select("id, board_id, grade_id, subject_id, medium, chapter, topic")
        .order("chapter"),
      // Distinct topic_ids that already have at least one chapter_documents
      // row -- a plain existence check, not the documents themselves (which
      // is what `documents` above is already for).
      supabase.from("chapter_documents").select("topic_id"),
      // Which board/grade/subject combos actually offered to students --
      // same table onboarding itself checks. syllabus_topics can (and does,
      // in practice) carry rows for a board/grade/subject that isn't
      // actually offered any more (e.g. a leftover from before a subject
      // was split/merged) -- without this filter, the coverage section
      // below reports "gaps" for combinations no student could ever
      // actually reach, which reads as inventing subjects that don't
      // exist in the Catalog page's own board/grade/subject offerings.
      supabase.from("board_grade_subjects").select("board_id, grade_id, subject_id"),
    ]);

  const boardNameById = new Map((boards ?? []).map((b) => [b.id, b.name]));
  const gradeNameById = new Map((grades ?? []).map((g) => [g.id, g.name]));
  const subjectNameById = new Map((subjects ?? []).map((s) => [s.id, s.name]));
  const ingestedTopicIds = new Set((ingestedTopicRows ?? []).map((r) => r.topic_id));
  const offeredCombos = new Set((offeringRows ?? []).map((o) => `${o.board_id}|${o.grade_id}|${o.subject_id}`));

  // Grouped by board/grade/subject/medium -- the same scope a student's
  // syllabus panel is itself keyed on -- so an admin sees "which of my
  // actual catalog segments have gaps" rather than a flat, unsorted list of
  // hundreds of individual topics with no sense of where effort matters
  // most. Sorted worst-coverage-first: this is meant to answer "what should
  // I ingest next," not just "what's missing" in catalog order.
  type CoverageGroup = {
    key: string;
    label: string;
    totalTopics: number;
    missingTopics: { chapter: string; topic: string }[];
  };
  const coverageGroups = new Map<string, CoverageGroup>();
  for (const t of allTopics ?? []) {
    // Skip syllabus_topics rows for a board/grade/subject combo that isn't
    // currently offered -- see offeringRows above.
    if (!offeredCombos.has(`${t.board_id}|${t.grade_id}|${t.subject_id}`)) continue;
    const key = `${t.board_id}|${t.grade_id}|${t.subject_id}|${t.medium}`;
    const group = coverageGroups.get(key) ?? {
      key,
      label: `${boardNameById.get(t.board_id) ?? "—"} · ${gradeNameById.get(t.grade_id) ?? "—"} · ${subjectNameById.get(t.subject_id) ?? "—"} · ${t.medium}`,
      totalTopics: 0,
      missingTopics: [],
    };
    group.totalTopics += 1;
    if (!ingestedTopicIds.has(t.id)) group.missingTopics.push({ chapter: t.chapter, topic: t.topic });
    coverageGroups.set(key, group);
  }
  const incompleteGroups = Array.from(coverageGroups.values())
    .filter((g) => g.missingTopics.length > 0)
    .sort((a, b) => b.missingTopics.length - a.missingTopics.length);
  // The complement of incompleteGroups -- named here (not just counted) so
  // an admin checking on one specific segment (e.g. "is CBSE Grade 10
  // Hindi actually done?") can confirm it by name instead of only seeing it
  // folded into the "N other segments fully covered" count below, with no
  // way to tell which N those actually are without querying the database
  // directly.
  const fullyCoveredGroups = Array.from(coverageGroups.values())
    .filter((g) => g.missingTopics.length === 0)
    .sort((a, b) => a.label.localeCompare(b.label));
  const fullyCoveredCount = fullyCoveredGroups.length;

  return (
    <div>
      <h1 className="text-lg font-semibold">Chapter notes</h1>
      <p className="mt-1 text-sm text-foreground/60">
        Detailed, admin-authored chapter content (e.g. a full English-medium literature chapter
        summary), retrieved by meaning during chat so the tutor can ground its answers in the real
        text instead of guessing from the chapter title alone. Prescribed textbooks are copyrighted --
        write these in your own words rather than reproducing/closely paraphrasing a textbook; see{" "}
        <code className="rounded bg-brand/10 px-1 py-0.5">docs/content-authoring-guide.md</code> in the
        repo before authoring content at scale.
      </p>

      <section className="mt-6 rounded-xl border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Ingestion coverage</h2>
          <p className="mt-1 text-xs text-foreground/50">
            Catalog segments (board · grade · subject · medium) with topics that have no chapter
            notes yet -- a chat question here can still be answered, but only from the model&apos;s
            own general knowledge, never grounded in this app&apos;s actual syllabus content.
            {fullyCoveredCount > 0 &&
              ` ${fullyCoveredCount} other segment${fullyCoveredCount === 1 ? "" : "s"} fully covered.`}
          </p>
        </div>
        {incompleteGroups.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-foreground/50">
            Every topic in the catalog has at least one chapter note ingested.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {incompleteGroups.map((group) => (
              <details key={group.key} className="px-4 py-3">
                <summary className="cursor-pointer text-sm">
                  <span className="font-medium">{group.label}</span>{" "}
                  <span className="text-foreground/50">
                    — {group.totalTopics - group.missingTopics.length}/{group.totalTopics} topics ingested
                  </span>
                </summary>
                <ul className="mt-2 space-y-1 pl-4 text-xs text-foreground/60">
                  {group.missingTopics.map((t, i) => (
                    <li key={i}>
                      {t.chapter} — {t.topic}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        )}
        {fullyCoveredGroups.length > 0 && (
          <details className="border-t border-border px-4 py-3">
            <summary className="cursor-pointer text-sm text-foreground/60">
              Show fully covered segments ({fullyCoveredGroups.length})
            </summary>
            <ul className="mt-2 space-y-1 pl-4 text-xs text-foreground/60">
              {fullyCoveredGroups.map((group) => (
                <li key={group.key}>
                  {group.label} — {group.totalTopics}/{group.totalTopics} topics ingested
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <NewChapterDocumentForm boards={boards ?? []} grades={grades ?? []} subjects={subjects ?? []} />
      <ImportChunksForm boards={boards ?? []} grades={grades ?? []} subjects={subjects ?? []} />

      <form method="get" className="mt-6 flex flex-wrap items-center gap-2 text-sm">
        <input
          name="search"
          defaultValue={activeSearch ?? ""}
          placeholder="Search by title"
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        />
        <select
          name="board"
          defaultValue={activeBoard ?? ""}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">Any board</option>
          {(boards ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <select
          name="grade"
          defaultValue={activeGrade ?? ""}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">Any grade</option>
          {(grades ?? []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <select
          name="subject"
          defaultValue={activeSubject ?? ""}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">Any subject</option>
          {(subjects ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          name="medium"
          defaultValue={activeMedium ?? ""}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">Any medium</option>
          {MEDIUMS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select
          name="sourceType"
          defaultValue={activeSourceType ?? ""}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">Any source</option>
          {SOURCE_TYPES.map((t) => (
            <option key={t} value={t}>
              {SOURCE_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <button className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-brand/5">
          Filter
        </button>
        {hasActiveFilter && (
          <a href="/admin/chapter-notes" className="text-xs text-foreground/50 hover:underline">
            Clear filters
          </a>
        )}
      </form>

      <div className="mt-4 space-y-3">
        {(documents ?? []).length === 0 && (
          <p className="text-sm text-foreground/50">
            {hasActiveFilter ? "No chapter documents match this filter." : "No chapter documents yet."}
          </p>
        )}
        {(documents ?? []).map((doc) => {
          // Typed loosely rather than threading a full embedded-query type
          // through -- this page is the only place that shapes this
          // particular join, same pragmatic choice the Answer Bank admin
          // page makes for its own boards(name)/grades(name) embeds.
          const topic = (
            doc as unknown as {
              syllabus_topics: {
                chapter: string;
                topic: string;
                medium: string;
                boards: { name: string } | null;
                grades: { name: string } | null;
                subjects: { name: string } | null;
              } | null;
            }
          ).syllabus_topics;
          const preview =
            doc.content.length > PREVIEW_CHARS ? `${doc.content.slice(0, PREVIEW_CHARS)}…` : doc.content;

          return (
            <div key={doc.id} className="rounded-xl border border-border bg-surface p-4 text-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{doc.title}</p>
                    {/* "Original" (the default, and intended common case) is
                        deliberately not badged -- a badge on every single row
                        for the expected default would just be visual noise;
                        it only earns attention when there's actually
                        something to note. */}
                    {doc.source_type !== "original" && (
                      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700">
                        {SOURCE_TYPE_LABELS[doc.source_type] ?? doc.source_type}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-foreground/50">
                    {topic
                      ? `${topic.boards?.name} · ${topic.grades?.name} · ${topic.subjects?.name} · ${topic.medium} · ${topic.chapter} — ${topic.topic}`
                      : "(topic no longer exists)"}
                  </p>
                  {doc.source_type !== "original" && (doc.source_url || doc.source_note) && (
                    <p className="mt-1 text-xs text-foreground/50">
                      {doc.source_url && (
                        <a
                          href={doc.source_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-brand hover:underline"
                        >
                          {doc.source_url}
                        </a>
                      )}
                      {doc.source_url && doc.source_note && " — "}
                      {doc.source_note}
                    </p>
                  )}
                </div>
                <form action={deleteChapterDocument.bind(null, doc.id)}>
                  <button type="submit" className="text-xs font-medium text-red-600 hover:underline">
                    Delete
                  </button>
                </form>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-foreground/70">{preview}</p>
              <EditChapterDocumentForm
                id={doc.id}
                title={doc.title}
                content={doc.content}
                sourceType={doc.source_type}
                sourceUrl={doc.source_url}
                sourceNote={doc.source_note}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
