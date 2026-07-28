"use client";

import { TopicList } from "./topic-list";
import type { Medium, SyllabusTopic } from "@/lib/supabase/types";

// Desktop-only chrome (hidden lg:block) around the shared TopicList -- the
// mobile equivalent is the "Topics" tab in dashboard-shell.tsx, which
// renders the same TopicList full-width instead of in this narrow sidebar.
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
  return (
    <aside className="hidden w-80 shrink-0 overflow-y-auto border-r border-border bg-surface p-3 lg:block">
      <h2 className="px-2 text-xs font-semibold uppercase tracking-wide text-foreground/40">Syllabus</h2>
      <p className="mt-1 px-2 text-xs text-foreground/40">
        Click a topic to drop its summary into the chat. Looking for questions from a specific book
        or exam paper? Try the Practice tab.
      </p>

      <div className="mt-2">
        <TopicList
          boardId={boardId}
          gradeId={gradeId}
          subjectId={subjectId}
          medium={medium}
          selectedTopicId={selectedTopicId}
          onSelectTopic={onSelectTopic}
        />
      </div>
    </aside>
  );
}
