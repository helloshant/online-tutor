"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Medium, SyllabusTopic } from "@/lib/supabase/types";

export function SyllabusPanel({
  boardId,
  gradeId,
  subjectId,
  medium,
}: {
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: Medium;
}) {
  const [topics, setTopics] = useState<SyllabusTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTopic, setSelectedTopic] = useState<SyllabusTopic | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("syllabus_topics")
        .select("*")
        .eq("board_id", boardId)
        .eq("grade_id", gradeId)
        .eq("subject_id", subjectId)
        .eq("medium", medium)
        .order("sort_order");

      if (!cancelled) {
        setTopics(data ?? []);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [boardId, gradeId, subjectId, medium]);

  const chapters: { chapter: string; topics: SyllabusTopic[] }[] = [];
  for (const topic of topics) {
    const group = chapters.find((c) => c.chapter === topic.chapter);
    if (group) group.topics.push(topic);
    else chapters.push({ chapter: topic.chapter, topics: [topic] });
  }

  return (
    <>
      <aside className="hidden w-80 shrink-0 overflow-y-auto border-r border-border bg-surface p-3 lg:block">
        <h2 className="px-2 text-xs font-semibold uppercase tracking-wide text-foreground/40">Syllabus</h2>

        {loading ? (
          <p className="mt-3 px-2 text-sm text-foreground/50">Loading…</p>
        ) : chapters.length === 0 ? (
          <p className="mt-3 px-2 text-sm text-foreground/50">
            No syllabus entered yet for this subject.
          </p>
        ) : (
          <div className="mt-2 space-y-4">
            {chapters.map((group) => (
              <div key={group.chapter}>
                <h3 className="px-2 text-sm font-semibold text-foreground/80">{group.chapter}</h3>
                <ul className="mt-1 space-y-0.5">
                  {group.topics.map((topic) => (
                    <li key={topic.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedTopic(topic)}
                        className={`block w-full rounded-lg px-2 py-1.5 text-left text-sm transition ${
                          selectedTopic?.id === topic.id
                            ? "bg-brand/10 font-medium text-brand"
                            : "text-foreground/70 hover:bg-brand/5 hover:text-foreground"
                        }`}
                      >
                        {topic.topic}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </aside>

      {selectedTopic && (
        <TopicDetailPanel
          key={selectedTopic.id}
          topic={selectedTopic}
          onClose={() => setSelectedTopic(null)}
        />
      )}
    </>
  );
}

type ExerciseItem = { question: string; answer: string };

// A panel, not a modal: sits alongside the chat (not over it) so a student
// can keep the topic summary/exercises visible while asking the tutor
// follow-up questions about it in the same view.
function TopicDetailPanel({ topic, onClose }: { topic: SyllabusTopic; onClose: () => void }) {
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);

  const [exercises, setExercises] = useState<ExerciseItem[] | null>(null);
  const [exercisesError, setExercisesError] = useState<string | null>(null);
  const [loadingExercises, setLoadingExercises] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/topics/${topic.id}/summary`);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !body?.summary) {
          setSummaryError(body?.error ?? "Could not load the summary.");
          return;
        }
        setSummary(body.summary);
      } catch {
        if (!cancelled) setSummaryError("Could not load the summary.");
      } finally {
        if (!cancelled) setLoadingSummary(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [topic.id]);

  async function handleLoadExercises() {
    setLoadingExercises(true);
    setExercisesError(null);
    try {
      const res = await fetch(`/api/topics/${topic.id}/exercises`);
      const body = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(body?.exercises)) {
        setExercisesError(body?.error ?? "Could not load exercises.");
        return;
      }
      setExercises(body.exercises);
    } catch {
      setExercisesError("Could not load exercises.");
    } finally {
      setLoadingExercises(false);
    }
  }

  return (
    <aside className="hidden w-96 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface lg:flex">
      <div className="flex items-start justify-between gap-3 border-b border-border p-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-foreground/40">{topic.chapter}</p>
          <h3 className="mt-0.5 text-sm font-semibold">{topic.topic}</h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded-lg px-2 py-1 text-foreground/50 hover:bg-brand/5 hover:text-foreground"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-4 p-4">
        {loadingSummary ? (
          <p className="text-sm text-foreground/50">Generating summary…</p>
        ) : summaryError ? (
          <p className="text-sm text-red-600">{summaryError}</p>
        ) : (
          <p className="whitespace-pre-wrap text-sm text-foreground/80">{summary}</p>
        )}

        {!loadingSummary && !summaryError && (
          <div className="border-t border-border pt-4">
            {exercisesError && <p className="mb-2 text-sm text-red-600">{exercisesError}</p>}

            {exercises === null ? (
              <button
                type="button"
                onClick={handleLoadExercises}
                disabled={loadingExercises}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-brand/5 disabled:opacity-60"
              >
                {loadingExercises ? "Finding exercises…" : "Relevant Exercises"}
              </button>
            ) : exercises.length === 0 ? (
              <p className="text-sm text-foreground/50">No exercises available for this topic yet.</p>
            ) : (
              <>
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-foreground/40">
                  Relevant exercises
                </h4>
                <ol className="space-y-5">
                  {exercises.map((ex, i) => (
                    <li key={i}>
                      <p className="text-sm font-medium">
                        {i + 1}. {ex.question}
                      </p>
                      <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-background p-3 text-sm text-foreground/80">
                        {ex.answer}
                      </p>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
