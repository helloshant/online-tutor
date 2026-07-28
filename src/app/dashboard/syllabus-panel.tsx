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
  onSearchTag,
}: {
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: Medium;
  selectedTopicId: string | null;
  onSelectTopic: (topic: SyllabusTopic) => void;
  onSearchTag: (tag: string) => void;
}) {
  const [topics, setTopics] = useState<SyllabusTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");

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

  // Suggests real tag values (e.g. "Ganit Prakash", "WBJEE 2023") instead of
  // asking the student to guess exact tag text blind -- only entries an
  // admin has tagged show up here at all, so an empty list is expected
  // until some exist for this subject.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const res = await fetch(`/api/answer-bank/tags?subjectId=${encodeURIComponent(subjectId)}`);
      const body = await res.json().catch(() => null);
      if (!cancelled && res.ok && Array.isArray(body?.tags)) {
        setAvailableTags(body.tags);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [subjectId]);

  function handleTagSearch(e: React.FormEvent) {
    e.preventDefault();
    const tag = tagInput.trim();
    if (!tag) return;
    onSearchTag(tag);
    setTagInput("");
  }

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
        Click a topic to drop its summary into the chat.
      </p>

      <form onSubmit={handleTagSearch} className="mt-3 px-2">
        <label className="text-xs font-semibold uppercase tracking-wide text-foreground/40">
          Search by tag
        </label>
        <div className="mt-1 flex gap-1.5">
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            list="answer-bank-tags"
            placeholder="e.g. Ganit Prakash, WBJEE 2023"
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-brand"
          />
          <datalist id="answer-bank-tags">
            {availableTags.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <button
            type="submit"
            disabled={!tagInput.trim()}
            className="shrink-0 rounded-lg border border-border px-2 py-1.5 text-xs font-medium hover:bg-brand/5 disabled:opacity-50"
          >
            Search
          </button>
        </div>
      </form>

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
