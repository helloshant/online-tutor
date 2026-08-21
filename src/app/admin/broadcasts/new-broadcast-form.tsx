"use client";

import { useActionState } from "react";
import { createBroadcast, type SaveBroadcastState } from "./actions";
import type { BroadcastType, Medium } from "@/lib/supabase/types";

const MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];
const TYPES: { value: BroadcastType; label: string; hint: string }[] = [
  { value: "announcement", label: "Announcement", hint: "A plain notice -- shown in the student's inbox." },
  { value: "promotion", label: "Promotion", hint: "Marketing/offer content -- same delivery as an announcement." },
  { value: "feedback", label: "Feedback request", hint: "Students can leave a 1-5 rating and an optional comment." },
  { value: "test", label: "Test", hint: "Add MCQ/short-answer questions after creating the draft, then Send." },
];

const initialState: SaveBroadcastState = {};

type CatalogItem = { id: string; name: string };

export function NewBroadcastForm({
  boards,
  grades,
  subjects,
}: {
  boards: CatalogItem[];
  grades: CatalogItem[];
  subjects: CatalogItem[];
}) {
  const [state, formAction, pending] = useActionState(createBroadcast, initialState);

  return (
    <details className="mt-6 rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium hover:bg-brand/5">
        New broadcast
      </summary>
      <form action={formAction} className="space-y-3 px-3 pb-4">
        <div className="flex flex-wrap gap-2">
          {TYPES.map((t) => (
            <label
              key={t.value}
              className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs has-[:checked]:border-brand has-[:checked]:bg-brand/5"
            >
              <input type="radio" name="type" value={t.value} defaultChecked={t.value === "announcement"} className="mt-0.5" />
              <span>
                <span className="block font-medium text-foreground">{t.label}</span>
                <span className="block text-foreground/50">{t.hint}</span>
              </span>
            </label>
          ))}
        </div>

        <input
          key={state?.success ? "title-cleared" : "title"}
          name="title"
          placeholder="Title"
          required
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        />
        <textarea
          key={state?.success ? "body-cleared" : "body"}
          name="body"
          rows={4}
          placeholder="Message"
          required
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        />

        <p className="text-xs text-foreground/50">
          Who this reaches -- leave any of these on &quot;All&quot; to not filter by that dimension.
        </p>
        <div className="flex flex-wrap gap-2">
          <select name="boardId" className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm">
            <option value="">All boards</option>
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select name="gradeId" className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm">
            <option value="">All grades</option>
            {grades.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <select name="subjectId" className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm">
            <option value="">All subjects</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select name="medium" className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm">
            <option value="">All mediums</option>
            {MEDIUMS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        <button
          disabled={pending}
          className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
        >
          {pending ? "Creating…" : "Create draft"}
        </button>
        {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
        {state?.success && (
          <p className="text-sm text-green-600">
            Draft created below. Nothing is sent yet -- open it to review (and, for a test, add
            questions) before sending.
          </p>
        )}
      </form>
    </details>
  );
}
