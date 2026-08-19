"use client";

import { useActionState, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { saveChapterDocument, type SaveChapterDocumentState } from "./actions";
import type { Medium } from "@/lib/supabase/types";

const MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];

const initialState: SaveChapterDocumentState = {};

type CatalogItem = { id: string; name: string };
type TopicOption = { id: string; chapter: string; topic: string };

// Unlike bulk import's topic dropdown (optional -- a book chapter or exam
// paper usually spans several topics), a chapter document is always about
// exactly one topic: it's meant to be quoted at the model as ground truth
// for that specific chapter, so an unscoped document would have nowhere
// correct to be retrieved from (chapter_document_chunks has no nullable
// topic_id).
export function NewChapterDocumentForm({
  boards,
  grades,
  subjects,
}: {
  boards: CatalogItem[];
  grades: CatalogItem[];
  subjects: CatalogItem[];
}) {
  const [state, formAction, pending] = useActionState(saveChapterDocument, initialState);

  const [boardId, setBoardId] = useState("");
  const [gradeId, setGradeId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [medium, setMedium] = useState<Medium | "">("");
  const [topicId, setTopicId] = useState("");
  const [topics, setTopics] = useState<TopicOption[]>([]);
  const hasFullScope = Boolean(boardId && gradeId && subjectId && medium);

  useEffect(() => {
    if (!boardId || !gradeId || !subjectId || !medium) return;
    let cancelled = false;

    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("syllabus_topics")
        .select("id, chapter, topic")
        .eq("board_id", boardId)
        .eq("grade_id", gradeId)
        .eq("subject_id", subjectId)
        .eq("medium", medium)
        .order("sort_order");
      if (!cancelled) setTopics(data ?? []);
    })();

    return () => {
      cancelled = true;
    };
  }, [boardId, gradeId, subjectId, medium]);

  function handleScopeChange(setter: (value: string) => void, value: string) {
    setter(value);
    setTopicId("");
  }

  return (
    <details className="mt-8 rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium hover:bg-brand/5">
        Add a chapter document
      </summary>
      <form action={formAction} className="space-y-3 px-3 pb-4">
        <p className="text-xs text-foreground/60">
          A detailed summary of one chapter&apos;s actual content (e.g. the plot, characters, and
          themes of an English-medium literature chapter) -- unlike the answer bank, which answers
          a specific exercise question, this is reference material the tutor draws on to answer a
          student&apos;s own free-form question about the text. Split into chunks and embedded for
          semantic search on save, so it&apos;s retrieved by meaning, not exact wording.
        </p>
        <div className="flex flex-wrap gap-2">
          <select
            name="boardId"
            value={boardId}
            onChange={(e) => handleScopeChange(setBoardId, e.target.value)}
            required
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">Board</option>
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select
            name="gradeId"
            value={gradeId}
            onChange={(e) => handleScopeChange(setGradeId, e.target.value)}
            required
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">Grade</option>
            {grades.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <select
            name="subjectId"
            value={subjectId}
            onChange={(e) => handleScopeChange(setSubjectId, e.target.value)}
            required
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">Subject</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            name="medium"
            value={medium}
            onChange={(e) => handleScopeChange((v) => setMedium(v as Medium | ""), e.target.value)}
            required
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">Medium</option>
            {MEDIUMS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select
            name="topicId"
            value={topicId}
            onChange={(e) => setTopicId(e.target.value)}
            disabled={!hasFullScope || topics.length === 0}
            required
            title={!hasFullScope ? "Select a board, grade, subject, and medium to choose a topic" : undefined}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
          >
            <option value="">Topic (chapter)</option>
            {hasFullScope &&
              topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.chapter} — {t.topic}
                </option>
              ))}
          </select>
        </div>
        <input
          key={state?.success ? "title-cleared" : "title"}
          name="title"
          placeholder="Title, e.g. &quot;Chapter summary&quot; or &quot;Character notes&quot;"
          required
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        />
        <textarea
          key={state?.success ? "content-cleared" : "content"}
          name="content"
          rows={10}
          placeholder="The detailed chapter content..."
          required
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-sm"
        />
        <button
          disabled={pending}
          className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
        {state?.success && (
          <p className="text-sm text-green-600">
            Saved.
            {state.embedWarning &&
              " Couldn't index it for search right now (the tutor service may be unreachable) -- the text is saved, but won't be retrievable in chat until it's re-saved successfully."}
          </p>
        )}
      </form>
    </details>
  );
}
