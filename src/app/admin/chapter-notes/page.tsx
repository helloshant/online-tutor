import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { deleteChapterDocument } from "./actions";
import { EditChapterDocumentForm } from "./edit-document-form";
import { ImportChunksForm } from "./import-chunks-form";
import { NewChapterDocumentForm } from "./new-document-form";

// Purely for a readable preview in the list below -- the full text is what
// gets sent to embedding/retrieval, this truncation never touches storage.
const PREVIEW_CHARS = 220;

export default async function ChapterNotesPage() {
  await requireAdminPage("chapter_notes");

  // chapter_documents has RLS enabled with zero client-facing policies
  // (see 0024_chapter_documents_rag.sql) -- same "backend-only table"
  // posture as answered_questions, so this needs the service-role client
  // the same way the Answer Bank admin page does; the ordinary
  // session-scoped client would silently see zero rows.
  const supabase = createAdminClient();

  const [{ data: boards }, { data: grades }, { data: subjects }, { data: documents }, { data: allTopics }, { data: ingestedTopicRows }] =
    await Promise.all([
      supabase.from("boards").select("*").order("name"),
      supabase.from("grades").select("*").order("level"),
      supabase.from("subjects").select("*").order("name"),
      supabase
        .from("chapter_documents")
        .select(
          "*, syllabus_topics(chapter, topic, boards(name), grades(name), subjects(name), medium)"
        )
        .order("created_at", { ascending: false }),
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
    ]);

  const boardNameById = new Map((boards ?? []).map((b) => [b.id, b.name]));
  const gradeNameById = new Map((grades ?? []).map((g) => [g.id, g.name]));
  const subjectNameById = new Map((subjects ?? []).map((s) => [s.id, s.name]));
  const ingestedTopicIds = new Set((ingestedTopicRows ?? []).map((r) => r.topic_id));

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
  const fullyCoveredCount = coverageGroups.size - incompleteGroups.length;

  return (
    <div>
      <h1 className="text-lg font-semibold">Chapter notes</h1>
      <p className="mt-1 text-sm text-foreground/60">
        Detailed, admin-authored chapter content (e.g. a full English-medium literature chapter
        summary), retrieved by meaning during chat so the tutor can ground its answers in the real
        text instead of guessing from the chapter title alone.
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
      </section>

      <NewChapterDocumentForm boards={boards ?? []} grades={grades ?? []} subjects={subjects ?? []} />
      <ImportChunksForm boards={boards ?? []} grades={grades ?? []} subjects={subjects ?? []} />

      <div className="mt-6 space-y-3">
        {(documents ?? []).length === 0 && (
          <p className="text-sm text-foreground/50">No chapter documents yet.</p>
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
                  <p className="font-medium">{doc.title}</p>
                  <p className="text-xs text-foreground/50">
                    {topic
                      ? `${topic.boards?.name} · ${topic.grades?.name} · ${topic.subjects?.name} · ${topic.medium} · ${topic.chapter} — ${topic.topic}`
                      : "(topic no longer exists)"}
                  </p>
                </div>
                <form action={deleteChapterDocument.bind(null, doc.id)}>
                  <button type="submit" className="text-xs font-medium text-red-600 hover:underline">
                    Delete
                  </button>
                </form>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-foreground/70">{preview}</p>
              <EditChapterDocumentForm id={doc.id} title={doc.title} content={doc.content} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
