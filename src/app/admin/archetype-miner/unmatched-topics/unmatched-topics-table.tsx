"use client";

import { useMemo, useRef, useState } from "react";
import type { UnmatchedTopicEntry } from "@/lib/archetypeMinerClient";
import { attachTopicMappingAction, ignoreUnmatchedTopicAction } from "../actions";

// Filtering happens entirely client-side against the ONE full list the
// server component already paid the cost of fetching -- same reasoning as
// UnmatchedChaptersTable's own comment.

function entryKey(e: { boardName: string; gradeName: string; subjectName: string; chapter: string; topic: string }): string {
  return `${e.boardName}|${e.gradeName}|${e.subjectName}|${e.chapter}|${e.topic}`;
}

export function UnmatchedTopicsTable({ entries }: { entries: UnmatchedTopicEntry[] }) {
  const [board, setBoard] = useState("");
  const [grade, setGrade] = useState("");
  const [subject, setSubject] = useState("");
  const [search, setSearch] = useState("");

  // Same optimistic-hide-on-click shape as UnmatchedChaptersTable's own
  // state -- see that component's comment for why: a server action's
  // revalidatePath() only refreshes data on the NEXT render, and
  // re-deriving it means re-running the whole-catalogue scan this page's
  // own load already paid for once.
  const [removedKeys, setRemovedKeys] = useState<Set<string>>(new Set());
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());
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
      if (q && !e.chapter.toLowerCase().includes(q) && !e.topic.toLowerCase().includes(q)) return false;
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

  async function handleIgnore(entry: UnmatchedTopicEntry) {
    const key = entryKey(entry);
    setRowError(key, null);
    markPending(key, true);
    setRemovedKeys((prev) => new Set(prev).add(key));
    try {
      const fd = new FormData();
      fd.set("boardName", entry.boardName);
      fd.set("gradeName", entry.gradeName);
      fd.set("subjectName", entry.subjectName);
      fd.set("chapter", entry.chapter);
      fd.set("topic", entry.topic);
      await ignoreUnmatchedTopicAction(fd);
    } catch (err) {
      setRemovedKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setRowError(key, err instanceof Error ? err.message : "Failed to ignore this topic.");
    } finally {
      markPending(key, false);
    }
  }

  async function handleAttach(entry: UnmatchedTopicEntry) {
    const key = entryKey(entry);
    const select = selectRefs.current.get(key);
    const toTopic = select?.value ?? "";
    if (!toTopic) {
      setRowError(key, "Pick a real topic to attach to first.");
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
      fd.set("chapter", entry.chapter);
      fd.set("fromTopic", entry.topic);
      fd.set("toTopic", toTopic);
      await attachTopicMappingAction(fd);
    } catch (err) {
      setRemovedKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setRowError(key, err instanceof Error ? err.message : "Failed to attach this topic.");
    } finally {
      markPending(key, false);
    }
  }

  return (
    <div>
      <div className="mt-4 flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1 text-xs text-foreground/75">
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
        <label className="flex flex-col gap-1 text-xs text-foreground/75">
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
        <label className="flex flex-col gap-1 text-xs text-foreground/75">
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
        <label className="flex flex-col gap-1 text-xs text-foreground/75">
          Search chapter or topic text
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="e.g. ব্যাকরণ"
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </label>
      </div>

      <p className="mt-3 text-xs text-foreground/75">
        {filtered.length} topic value(s) shown ({totalQuestions} question(s) total) — of {entries.length} unmatched across the whole
        catalogue.
      </p>

      <div className="mt-3 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[1000px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-foreground/5 text-left text-xs uppercase tracking-wide text-foreground/68">
              <th className="px-3 py-2">Board / Grade / Subject</th>
              <th className="px-3 py-2">Section (chapter)</th>
              <th className="px-3 py-2">Mined topic</th>
              <th className="px-3 py-2">Count</th>
              <th className="px-3 py-2">Sample questions</th>
              <th className="px-3 py-2">Attach to real topic</th>
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
                  <td className="whitespace-nowrap px-3 py-2 text-foreground/82">
                    {entry.boardName} · Grade {entry.gradeName}
                    <br />
                    {entry.subjectName}
                  </td>
                  <td className="px-3 py-2 text-foreground/75">{entry.chapter}</td>
                  <td className="px-3 py-2 font-medium">{entry.topic}</td>
                  <td className="px-3 py-2">{entry.questionCount}</td>
                  <td className="px-3 py-2">
                    {entry.sampleQuestions.length === 0 ? (
                      <span className="text-xs text-foreground/65">No sample text available</span>
                    ) : (
                      entry.sampleQuestions.map((s) => (
                        <details key={s.ref} className="mb-1">
                          <summary className="cursor-pointer text-xs text-brand hover:underline">Sample</summary>
                          {s.concept && <p className="mt-1 max-w-sm text-xs font-medium text-foreground/82">Concept: {s.concept}</p>}
                          <p className="mt-1 max-w-sm whitespace-pre-wrap text-xs text-foreground/82">{s.text}</p>
                        </details>
                      ))
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {entry.acceptableTopics.length === 0 ? (
                      <span className="text-xs text-foreground/65">No real topics found for this section</span>
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
                            Select a real topic…
                          </option>
                          {entry.acceptableTopics.map((v) => (
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
                      title="Mark reviewed -- genuinely no real topic match"
                      onClick={() => void handleIgnore(entry)}
                      className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs text-foreground/75 hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-50"
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
