"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { splitInlineImages, TextWithInlineImages } from "@/components/text-with-inline-images";

type SearchResult = { question: string; answer: string; image_urls: string[] };

// A dedicated browse/search surface for the answer bank -- distinct from
// the chat timeline's per-topic "Relevant Exercises" bubble (which is
// LLM-backed and generates fresh exercises on a miss): this is read-only
// over whatever's already banked, filterable by tag (e.g. "Ganit Prakash"),
// and works identically on mobile and desktop -- unlike SyllabusPanel,
// which is desktop-only (hidden lg:block), so this is the only way a
// mobile student can browse/search the answer bank at all. Topic-based
// filtering was removed from this panel at the user's request -- topic
// browsing still exists via SyllabusPanel/the mobile Topics tab, which
// drop a summary bubble into the chat timeline instead.
export function PracticePanel({
  subjectId,
  boardId,
  gradeId,
  medium,
  active,
  onAskAbout,
}: {
  subjectId: string;
  // Set only while a staff member is previewing a specific board/grade --
  // included in the two answer-bank fetches below so the server can
  // validate/apply that preview (see resolveStaffPreviewScope) instead of
  // requiring a subscription, which staff never have. Undefined/omitted for
  // a real student, whose scope is always resolved from their subscription
  // server-side regardless of what's sent here.
  boardId?: string | null;
  gradeId?: string | null;
  medium?: string | null;
  // Whether the Practice tab is the one currently showing -- dashboard-shell
  // keeps this panel mounted (just hidden via CSS) when switching tabs, so
  // its already-fetched `results` would otherwise sit stale in memory
  // indefinitely; this is what lets the effect below re-fetch whenever the
  // tab is switched back into, so an admin edit made while the student was
  // on Chat actually shows up instead of requiring a full page reload.
  active: boolean;
  // Switches to the Chat tab and sends a detailed-explanation request for
  // this result, so a student who doesn't follow a banked solution can dig
  // into it conversationally instead of hitting a dead end here -- Practice
  // itself is read-only, with no LLM call of its own.
  onAskAbout: (question: string, answer: string) => void;
}) {
  const [tags, setTags] = useState<string[]>([]);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  // The tag *cloud* (every chip at once) doesn't scale -- a subject with a
  // couple hundred banked questions can easily have 50+ tags, which on a
  // phone-width screen would push the actual results below the fold behind
  // a wall of chips. Instead the chip grid stays collapsed behind this text
  // input until focused, and typing narrows it live -- so browsing the full
  // set is still one tap away, but the common case (student already knows
  // the chapter tag they want, e.g. "7.4") is a few keystrokes instead of
  // hunting through rows of chips.
  const [tagFilter, setTagFilter] = useState("");
  const [tagListOpen, setTagListOpen] = useState(false);
  // Blurred (not preventDefault-ed) via a manual .blur() call after a chip
  // is clicked, so tapping a chip closes the dropdown and dismisses the
  // on-screen keyboard on mobile without needing a separate close button.
  const tagInputRef = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingResults, setLoadingResults] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a slow earlier request (e.g. after quickly switching
  // topics) resolving after a newer one and clobbering fresher results.
  const requestIdRef = useRef(0);
  // Tracks the previous `active` value so the effect below can fire only on
  // the false->true transition (tab just switched into), not on every
  // render while already active -- filter changes while active are already
  // handled by the other effect below.
  const wasActiveRef = useRef(false);

  // Tag suggestions for this subject as a whole -- previously scoped to a
  // selected topic too, but topic filtering was removed from this panel.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const params = new URLSearchParams({ subjectId });
      if (boardId && gradeId && medium) {
        params.set("boardId", boardId);
        params.set("gradeId", gradeId);
        params.set("medium", medium);
      }
      const res = await fetch(`/api/answer-bank/tags?${params.toString()}`);
      const body = await res.json().catch(() => null);
      if (!cancelled && res.ok && Array.isArray(body?.tags)) {
        setTags(body.tags);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [subjectId, boardId, gradeId, medium]);

  const runSearch = useCallback(
    async (offset: number, append: boolean) => {
      const requestId = ++requestIdRef.current;
      if (append) setLoadingMore(true);
      else setLoadingResults(true);
      setError(null);

      const params = new URLSearchParams({ subjectId });
      if (selectedTag) params.set("tag", selectedTag);
      if (offset > 0) params.set("offset", String(offset));
      if (boardId && gradeId && medium) {
        params.set("boardId", boardId);
        params.set("gradeId", gradeId);
        params.set("medium", medium);
      }

      try {
        // no-store, not the default cache mode -- rules out a browser (or
        // any intermediary proxy) serving a stale response for an identical
        // GET URL instead of actually re-querying, on top of everything
        // below that decides *when* to re-run this in the first place.
        const res = await fetch(`/api/answer-bank/search?${params.toString()}`, { cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (requestIdRef.current !== requestId) return; // superseded by a newer search
        if (!res.ok || !Array.isArray(body?.results)) {
          setError(body?.error ?? "Could not search the answer bank.");
          if (!append) {
            setResults(null);
            setHasMore(false);
          }
          return;
        }
        setResults((prev) => (append ? [...(prev ?? []), ...body.results] : body.results));
        setHasMore(Boolean(body.hasMore));
      } catch {
        if (requestIdRef.current === requestId) setError("Could not search the answer bank.");
      } finally {
        if (requestIdRef.current === requestId) {
          if (append) setLoadingMore(false);
          else setLoadingResults(false);
        }
      }
    },
    [subjectId, selectedTag, boardId, gradeId, medium]
  );

  // Auto-searches as soon as a tag is picked -- this is a facet filter, not
  // a form with a separate submit step, so results should track selection
  // immediately. No tag selected means "nothing to search yet," not "show
  // everything" (see the search route's own at-least-one-filter
  // requirement).
  useEffect(() => {
    if (!selectedTag) return;
    void (async () => {
      await runSearch(0, false);
    })();
  }, [selectedTag, runSearch]);

  // Re-fetches whenever the student switches back to this *in-app* tab
  // (Chat -> Practice within the same browser tab), so content edited
  // elsewhere while they were on Chat actually shows up here -- see the
  // `active` prop comment above for why this can't just rely on the effect
  // above it.
  useEffect(() => {
    const justBecameActive = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!justBecameActive) return;
    if (!selectedTag) return;
    void (async () => {
      await runSearch(0, false);
    })();
  }, [active, selectedTag, runSearch]);

  // Same idea, but for the *browser* tab/window regaining focus -- e.g. an
  // admin edit made in a separate browser tab pointed at
  // /admin/answer-bank, then switching back to the one showing this
  // dashboard, with Practice already the active in-app tab the whole time.
  // That's a different browser tab entirely, so nothing above (all in-app
  // React state) would ever observe it happening; only these two events
  // fire on the return trip regardless of which one the browser uses --
  // `visibilitychange` covers switching tabs, `focus` covers switching
  // windows/apps and coming back.
  useEffect(() => {
    function handleFocus() {
      if (document.visibilityState === "hidden") return;
      if (!active) return;
      if (!selectedTag) return;
      void (async () => {
        await runSearch(0, false);
      })();
    }

    document.addEventListener("visibilitychange", handleFocus);
    window.addEventListener("focus", handleFocus);
    return () => {
      document.removeEventListener("visibilitychange", handleFocus);
      window.removeEventListener("focus", handleFocus);
    };
  }, [active, selectedTag, runSearch]);

  function selectTag(t: string) {
    setSelectedTag((cur) => (cur === t ? null : t));
    setTagFilter("");
    setTagListOpen(false);
    tagInputRef.current?.blur();
  }

  const filteredTags = tags.filter((t) => t.toLowerCase().includes(tagFilter.toLowerCase()));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border bg-surface px-6 py-3">
        <h1 className="text-sm font-semibold">Practice</h1>
        <p className="text-xs text-foreground/50">
          Search already-banked questions by tag (e.g. a textbook or exam paper name).
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="space-y-4">
          {tags.length > 0 && (
            <div className="space-y-1.5">
              <div className="relative">
                <input
                  ref={tagInputRef}
                  type="text"
                  // While the dropdown is closed, the field doubles as a
                  // "currently selected tag" readout (like a combobox) --
                  // focusing it clears that back to the raw typed filter so
                  // browsing/typing a fresh query always starts from a blank
                  // slate rather than needing to backspace the old tag out
                  // first.
                  value={tagListOpen ? tagFilter : (selectedTag ?? "")}
                  onFocus={() => {
                    setTagListOpen(true);
                    setTagFilter("");
                  }}
                  onChange={(e) => setTagFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") e.currentTarget.blur();
                  }}
                  onBlur={() => setTagListOpen(false)}
                  placeholder="Filter by tag (e.g. Koshe Dekhi 7.4)…"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-8 text-sm"
                />
                {selectedTag && !tagListOpen && (
                  <button
                    type="button"
                    // mousedown (not click) so this fires before the input's
                    // onBlur would otherwise close the dropdown/clear focus
                    // first -- same reasoning as the chip buttons below.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setSelectedTag(null)}
                    aria-label="Clear tag filter"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground/40 hover:text-foreground"
                  >
                    ✕
                  </button>
                )}
              </div>
              {tagListOpen && (
                <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-surface p-2">
                  {filteredTags.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {filteredTags.map((t) => (
                        <button
                          key={t}
                          type="button"
                          // Prevents the input from blurring on click, which
                          // would otherwise close this dropdown (via onBlur
                          // above) a moment before the click itself even
                          // registers -- selectTag() closes it deliberately
                          // instead, right after applying the selection.
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => selectTag(t)}
                          className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                            selectedTag === t
                              ? "bg-brand text-white"
                              : "bg-brand/10 text-brand hover:bg-brand/20"
                          }`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="px-1 py-1 text-xs text-foreground/50">
                      No tags match &ldquo;{tagFilter}&rdquo;.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <div>
            {!selectedTag ? (
              <p className="text-sm text-foreground/50">Pick a tag above to search.</p>
            ) : loadingResults ? (
              <p className="text-sm text-foreground/50">Searching…</p>
            ) : error ? (
              <p className="text-sm text-red-600">{error}</p>
            ) : results && results.length === 0 ? (
              <p className="text-sm text-foreground/50">No matching questions found.</p>
            ) : (
              <>
                <ol className="space-y-4">
                  {(results ?? []).map((r, i) => {
                    // See text-with-inline-images.tsx -- markers in the
                    // bulk-imported question always precede markers in the
                    // answer in image_urls, so this split recovers which
                    // images belong to which field without storing
                    // anything extra.
                    const { questionImages, answerImages } = splitInlineImages(
                      r.question,
                      r.answer,
                      r.image_urls
                    );
                    const imageClassName = "mx-auto h-auto w-[60%] rounded-lg border border-border object-contain";
                    return (
                      <li key={i} className="rounded-xl border border-border bg-surface p-4 text-sm">
                        <p className="whitespace-pre-wrap font-medium">
                          {i + 1}.{" "}
                          <TextWithInlineImages
                            text={r.question}
                            imageUrls={questionImages}
                            imageClassName={imageClassName}
                          />
                        </p>
                        {r.answer && (
                          <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-background p-3 text-foreground/80">
                            <TextWithInlineImages
                              text={r.answer}
                              imageUrls={answerImages}
                              imageClassName={imageClassName}
                            />
                          </p>
                        )}
                        <button
                          type="button"
                          onClick={() => onAskAbout(r.question, r.answer)}
                          className="mt-2 text-xs font-medium text-brand hover:underline"
                        >
                          Explain further in chat →
                        </button>
                      </li>
                    );
                  })}
                </ol>
                {hasMore && (
                  <button
                    type="button"
                    onClick={() => runSearch(results?.length ?? 0, true)}
                    disabled={loadingMore}
                    className="mt-4 w-full rounded-lg border border-border py-2 text-sm font-medium hover:bg-brand/5 disabled:opacity-60"
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
