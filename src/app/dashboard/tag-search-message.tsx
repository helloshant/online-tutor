"use client";

import { useEffect, useState } from "react";
import { MathText } from "@/components/math-text";

type SearchResult = { question: string; answer: string };

// Rendered as a message bubble inside the chat timeline (see chat-panel.tsx),
// same pattern as TopicSummaryMessage -- a tag search dropped straight into
// the conversation rather than a separate panel or modal. Unlike
// TopicSummaryMessage, there's no summary step first: a tag search either
// has results or it doesn't, fetched once on mount.
export function TagSearchMessage({ tag, subjectId }: { tag: string; subjectId: string }) {
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(
          `/api/answer-bank/search?subjectId=${encodeURIComponent(subjectId)}&tag=${encodeURIComponent(tag)}`
        );
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
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tag, subjectId]);

  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] space-y-3 rounded-2xl border border-border bg-surface px-4 py-3 text-sm">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-foreground/40">Tag search</p>
          <p className="font-semibold">&ldquo;{tag}&rdquo;</p>
        </div>

        {loading ? (
          <p className="text-foreground/50">Searching…</p>
        ) : error ? (
          <p className="text-red-600">{error}</p>
        ) : results && results.length === 0 ? (
          <p className="text-foreground/50">No entries tagged &ldquo;{tag}&rdquo; for this subject yet.</p>
        ) : (
          <ol className="space-y-4">
            {(results ?? []).map((r, i) => (
              <li key={i}>
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
  );
}
