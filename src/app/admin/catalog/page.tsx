import { requireAdminPage } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Medium } from "@/lib/supabase/types";
import {
  addBoard,
  addGrade,
  addOffering,
  addSubject,
  addSyllabusTopic,
  removeOffering,
  removeSyllabusTopic,
  updateSyllabusTopic,
} from "./actions";

const MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];

export default async function AdminCatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ board?: string; grade?: string; subject?: string; medium?: string }>;
}) {
  await requireAdminPage("catalog");
  const { board: boardId, grade: gradeId, subject: subjectId, medium } = await searchParams;
  const supabase = await createClient();

  const [{ data: boards }, { data: grades }, { data: subjects }, { data: offerings }] = await Promise.all([
    supabase.from("boards").select("*").order("name"),
    supabase.from("grades").select("*").order("level"),
    supabase.from("subjects").select("*").order("name"),
    supabase
      .from("board_grade_subjects")
      .select("*, boards(name), grades(name, level), subjects(name)")
      .order("board_id"),
  ]);

  const topics =
    boardId && gradeId && subjectId && medium
      ? (
          await supabase
            .from("syllabus_topics")
            .select("*")
            .eq("board_id", boardId)
            .eq("grade_id", gradeId)
            .eq("subject_id", subjectId)
            .eq("medium", medium as Medium)
            .order("sort_order")
        ).data
      : [];

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-xl font-semibold">Catalog</h1>
        <p className="mt-1 text-sm text-foreground/60">
          Manage boards, grades, subjects, which subjects each board/grade offers, and the syllabus
          topics used to scope student Q&amp;A.
        </p>
      </div>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-surface p-5">
          <h2 className="text-sm font-semibold">Boards</h2>
          <ul className="mt-3 space-y-1 text-sm text-foreground/70">
            {(boards ?? []).map((b) => (
              <li key={b.id}>{b.name}</li>
            ))}
          </ul>
          <form action={addBoard} className="mt-4 space-y-2">
            <input
              name="name"
              placeholder="Name (e.g. Karnataka Board)"
              required
              className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            />
            <input
              name="code"
              placeholder="Code (e.g. KSEEB)"
              required
              className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            />
            <button className="w-full rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">
              Add board
            </button>
          </form>
        </div>

        <div className="rounded-xl border border-border bg-surface p-5">
          <h2 className="text-sm font-semibold">Grades</h2>
          <ul className="mt-3 space-y-1 text-sm text-foreground/70">
            {(grades ?? []).map((g) => (
              <li key={g.id}>{g.name}</li>
            ))}
          </ul>
          <form action={addGrade} className="mt-4 space-y-2">
            <input
              name="name"
              placeholder="Name (e.g. Grade 11)"
              required
              className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            />
            <input
              name="level"
              type="number"
              placeholder="Level (e.g. 11)"
              required
              className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            />
            <button className="w-full rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">
              Add grade
            </button>
          </form>
        </div>

        <div className="rounded-xl border border-border bg-surface p-5">
          <h2 className="text-sm font-semibold">Subjects</h2>
          <ul className="mt-3 space-y-1 text-sm text-foreground/70">
            {(subjects ?? []).map((s) => (
              <li key={s.id}>{s.name}</li>
            ))}
          </ul>
          <form action={addSubject} className="mt-4 space-y-2">
            <input
              name="name"
              placeholder="Name (e.g. Computer Science)"
              required
              className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            />
            <input
              name="code"
              placeholder="Code (e.g. CS)"
              required
              className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            />
            <button className="w-full rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">
              Add subject
            </button>
          </form>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold">Board / grade / subject offerings</h2>
        <p className="mt-1 text-sm text-foreground/60">
          Which subjects a board offers at a given grade. Students only see subjects offered here.
        </p>

        <form action={addOffering} className="mt-4 flex flex-wrap items-end gap-2">
          <select name="boardId" required className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm">
            <option value="">Board</option>
            {(boards ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select name="gradeId" required className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm">
            <option value="">Grade</option>
            {(grades ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <select name="subjectId" required className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm">
            <option value="">Subject</option>
            {(subjects ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">
            Add offering
          </button>
        </form>

        <div className="mt-5 max-h-80 overflow-y-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-foreground/40">
              <tr>
                <th className="py-1.5">Board</th>
                <th className="py-1.5">Grade</th>
                <th className="py-1.5">Subject</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {(offerings ?? []).map((o) => {
                const board = (o as unknown as { boards: { name: string } | null }).boards;
                const grade = (o as unknown as { grades: { name: string } | null }).grades;
                const subject = (o as unknown as { subjects: { name: string } | null }).subjects;
                return (
                  <tr key={o.id} className="border-t border-border">
                    <td className="py-1.5">{board?.name}</td>
                    <td className="py-1.5">{grade?.name}</td>
                    <td className="py-1.5">{subject?.name}</td>
                    <td className="py-1.5 text-right">
                      <form action={removeOffering.bind(null, o.id)}>
                        <button className="text-xs text-red-600 hover:underline">Remove</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold">Syllabus topics</h2>
        <p className="mt-1 text-sm text-foreground/60">
          The topics used to keep student Q&amp;A confined to what they&apos;re actually meant to be
          learning. Each medium has its own syllabus — a board&apos;s vernacular syllabus (e.g. West
          Bengal Board&apos;s Bengali-medium document) isn&apos;t assumed to be a translation of its
          English-medium one, so enter each one from its own authoritative source. Select a board,
          grade, subject and medium to view or edit that syllabus.
        </p>

        <form method="get" className="mt-4 flex flex-wrap items-end gap-2">
          <select
            name="board"
            defaultValue={boardId ?? ""}
            required
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">Board</option>
            {(boards ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select
            name="grade"
            defaultValue={gradeId ?? ""}
            required
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">Grade</option>
            {(grades ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <select
            name="subject"
            defaultValue={subjectId ?? ""}
            required
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">Subject</option>
            {(subjects ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            name="medium"
            defaultValue={medium ?? ""}
            required
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">Medium</option>
            {MEDIUMS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-brand/5">
            View syllabus
          </button>
        </form>

        {boardId && gradeId && subjectId && medium && (
          <div className="mt-6">
            <form action={addSyllabusTopic} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="boardId" value={boardId} />
              <input type="hidden" name="gradeId" value={gradeId} />
              <input type="hidden" name="subjectId" value={subjectId} />
              <input type="hidden" name="medium" value={medium} />
              <input
                name="chapter"
                placeholder="Chapter"
                required
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
              />
              <input
                name="topic"
                placeholder="Topic description"
                required
                className="min-w-[16rem] flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
              />
              <input
                name="sortOrder"
                type="number"
                placeholder="Order"
                className="w-20 rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
              />
              <button className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">
                Add topic
              </button>
            </form>

            <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-foreground/40">
              {(topics ?? []).length} {medium} topic{(topics ?? []).length === 1 ? "" : "s"}
            </p>
            <div className="mt-2 max-h-[28rem] overflow-y-auto rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-surface text-xs uppercase text-foreground/40">
                  <tr>
                    <th className="px-3 py-2">Chapter</th>
                    <th className="px-3 py-2">Topic</th>
                    <th className="w-20 px-3 py-2">Order</th>
                    <th className="w-32 px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {(topics ?? []).map((t) => (
                    <tr key={t.id} className="border-t border-border align-top">
                      <td colSpan={3} className="p-0">
                        <form
                          id={`syllabus-topic-${t.id}`}
                          action={updateSyllabusTopic.bind(null, t.id)}
                          className="flex items-start gap-2 px-3 py-2"
                        >
                          <input
                            name="chapter"
                            defaultValue={t.chapter}
                            required
                            className="w-40 shrink-0 rounded-lg border border-border bg-background px-2 py-1 text-sm"
                          />
                          <input
                            name="topic"
                            defaultValue={t.topic}
                            required
                            className="min-w-[14rem] flex-1 rounded-lg border border-border bg-background px-2 py-1 text-sm"
                          />
                          <input
                            name="sortOrder"
                            type="number"
                            defaultValue={t.sort_order}
                            className="w-16 shrink-0 rounded-lg border border-border bg-background px-2 py-1 text-sm"
                          />
                        </form>
                      </td>
                      <td className="p-0">
                        <div className="flex items-start gap-2 px-3 py-2">
                          <button
                            type="submit"
                            form={`syllabus-topic-${t.id}`}
                            className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs font-medium hover:bg-brand/5"
                          >
                            Save
                          </button>
                          <form action={removeSyllabusTopic.bind(null, t.id)}>
                            <button className="shrink-0 text-xs text-red-600 hover:underline">
                              Remove
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(topics ?? []).length === 0 && (
              <p className="mt-2 text-sm text-foreground/50">No topics yet for this selection.</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
