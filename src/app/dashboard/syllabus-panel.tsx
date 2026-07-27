"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Exercise, Medium, SyllabusTopic } from "@/lib/supabase/types";

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
                      className="block w-full rounded-lg px-2 py-1.5 text-left text-sm text-foreground/70 transition hover:bg-brand/5 hover:text-foreground"
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

      {selectedTopic && (
        <ExerciseModal topic={selectedTopic} onClose={() => setSelectedTopic(null)} />
      )}
    </aside>
  );
}

function ExerciseModal({ topic, onClose }: { topic: SyllabusTopic; onClose: () => void }) {
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("topic_exercises")
        .select("*")
        .eq("topic_id", topic.id)
        .order("sort_order");

      if (!cancelled) {
        setExercises(data ?? []);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [topic.id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="exercise-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl bg-surface shadow-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-foreground/40">
              {topic.chapter}
            </p>
            <h3 id="exercise-modal-title" className="mt-0.5 text-sm font-semibold">
              {topic.topic}
            </h3>
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

        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <p className="text-sm text-foreground/50">Loading…</p>
          ) : exercises.length === 0 ? (
            <p className="text-sm text-foreground/50">No exercises entered yet for this topic.</p>
          ) : (
            <ol className="space-y-5">
              {exercises.map((ex, i) => (
                <li key={ex.id}>
                  <p className="text-sm font-medium">
                    {i + 1}. {ex.question}
                  </p>
                  <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-background p-3 text-sm text-foreground/80">
                    {ex.solution}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
