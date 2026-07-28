"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { MathText } from "@/components/math-text";
import type { Medium, SyllabusTopic } from "@/lib/supabase/types";

type SearchResult = { question: string; answer: string };

// A dedicated browse/search surface for the answer bank -- distinct from
// the chat timeline's per-topic "Relevant Exercises" bubble (which is
// LLM-backed and generates fresh exercises on a miss): this is read-only
// over whatever's already banked, filterable by topic, tag, or both at
// once (e.g. "Ganit Prakash exercises for this topic"), and works
// identically on mobile and desktop -- unlike SyllabusPanel, which is
// desktop-only (hidden lg:block), so this is the only way a mobile student
// can browse/search the answer bank at all.
export function PracticePanel({
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
  const [loadingTopics, setLoadingTopics] = useState(true);
  const [selectedTopicId, setSelectedTopicId] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loadingResults, setLoadingResults] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        setLoadingTopics(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [boardId, gradeId, subjectId, medium]);

  // Tag suggestions scoped to the selected topic when there is one, so the
  // chips shown are always ones that could actually return a result rather
  // than every tag that exists anywhere in the subject.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const params = new URLSearchParams({ subjectId });
      if (selectedTopicId) params.set("topicId", selectedTopicId);
      const res = await fetch(`/api/answer-bank/tags?${params.toString()}`);
      const body = await res.json().catch(() => null);
      if (!cancelled && res.ok && Array.isArray(body?.tags)) {
        setTags(body.tags);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [subjectId, selectedTopicId]);

  // Auto-searches as soon as either filter is set -- these are facet
  // filters, not a form with a separate submit step, so results should
  // track selection immediately. Neither filter set means "nothing to
  // search yet," not "show everything" (see the search route's own
  // at-least-one-filter requirement).
  useEffect(() => {
    if (!selectedTopicId && !selectedTag) return;
    let cancelled = false;

    (async () => {
      setLoadingResults(true);
      setError(null);
      const params = new URLSearchParams({ subjectId });
      if (selectedTopicId) params.set("topicId", selectedTopicId);
      if (selectedTag) params.set("tag", selectedTag);
      try {
        const res = await fetch(`/api/answer-bank/search?${params.toString()}`);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !Array.isArray(body?.results)) {
          setError(body?.error ?? "Could not search the answer bank.");
          return;
        }
        setResults(body.results);
      } catch {
        if (!cancelled) setError("Could not search the answer bank.");
      } finally {
        if (!cancelled) setLoadingResults(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [subjectId, selectedTopicId, selectedTag]);

  const chapters: { chapter: string; topics: SyllabusTopic[] }[] = [];
  for (const topic of topics) {
    const group = chapters.find((c) => c.chapter === topic.chapter);
    if (group) group.topics.push(topic);
    else chapters.push({ chapter: topic.chapter, topics: [topic] });
  }

  function handleSelectTopic(value: string) {
    setSelectedTopicId(value);
    setSelectedTag(null);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border bg-surface px-6 py-3">
        <h1 className="text-sm font-semibold">Practice</h1>
        <p className="text-xs text-foreground/50">
          Search already-banked questions by topic, by tag (e.g. a textbook or exam paper), or both
          together.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-2xl space-y-4">
          <select
            value={selectedTopicId}
            onChange={(e) => handleSelectTopic(e.target.value)}
            disabled={loadingTopics}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm disabled:opacity-60"
          >
            <option value="">All topics</option>
            {chapters.map((group) => (
              <optgroup key={group.chapter} label={group.chapter}>
                {group.topics.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.topic}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setSelectedTag((cur) => (cur === t ? null : t))}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                    selectedTag === t ? "bg-brand text-white" : "bg-brand/10 text-brand hover:bg-brand/20"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}

          <div>
            {!selectedTopicId && !selectedTag ? (
              <p className="text-sm text-foreground/50">Pick a topic and/or a tag above to search.</p>
            ) : loadingResults ? (
              <p className="text-sm text-foreground/50">Searching…</p>
            ) : error ? (
              <p className="text-sm text-red-600">{error}</p>
            ) : results && results.length === 0 ? (
              <p className="text-sm text-foreground/50">No matching questions found.</p>
            ) : (
              <ol className="space-y-4">
                {(results ?? []).map((r, i) => (
                  <li key={i} className="rounded-xl border border-border bg-surface p-4 text-sm">
                    <p className="font-medium">
                      {i + 1}. <MathText text={r.question} />
                    </p>
                    <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-background p-3 text-foreground/80">
                      <MathText text={r.answer} />
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
