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

  const [{ data: boards }, { data: grades }, { data: subjects }, { data: documents }] = await Promise.all([
    supabase.from("boards").select("*").order("name"),
    supabase.from("grades").select("*").order("level"),
    supabase.from("subjects").select("*").order("name"),
    supabase
      .from("chapter_documents")
      .select(
        "*, syllabus_topics(chapter, topic, boards(name), grades(name), subjects(name), medium)"
      )
      .order("created_at", { ascending: false }),
  ]);

  return (
    <div>
      <h1 className="text-lg font-semibold">Chapter notes</h1>
      <p className="mt-1 text-sm text-foreground/60">
        Detailed, admin-authored chapter content (e.g. a full English-medium literature chapter
        summary), retrieved by meaning during chat so the tutor can ground its answers in the real
        text instead of guessing from the chapter title alone.
      </p>

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
