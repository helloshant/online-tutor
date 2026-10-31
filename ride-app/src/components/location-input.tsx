"use client";

import { useEffect, useRef, useState } from "react";
import type { Place } from "@/lib/geo";

type Props = {
  label: string;
  dot: "green" | "red";
  value: Place | null;
  placeholder: string;
  autoFocus?: boolean;
  onSelect: (p: Place) => void;
  onPickOnMap: () => void;
  onUseCurrent?: () => void;
  shortcuts?: { label: string; place: Place }[];
};

export default function LocationInput({
  label,
  dot,
  value,
  placeholder,
  autoFocus,
  onSelect,
  onPickOnMap,
  onUseCurrent,
  shortcuts = [],
}: Props) {
  const [query, setQuery] = useState(value?.name ?? "");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Place[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  // Keep the text in sync when the place is set from elsewhere (map click, swap…).
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setQuery(value?.name ?? "");
  }

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/places?q=${encodeURIComponent(query)}`, { signal: ctrl.signal });
        const data = (await res.json()) as { places: Place[] };
        setResults(data.places);
        setFetchedFor(query);
      } catch {
        /* aborted */
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, open]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const choose = (p: Place) => {
    onSelect(p);
    setQuery(p.name);
    setOpen(false);
  };

  return (
    <div ref={wrap} className="relative">
      <label className="flex items-center gap-3 rounded-xl bg-zinc-100 px-3 py-2.5 focus-within:ring-2 focus-within:ring-amber-400 dark:bg-zinc-800">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot === "green" ? "bg-green-600" : "bg-red-600"}`} />
        <span className="sr-only">{label}</span>
        <input
          className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-500"
          placeholder={placeholder}
          value={query}
          autoFocus={autoFocus}
          aria-label={label}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
        />
        {loading && <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent" />}
      </label>

      {open && (
        <div className="absolute inset-x-0 top-full z-[1100] mt-1 max-h-72 overflow-y-auto rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex gap-2 border-b border-zinc-100 p-2 dark:border-zinc-800">
            {onUseCurrent && (
              <button
                type="button"
                className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium hover:bg-zinc-200 dark:bg-zinc-800"
                onClick={() => {
                  onUseCurrent();
                  setOpen(false);
                }}
              >
                📍 Current location
              </button>
            )}
            <button
              type="button"
              className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium hover:bg-zinc-200 dark:bg-zinc-800"
              onClick={() => {
                onPickOnMap();
                setOpen(false);
              }}
            >
              🗺️ Choose on map
            </button>
            {shortcuts.map((s) => (
              <button
                key={s.label}
                type="button"
                className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium hover:bg-zinc-200 dark:bg-zinc-800"
                onClick={() => choose(s.place)}
              >
                {s.label}
              </button>
            ))}
          </div>
          {results.length === 0 && (
            <p className="p-3 text-sm text-zinc-500">{fetchedFor === query && !loading ? "No places found" : "Searching…"}</p>
          )}
          <ul>
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-amber-50 dark:hover:bg-zinc-800"
                  onClick={() => choose(p)}
                >
                  <span className="mt-0.5">📌</span>
                  <span>
                    <span className="block text-sm font-medium">{p.name}</span>
                    <span className="block text-xs text-zinc-500">{p.address}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
