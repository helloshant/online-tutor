import type { Medium } from "@/lib/supabase/types";

const MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];

// Lets a staff member preview a specific board/grade/medium -- exactly what
// a student under that combination sees (syllabus scoping, RAG grounding,
// the answer bank), instead of only ever getting the unrestricted "ask
// anything" mode staff chat has always been. A plain GET form (same
// pattern as /admin/catalog's own board/grade/subject/medium filter) rather
// than client-side navigation -- picking a combination is just a normal
// link to a different /dashboard?board=..&grade=..&medium=.. URL, so
// dashboard/page.tsx (a server component) can re-resolve and validate it
// fresh on every submission, the same way it already does on first load.
// No "use client" needed here: a GET form works with zero JS, even though
// this renders inside dashboard-shell.tsx's client component tree.
export function StaffPreviewPicker({
  boards,
  grades,
  boardId,
  gradeId,
  medium,
}: {
  boards: { id: string; name: string }[];
  grades: { id: string; name: string }[];
  boardId: string | null;
  gradeId: string | null;
  medium: Medium | null;
}) {
  const isPreviewing = Boolean(boardId && gradeId && medium);

  return (
    <form method="get" action="/dashboard" className="flex flex-wrap items-center gap-1.5">
      <select
        name="board"
        defaultValue={boardId ?? ""}
        className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground"
      >
        <option value="">Board</option>
        {boards.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <select
        name="grade"
        defaultValue={gradeId ?? ""}
        className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground"
      >
        <option value="">Grade</option>
        {grades.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
      <select
        name="medium"
        defaultValue={medium ?? ""}
        className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground"
      >
        <option value="">Medium</option>
        {MEDIUMS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="rounded-lg bg-brand px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-dark"
      >
        {isPreviewing ? "Switch" : "Preview as student"}
      </button>
      {isPreviewing && (
        <a href="/dashboard" className="text-xs text-foreground/50 hover:text-foreground hover:underline">
          Exit preview
        </a>
      )}
    </form>
  );
}
