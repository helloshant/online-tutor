"use client";

import { useActionState, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { importChapterChunksJson, type ImportChapterChunksState } from "./actions";
import { SourceFields } from "./source-fields";
import type { Medium } from "@/lib/supabase/types";

const MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];

const initialState: ImportChapterChunksState = {};

type CatalogItem = { id: string; name: string };

// Bulk counterpart to NewChapterDocumentForm, for content prepared offline
// as pre-chunked JSON (chunks already split along real structural
// boundaries, each optionally carrying its own field_type/citation) rather
// than typed/pasted as one block of text for this app's own naive
// paragraph-based chunker to re-split. Scoped to a whole *book* (a
// syllabus_topics "chapter" grouping, e.g. "Prose and Poetry" -- which
// commonly holds several distinct topics, one per story/poem), not one
// specific topic: the file's own chapter_title per chunk is matched against
// the existing topics under that book (a new topic is created if a title
// doesn't match one already there), so a single import can span every
// story in the book without the admin picking one topic at a time. See
// importChapterChunksJson in ./actions.ts for the matching logic.
export function ImportChunksForm({
  boards,
  grades,
  subjects,
}: {
  boards: CatalogItem[];
  grades: CatalogItem[];
  subjects: CatalogItem[];
}) {
  const [state, formAction, pending] = useActionState(importChapterChunksJson, initialState);

  const [boardId, setBoardId] = useState("");
  const [gradeId, setGradeId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [medium, setMedium] = useState<Medium | "">("");
  const [book, setBook] = useState("");
  // Existing "chapter" (book) names for this scope, offered as suggestions
  // -- a free-text input, not a <select>, since the very first import for a
  // brand-new book has nothing to pick from yet and still needs to work.
  const [bookOptions, setBookOptions] = useState<string[]>([]);
  const hasFullScope = Boolean(boardId && gradeId && subjectId && medium);

  useEffect(() => {
    if (!boardId || !gradeId || !subjectId || !medium) return;
    let cancelled = false;

    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("syllabus_topics")
        .select("chapter")
        .eq("board_id", boardId)
        .eq("grade_id", gradeId)
        .eq("subject_id", subjectId)
        .eq("medium", medium)
        .order("sort_order");
      if (!cancelled) setBookOptions(Array.from(new Set((data ?? []).map((t) => t.chapter))));
    })();

    return () => {
      cancelled = true;
    };
  }, [boardId, gradeId, subjectId, medium]);

  function handleScopeChange(setter: (value: string) => void, value: string) {
    setter(value);
    setBook("");
  }

  return (
    <details className="mt-4 rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium hover:bg-brand/5">
        Bulk import from JSON (pre-chunked)
      </summary>
      <form action={formAction} encType="multipart/form-data" className="space-y-3 px-3 pb-4">
        <p className="text-xs text-foreground/60">
          For content prepared offline with chunks already split along real boundaries (chapter
          overview, plot summary, one entry per vocabulary word, etc.), each optionally carrying its
          own citation -- a top-level <code className="rounded bg-brand/10 px-1 py-0.5">chunks</code>{" "}
          array, each entry with numeric <code className="rounded bg-brand/10 px-1 py-0.5">chapter_number</code>,
          string <code className="rounded bg-brand/10 px-1 py-0.5">chapter_title</code> and{" "}
          <code className="rounded bg-brand/10 px-1 py-0.5">text</code>, and optional{" "}
          <code className="rounded bg-brand/10 px-1 py-0.5">field_type</code>/
          <code className="rounded bg-brand/10 px-1 py-0.5">citation</code>. Scoped to a whole{" "}
          <b>book</b> (e.g. &ldquo;Prose and Poetry&rdquo;), not one chapter at a time -- each distinct{" "}
          <code className="rounded bg-brand/10 px-1 py-0.5">chapter_title</code> in the file is matched
          against the syllabus topics already entered under that book (a new topic is added
          automatically if none matches), and becomes its own chapter document there. Re-uploading a
          corrected file updates those same chapters rather than duplicating them. Chunks are embedded
          exactly as given, not re-split, so their field-type/citation metadata is preserved (unlike
          editing a chapter through the plain text form above, which re-chunks generically -- to
          update one of these chapters, re-run this import instead).
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
          <input
            name="chapter"
            value={book}
            onChange={(e) => setBook(e.target.value)}
            disabled={!hasFullScope}
            required
            list="chapter-notes-book-options"
            placeholder="Book (e.g. Prose and Poetry)"
            title={!hasFullScope ? "Select a board, grade, subject, and medium first" : undefined}
            className="min-w-[16rem] rounded-lg border border-border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
          />
          <datalist id="chapter-notes-book-options">
            {bookOptions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        <input
          key={state?.success ? "file-cleared" : "file"}
          type="file"
          name="file"
          accept=".json,application/json"
          required
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs file:mr-2 file:rounded file:border-0 file:bg-brand/10 file:px-2 file:py-1 file:text-xs"
        />
        {/* Applies to every chapter this file creates/updates -- a single
            offline authoring pass over one file has one provenance story,
            not one per chapter. */}
        <SourceFields />
        <button
          disabled={pending}
          className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
        >
          {pending ? "Importing…" : "Import"}
        </button>
        {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
        {state?.success && (
          <div className="space-y-1">
            <p className="text-sm text-green-600">
              Imported {state.success.chaptersImported} chapter
              {state.success.chaptersImported === 1 ? "" : "s"} ({state.success.chunksImported} chunk
              {state.success.chunksImported === 1 ? "" : "s"} total)
              {state.success.topicsCreated > 0 &&
                `, adding ${state.success.topicsCreated} new syllabus topic${
                  state.success.topicsCreated === 1 ? "" : "s"
                } to this book`}
              .
            </p>
            {state.success.embedFailures.length > 0 && (
              <p className="text-sm text-amber-600">
                Couldn&apos;t index for search right now (the tutor service may be unreachable):{" "}
                {state.success.embedFailures.join(", ")}. The text is saved -- re-run this import to
                retry.
              </p>
            )}
          </div>
        )}
      </form>
    </details>
  );
}
