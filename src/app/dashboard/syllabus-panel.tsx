"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Medium, SyllabusTopic } from "@/lib/supabase/types";

export function SyllabusPanel({
  boardId,
  gradeId,
  subjectId,
  medium,
  selectedTopicId,
  onSelectTopic,
}: {
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: Medium;
  selectedTopicId: string | null;
  onSelectTopic: (topic: SyllabusTopic) => void;
}) {
  const [topics, setTopics] = useState<SyllabusTopic[]>([]);
  const [loading, setLoading] = useState(true);

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
      <p className="mt-1 px-2 text-xs text-foreground/40">
        Click a topic to drop its summary into the chat. Looking for questions from a specific book
        or exam paper? Try the Practice tab.
      </p>

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
                      onClick={() => onSelectTopic(topic)}
                      className={`block w-full rounded-lg px-2 py-1.5 text-left text-sm transition ${
                        selectedTopicId === topic.id
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
  );
}
