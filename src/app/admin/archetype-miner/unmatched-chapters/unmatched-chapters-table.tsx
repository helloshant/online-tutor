"use client";

import { useMemo, useState } from "react";
import type { UnmatchedChapterEntry } from "@/lib/archetypeMinerClient";
import { attachChapterMappingAction, ignoreUnmatchedChapterAction } from "../actions";

// Filtering happens entirely client-side against the ONE full list the
// server component already paid the cost of fetching (see page.tsx's own
// comment on why that fetch is expensive) -- a board/grade/subject filter
// here must never trigger a re-fetch of the whole catalogue just to narrow
// what's already in memory.
export function UnmatchedChaptersTable({ entries }: { entries: UnmatchedChapterEntry[] }) {
  const [board, setBoard] = useState("");
  const [grade, setGrade] = useState("");
  const [subject, setSubject] = useState("");
  const [search, setSearch] = useState("");

  const boards = useMemo(() => Array.from(new Set(entries.map((e) => e.boardName))).sort(), [entries]);
  const grades = useMemo(
    () => Array.from(new Set(entries.filter((e) => !board || e.boardName === board).map((e) => e.gradeName))).sort(),
    [entries, board]
  );
  const subjects = useMemo(
    () =>
      Array.from(
        new Set(entries.filter((e) => (!board || e.boardName === board) && (!grade || e.gradeName === grade)).map((e) => e.subjectName))
      ).sort(),
    [entries, board, grade]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (board && e.boardName !== board) return false;
      if (grade && e.gradeName !== grade) return false;
      if (subject && e.subjectName !== subject) return false;
      if (q && !e.chapter.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, board, grade, subject, search]);

  const totalQuestions = filtered.reduce((sum, e) => sum + e.questionCount, 0);

  return (
    <div>
      <div className="mt-4 flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Board
          <select
            value={board}
            onChange={(e) => {
              setBoard(e.target.value);
              setGrade("");
              setSubject("");
            }}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">All boards</option>
            {boards.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Grade / year
          <select
            value={grade}
            onChange={(e) => {
              setGrade(e.target.value);
              setSubject("");
            }}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">All grades</option>
            {grades.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Subject
          <select
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">All subjects</option>
            {subjects.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Search chapter text
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="e.g. Grammar"
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </label>
      </div>

      <p className="mt-3 text-xs text-foreground/60">
        {filtered.length} chapter value(s) shown ({totalQuestions} question(s) total) — of {entries.length} unmatched across the whole
        catalogue.
      </p>

      <div className="mt-3 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-foreground/5 text-left text-xs uppercase tracking-wide text-foreground/50">
              <th className="px-3 py-2">Board / Grade / Subject</th>
              <th className="px-3 py-2">Mined chapter</th>
              <th className="px-3 py-2">Count</th>
              <th className="px-3 py-2">Sample questions</th>
              <th className="px-3 py-2">Attach to real syllabus entry</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((entry) => (
              <tr key={`${entry.boardName}|${entry.gradeName}|${entry.subjectName}|${entry.chapter}`} className="border-b border-border align-top">
                <td className="whitespace-nowrap px-3 py-2 text-foreground/70">
                  {entry.boardName} · Grade {entry.gradeName}
                  <br />
                  {entry.subjectName}
                </td>
                <td className="px-3 py-2 font-medium">{entry.chapter}</td>
                <td className="px-3 py-2">{entry.questionCount}</td>
                <td className="px-3 py-2">
                  {entry.sampleQuestions.length === 0 ? (
                    <span className="text-xs text-foreground/40">No sample text available</span>
                  ) : (
                    entry.sampleQuestions.map((s) => (
                      <details key={s.ref} className="mb-1">
                        <summary className="cursor-pointer text-xs text-brand hover:underline">Sample</summary>
                        <p className="mt-1 max-w-sm whitespace-pre-wrap text-xs text-foreground/70">{s.text}</p>
                      </details>
                    ))
                  )}
                </td>
                <td className="px-3 py-2">
                  {entry.acceptableValues.length === 0 ? (
                    <span className="text-xs text-foreground/40">No syllabus_topics rows for this scope</span>
                  ) : (
                    <form action={attachChapterMappingAction} className="flex items-center gap-2">
                      <input type="hidden" name="boardName" value={entry.boardName} />
                      <input type="hidden" name="gradeName" value={entry.gradeName} />
                      <input type="hidden" name="subjectName" value={entry.subjectName} />
                      <input type="hidden" name="fromChapter" value={entry.chapter} />
                      <select
                        name="toChapter"
                        required
                        defaultValue=""
                        className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground"
                      >
                        <option value="" disabled>
                          Select a real chapter…
                        </option>
                        {entry.acceptableValues.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                      <button
                        type="submit"
                        className="shrink-0 rounded-lg bg-purple-600 px-2 py-1 text-xs font-medium text-white hover:bg-purple-700"
                      >
                        Attach
                      </button>
                    </form>
                  )}
                </td>
                <td className="px-3 py-2">
                  <form action={ignoreUnmatchedChapterAction}>
                    <input type="hidden" name="boardName" value={entry.boardName} />
                    <input type="hidden" name="gradeName" value={entry.gradeName} />
                    <input type="hidden" name="subjectName" value={entry.subjectName} />
                    <input type="hidden" name="chapter" value={entry.chapter} />
                    <button
                      type="submit"
                      title="Mark reviewed -- genuinely no real syllabus match"
                      className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs text-foreground/60 hover:bg-foreground/5"
                    >
                      Ignore
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
