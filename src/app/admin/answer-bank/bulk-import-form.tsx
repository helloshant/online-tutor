"use client";

import { useActionState, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { bulkImportAnswers, type BulkImportState } from "./actions";
import type { Medium } from "@/lib/supabase/types";

const MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];

const initialState: BulkImportState = {};

type CatalogItem = { id: string; name: string };
type TopicOption = { id: string; chapter: string; topic: string };

export function BulkImportForm({
  boards,
  grades,
  subjects,
}: {
  boards: CatalogItem[];
  grades: CatalogItem[];
  subjects: CatalogItem[];
}) {
  const [state, formAction, pending] = useActionState(bulkImportAnswers, initialState);

  // Controlled so a topic dropdown -- scoped to exactly this combination --
  // can be fetched once all four are chosen. Optional: a book chapter or
  // exam paper usually spans several topics, so "no specific topic" stays
  // the default (topicId "").
  const [boardId, setBoardId] = useState("");
  const [gradeId, setGradeId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [medium, setMedium] = useState<Medium | "">("");
  const [topicId, setTopicId] = useState("");
  const [topics, setTopics] = useState<TopicOption[]>([]);
  const hasFullScope = Boolean(boardId && gradeId && subjectId && medium);

  // topicId is reset directly in each scope field's own change handler
  // below, not here -- any state a fetch effect resets as a side effect of
  // its own dependencies changing belongs at the point of the change
  // itself. Likewise, stale `topics` from a previous complete selection
  // simply go unused once hasFullScope is false (see the dropdown below),
  // rather than being cleared here.
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
        Bulk import (e.g. a textbook or past exam paper)
      </summary>
      <form action={formAction} className="space-y-3 px-3 pb-4">
        <p className="text-xs text-foreground/60">
          For real, sourced questions (a textbook&apos;s exercise set, a past exam paper) rather
          than LLM-generated practice — these are stored <b>admin-approved</b> immediately, no
          quality check applied, and tagged so students can find them by source (e.g. &ldquo;Ganit
          Prakash&rdquo; or &ldquo;WBJEE 2023&rdquo;). Each question is checked against what&apos;s
          already banked for this board/grade/subject/medium and skipped if a close match already
          exists, so re-importing the same source twice won&apos;t create duplicates. The{" "}
          <code className="rounded bg-brand/10 px-1 py-0.5">A:</code> line is optional — leave it
          out for a question whose entire answer is a diagram or handwritten working, then attach
          it as an image on that row afterward (below) instead of typing it out.
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
            title={!hasFullScope ? "Select a board, grade, subject, and medium to choose a topic" : undefined}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
          >
            <option value="">No specific topic (spans multiple)</option>
            {hasFullScope &&
              topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.chapter} — {t.topic}
                </option>
              ))}
          </select>
          <input
            name="tags"
            placeholder="Tags, comma-separated (e.g. Ganit Prakash, Chapter 3)"
            className="min-w-[16rem] flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          />
        </div>
        <textarea
          key={state?.success ? "cleared" : "text"}
          name="bulkText"
          rows={8}
          required
          placeholder={
            "Q: <question>\nA: <complete solution>\n---\nQ: <question with an image-only answer>\n---\nQ: <next question>\nA: <its solution>"
          }
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-sm"
        />
        <button
          disabled={pending}
          className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
        >
          {pending ? "Importing…" : "Import"}
        </button>
        {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
        {state?.success && (
          <p className="text-sm text-green-600">
            Imported {state.success.imported} of {state.success.totalParsed} question
            {state.success.totalParsed === 1 ? "" : "s"}
            {state.success.skippedDuplicates > 0
              ? ` (${state.success.skippedDuplicates} skipped as duplicate${
                  state.success.skippedDuplicates === 1 ? "" : "s"
                } of what's already banked)`
              : ""}
            .
            {state.success.importedWithoutAnswer > 0 &&
              ` ${state.success.importedWithoutAnswer} imported with no text answer — attach an image to ${
                state.success.importedWithoutAnswer === 1 ? "it" : "them"
              } below.`}
          </p>
        )}
      </form>
    </details>
  );
}
