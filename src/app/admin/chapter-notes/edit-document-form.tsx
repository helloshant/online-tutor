"use client";

import { useActionState, useEffect, useRef } from "react";
import { saveChapterDocument, type SaveChapterDocumentState } from "./actions";
import { SourceFields } from "./source-fields";
import type { ChapterDocumentSourceType } from "@/lib/supabase/types";

const initialState: SaveChapterDocumentState = {};

// Same "close the disclosure on a successful save" shape as the Answer
// Bank's EditAnswerForm, and the same reason a plain <form action={...}>
// can't do that on its own -- see that component's comment.
export function EditChapterDocumentForm({
  id,
  title,
  content,
  sourceType,
  sourceUrl,
  sourceNote,
}: {
  id: string;
  title: string;
  content: string;
  sourceType: ChapterDocumentSourceType;
  sourceUrl: string | null;
  sourceNote: string | null;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [state, formAction, pending] = useActionState(saveChapterDocument, initialState);

  useEffect(() => {
    if (state.success && detailsRef.current) {
      detailsRef.current.open = false;
    }
  }, [state]);

  return (
    <details ref={detailsRef} className="mt-2">
      <summary className="cursor-pointer text-xs font-medium text-brand hover:underline">Edit</summary>
      <form action={formAction} className="mt-2 space-y-2">
        <input type="hidden" name="id" value={id} />
        {/* Board/grade/subject/medium/topic aren't editable here -- a
            document's scope is fixed at creation (see actions.ts); moving
            it to a different chapter would mean deleting and re-adding it. */}
        <input
          name="title"
          defaultValue={title}
          required
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        />
        <textarea
          name="content"
          defaultValue={content}
          rows={10}
          required
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-sm"
        />
        <SourceFields defaultSourceType={sourceType} defaultSourceUrl={sourceUrl} defaultSourceNote={sourceNote} />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-dark disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {state?.error && <p className="text-xs text-red-600">{state.error}</p>}
        {state?.success && state.embedWarning && (
          <p className="text-xs text-amber-600">
            Saved, but couldn&apos;t re-index it for search right now -- it won&apos;t reflect this
            edit in chat retrieval until a later save succeeds.
          </p>
        )}
      </form>
    </details>
  );
}
