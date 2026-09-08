"use client";

import { useMemo, useRef, useState } from "react";
import type { UnmatchedChapterEntry } from "@/lib/archetypeMinerClient";
import { attachChapterMappingAction, ignoreUnmatchedChapterAction } from "../actions";

// Filtering happens entirely client-side against the ONE full list the
// server component already paid the cost of fetching (see page.tsx's own
// comment on why that fetch is expensive) -- a board/grade/subject filter
// here must never trigger a re-fetch of the whole catalogue just to narrow
// what's already in memory.

function entryKey(e: { boardName: string; gradeName: string; subjectName: string; chapter: string }): string {
  return `${e.boardName}|${e.gradeName}|${e.subjectName}|${e.chapter}`;
}

export function UnmatchedChaptersTable({ entries }: { entries: UnmatchedChapterEntry[] }) {
  const [board, setBoard] = useState("");
  const [grade, setGrade] = useState("");
  const [subject, setSubject] = useState("");
  const [search, setSearch] = useState("");

  // Confirmed live: without this, clicking Attach/Ignore did the real
  // write (a plain <form action={serverAction}> round trip through the
  // archetype-miner service) but the row just sat there -- the server
  // action's own revalidatePath() only refreshes the page's data on its
  // NEXT render, and re-deriving that fresh data means re-running the
  // same full-catalogue scan page.tsx's own load already pays for once,
  // so the row could take many seconds to disappear with zero visual
  // feedback in between. removedKeys hides a row THE INSTANT its action
  // is clicked -- optimistic, not waiting on the round trip at all -- and
  // is reset whenever a genuinely fresh `entries` array arrives (a new
  // array reference means the server really did recompute, so any row
  // still ignored/attached is already gone from it and any stale local
  // state should be dropped rather than accidentally hiding a same-named
  // row that reappeared for a different reason).
  const [removedKeys, setRemovedKeys] = useState<Set<string>>(new Set());
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());
  // "Adjusting state when a prop changes" (react.dev) -- a conditional
  // setState call during render, guarded by comparing against the last
  // seen `entries` reference, rather than in a useEffect: React applies it
  // before painting, so there's no flash of stale state and no extra
  // render pass the way a setState-in-effect would cause.
  const [prevEntries, setPrevEntries] = useState(entries);
  if (prevEntries !== entries) {
    setPrevEntries(entries);
    setRemovedKeys(new Set());
    setPendingKeys(new Set());
    setRowErrors(new Map());
  }

  const selectRefs = useRef<Map<string, HTMLSelectElement>>(new Map());

  const visibleEntries = useMemo(() => entries.filter((e) => !removedKeys.has(entryKey(e))), [entries, removedKeys]);

  const boards = useMemo(() => Array.from(new Set(visibleEntries.map((e) => e.boardName))).sort(), [visibleEntries]);
  const grades = useMemo(
    () => Array.from(new Set(visibleEntries.filter((e) => !board || e.boardName === board).map((e) => e.gradeName))).sort(),
    [visibleEntries, board]
  );
  const subjects = useMemo(
    () =>
      Array.from(
        new Set(
          visibleEntries.filter((e) => (!board || e.boardName === board) && (!grade || e.gradeName === grade)).map((e) => e.subjectName)
        )
      ).sort(),
    [visibleEntries, board, grade]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return visibleEntries.filter((e) => {
      if (board && e.boardName !== board) return false;
      if (grade && e.gradeName !== grade) return false;
      if (subject && e.subjectName !== subject) return false;
      if (q && !e.chapter.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [visibleEntries, board, grade, subject, search]);

  const totalQuestions = filtered.reduce((sum, e) => sum + e.questionCount, 0);

  function markPending(key: string, pending: boolean) {
    setPendingKeys((prev) => {
      const next = new Set(prev);
      if (pending) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function setRowError(key: string, message: string | null) {
    setRowErrors((prev) => {
      const next = new Map(prev);
      if (message) next.set(key, message);
      else next.delete(key);
      return next;
    });
  }

  async function handleIgnore(entry: UnmatchedChapterEntry) {
    const key = entryKey(entry);
    setRowError(key, null);
    markPending(key, true);
    // Optimistic -- hide it now, before the round trip even starts.
    setRemovedKeys((prev) => new Set(prev).add(key));
    try {
      const fd = new FormData();
      fd.set("boardName", entry.boardName);
      fd.set("gradeName", entry.gradeName);
      fd.set("subjectName", entry.subjectName);
      fd.set("chapter", entry.chapter);
      await ignoreUnmatchedChapterAction(fd);
    } catch (err) {
      // Revert -- the write didn't actually happen, so the row needs to
      // stay visible rather than silently vanishing forever.
      setRemovedKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setRowError(key, err instanceof Error ? err.message : "Failed to ignore this chapter.");
    } finally {
      markPending(key, false);
    }
  }

  async function handleAttach(entry: UnmatchedChapterEntry) {
    const key = entryKey(entry);
    const select = selectRefs.current.get(key);
    const toChapter = select?.value ?? "";
    if (!toChapter) {
      setRowError(key, "Pick a real chapter to attach to first.");
      return;
    }
    setRowError(key, null);
    markPending(key, true);
    setRemovedKeys((prev) => new Set(prev).add(key));
    try {
      const fd = new FormData();
      fd.set("boardName", entry.boardName);
      fd.set("gradeName", entry.gradeName);
      fd.set("subjectName", entry.subjectName);
      fd.set("fromChapter", entry.chapter);
      fd.set("toChapter", toChapter);
      await attachChapterMappingAction(fd);
    } catch (err) {
      setRemovedKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setRowError(key, err instanceof Error ? err.message : "Failed to attach this chapter.");
    } finally {
      markPending(key, false);
    }
  }

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
            {filtered.map((entry) => {
              const key = entryKey(entry);
              const pending = pendingKeys.has(key);
              const rowError = rowErrors.get(key);
              return (
                <tr key={key} className="border-b border-border align-top">
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
                      <div className="flex items-center gap-2">
                        <select
                          ref={(el) => {
                            if (el) selectRefs.current.set(key, el);
                            else selectRefs.current.delete(key);
                          }}
                          defaultValue=""
                          disabled={pending}
                          className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground disabled:opacity-50"
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
                          type="button"
                          disabled={pending}
                          onClick={() => void handleAttach(entry)}
                          className="shrink-0 rounded-lg bg-purple-600 px-2 py-1 text-xs font-medium text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {pending ? "Attaching…" : "Attach"}
                        </button>
                      </div>
                    )}
                    {rowError && <p className="mt-1 max-w-xs text-xs text-red-600">{rowError}</p>}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      disabled={pending}
                      title="Mark reviewed -- genuinely no real syllabus match"
                      onClick={() => void handleIgnore(entry)}
                      className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs text-foreground/60 hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {pending ? "…" : "Ignore"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
