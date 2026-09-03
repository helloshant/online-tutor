"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Medium, SyllabusTopic } from "@/lib/supabase/types";
import type { ArchetypeProgressResponse } from "@/app/api/topics/archetype-progress/route";

// Fetches and renders the chapter/topic list for a board/grade/subject/medium
// scope -- shared by SyllabusPanel (the desktop sidebar, hidden lg:block) and
// the mobile "Topics" tab in dashboard-shell.tsx, which differ only in outer
// framing (a narrow persistent aside vs a full-width tab panel), not in what
// gets fetched or what a topic click does.
export function TopicList({
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
  // chapter/topic -> {total, practiced} -- "N of M known patterns
  // practiced" per topic (see /api/topics/archetype-progress's own
  // comment on exactly what "practiced" does and doesn't claim). A topic
  // with no key here, or total 0, has nothing mined for it yet -- the
  // badge is simply omitted rather than shown as "0/0". Best-effort: a
  // fetch failure here just means no badges show, never a broken topic
  // list, so this is fetched separately from `topics` above rather than
  // blocking on it.
  const [progress, setProgress] = useState<Map<string, { total: number; practiced: number }>>(new Map());

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

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const params = new URLSearchParams({ boardId, gradeId, subjectId, medium });
        const res = await fetch(`/api/topics/archetype-progress?${params}`);
        if (!res.ok) return;
        const data = (await res.json()) as ArchetypeProgressResponse;
        if (cancelled) return;
        const map = new Map<string, { total: number; practiced: number }>();
        for (const p of data.progress) {
          if (p.total > 0) map.set(`${p.chapter}::${p.topic}`, { total: p.total, practiced: p.practiced });
        }
        setProgress(map);
      } catch {
        // Best-effort, see the state's own comment -- nothing to do here.
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

  if (loading) {
    return <p className="px-2 text-sm text-foreground/50">Loading…</p>;
  }
  if (chapters.length === 0) {
    return <p className="px-2 text-sm text-foreground/50">No syllabus entered yet for this subject.</p>;
  }

  return (
    <div className="space-y-4">
      {chapters.map((group) => (
        <div key={group.chapter}>
          <h3 className="px-2 text-sm font-semibold text-foreground/80">{group.chapter}</h3>
          <ul className="mt-1 space-y-0.5">
            {group.topics.map((topic) => {
              const stats = progress.get(`${topic.chapter}::${topic.topic}`);
              return (
                <li key={topic.id}>
                  <button
                    type="button"
                    onClick={() => onSelectTopic(topic)}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition ${
                      selectedTopicId === topic.id
                        ? "bg-brand/10 font-medium text-brand"
                        : "text-foreground/70 hover:bg-brand/5 hover:text-foreground"
                    }`}
                  >
                    <span>{topic.topic}</span>
                    {/* "Practiced" here only ever means "shown a generated
                        exercise for this pattern" -- there's no answer-
                        grading step anywhere in this app to claim mastery
                        from, see the badge's own title text below. */}
                    {stats && (
                      <span
                        className="shrink-0 rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground/50"
                        title={`${stats.practiced} of ${stats.total} known exam patterns practiced for this topic`}
                      >
                        {stats.practiced}/{stats.total}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
