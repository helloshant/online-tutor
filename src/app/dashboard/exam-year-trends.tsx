"use client";

import { useEffect, useState } from "react";
import type { Medium, SyllabusTopic } from "@/lib/supabase/types";
import type { YearCoverageResponse, TopicYearCoverage } from "@/app/api/topics/year-coverage/route";

// "Which topics actually came up, in which real exam year" -- the same
// mined years_observed data the pattern picker already suffixes onto a
// pattern name deep inside a chat reply (see pattern-picker.tsx's own
// describeYearsSuffix), surfaced here instead as its own browsable page: a
// student picks one or more years via checkbox and sees every topic that
// had a real, mined question in ANY of them, without first having to know
// (or ask about) that topic by name. Reuses the exact same
// onSelectTopic(topic: SyllabusTopic) hand-off TopicList already uses --
// clicking a topic here drops into the same chat-summary-plus-pattern-
// picker flow, so this page's own job is purely discovery, not a second
// practice UI to keep in sync with the first.
export function ExamYearTrends({
  boardId,
  gradeId,
  subjectId,
  medium,
  onSelectTopic,
}: {
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: Medium;
  onSelectTopic: (topic: SyllabusTopic) => void;
}) {
  const [coverage, setCoverage] = useState<YearCoverageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // Which years are currently checked -- OR'd together (a topic shows if
  // it hit ANY checked year). Defaults to every available year checked
  // once the fetch resolves, so the page opens showing everything rather
  // than an empty grid the student has to first figure out how to
  // populate.
  const [checkedYears, setCheckedYears] = useState<Set<number>>(new Set());

  // No synchronous setLoading(true)/setCoverage(null) reset here on a
  // dependency change -- same posture TopicList's own fetch effect
  // already accepts for its un-keyed mobile-tab instance (see
  // dashboard-shell.tsx: SyllabusPanel is remounted per subject via its
  // own `key`, but the mobile "Topics" tab's TopicList is not, and simply
  // shows the previous subject's data briefly until the new fetch
  // resolves rather than flashing a loading state). This component is
  // used the same un-keyed way in the "trends" tab, so it follows the
  // same accepted trade-off rather than reaching for a synchronous reset
  // React's own docs flag as the anti-pattern to avoid.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const params = new URLSearchParams({ boardId, gradeId, subjectId, medium });
        const res = await fetch(`/api/topics/year-coverage?${params}`);
        if (!res.ok) return;
        const data = (await res.json()) as YearCoverageResponse;
        if (cancelled) return;
        setCoverage(data);
        setCheckedYears(new Set(data.years));
      } catch {
        // Best-effort, same posture as every other archetype-facing
        // surface -- a fetch failure just leaves whatever was showing
        // before (or the initial empty state on first load).
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [boardId, gradeId, subjectId, medium]);

  function toggleYear(year: number) {
    setCheckedYears((prev) => {
      const next = new Set(prev);
      if (next.has(year)) next.delete(year);
      else next.add(year);
      return next;
    });
  }

  if (loading) {
    return <p className="px-2 text-sm text-foreground/50">Loading…</p>;
  }

  if (!coverage || coverage.topics.length === 0) {
    return (
      <p className="px-2 text-sm text-foreground/50">
        No exam-pattern data has been analyzed for this subject yet -- check back once past papers have been reviewed.
      </p>
    );
  }

  const visibleTopics = coverage.topics.filter((t) => t.years.some((y) => checkedYears.has(y)));

  const chapters: { chapter: string; rows: TopicYearCoverage[] }[] = [];
  for (const row of visibleTopics) {
    const group = chapters.find((c) => c.chapter === row.topic.chapter);
    if (group) group.rows.push(row);
    else chapters.push({ chapter: row.topic.chapter, rows: [row] });
  }

  return (
    <div>
      <p className="mb-2 px-2 text-xs text-foreground/40">
        Topics that had a real, mined question in the year(s) you pick below. Tap a topic to see it in chat.
      </p>

      <div className="mb-4 flex flex-wrap gap-1.5 px-2">
        {coverage.years.map((year) => {
          const checked = checkedYears.has(year);
          return (
            <button
              key={year}
              type="button"
              onClick={() => toggleYear(year)}
              aria-pressed={checked}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                checked ? "bg-brand text-white" : "bg-foreground/10 text-foreground/50 hover:bg-foreground/20"
              }`}
            >
              {checked ? "✓ " : ""}
              {year}
            </button>
          );
        })}
      </div>

      {visibleTopics.length === 0 ? (
        <p className="px-2 text-sm text-foreground/50">No topics matched -- pick at least one year above.</p>
      ) : (
        <div className="space-y-4">
          {chapters.map((group) => (
            <div key={group.chapter}>
              <h3 className="px-2 text-sm font-semibold text-foreground/80">{group.chapter}</h3>
              <ul className="mt-1 space-y-0.5">
                {group.rows.map((row) => {
                  // Every year this app has ANY mined data for, not just
                  // the checked ones -- a topic that was asked in every
                  // single year on record is a much stronger revision
                  // signal than one that only happened to hit a year the
                  // student currently has checked.
                  const askedEveryYear = coverage.years.length >= 2 && row.years.length === coverage.years.length;
                  // Same "did it hit a year you actually checked" filter
                  // the top-level row already got -- a sub-topic can have
                  // its own narrower year coverage than its parent (it's
                  // only some of the archetypes contributing to the
                  // parent's own year list), so it needs the same check
                  // rather than inheriting the parent's pass automatically.
                  const visibleSubTopics = row.subTopics.filter((st) => st.years.some((y) => checkedYears.has(y)));
                  return (
                    <li key={row.topic.id}>
                      <button
                        type="button"
                        onClick={() => onSelectTopic(row.topic)}
                        className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground/70 transition hover:bg-brand/5 hover:text-foreground"
                      >
                        <span className="flex items-center gap-1.5">
                          {row.topic.topic}
                          {askedEveryYear && (
                            <span
                              className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                              title="Asked every year this app has mined data for"
                            >
                              🔥 every year
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-[10px] font-medium text-foreground/40">{row.years.join(", ")}</span>
                      </button>
                      {/* Informational only, not its own click target -- there's
                          no finer-grained selection this app's chat flow
                          supports below a syllabus topic, so tapping one of
                          these would have nowhere more specific to go than
                          the parent row above already leads to. */}
                      {visibleSubTopics.length > 0 && (
                        <ul className="ml-4 mt-0.5 space-y-0.5 border-l border-border pl-2">
                          {visibleSubTopics.map((st) => (
                            <li
                              key={st.topic}
                              className="flex items-center justify-between gap-2 px-2 py-0.5 text-xs text-foreground/50"
                            >
                              <span>{st.topic}</span>
                              <span className="shrink-0 text-[10px] text-foreground/35">{st.years.join(", ")}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
