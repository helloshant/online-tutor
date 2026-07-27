import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { addExercise, bulkAddExercises, removeExercise, updateExercise } from "../../actions";

export default async function TopicExercisesPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage("catalog");
  const { id: topicId } = await params;
  const supabase = await createClient();

  const [{ data: topic }, { data: exercises }] = await Promise.all([
    supabase
      .from("syllabus_topics")
      .select("*, boards(name), grades(name), subjects(name)")
      .eq("id", topicId)
      .maybeSingle(),
    supabase.from("topic_exercises").select("*").eq("topic_id", topicId).order("sort_order"),
  ]);

  if (!topic) notFound();

  const board = (topic as unknown as { boards: { name: string } | null }).boards;
  const grade = (topic as unknown as { grades: { name: string } | null }).grades;
  const subject = (topic as unknown as { subjects: { name: string } | null }).subjects;

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`/admin/catalog?board=${topic.board_id}&grade=${topic.grade_id}&subject=${topic.subject_id}&medium=${topic.medium}`}
          className="text-sm text-brand hover:underline"
        >
          ← Back to syllabus
        </Link>
        <h1 className="mt-2 text-xl font-semibold">{topic.topic}</h1>
        <p className="mt-1 text-sm text-foreground/60">
          {topic.chapter} · {subject?.name} · {grade?.name} · {board?.name} · {topic.medium}
        </p>
      </div>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold">Add an exercise</h2>
        <form action={addExercise.bind(null, topicId)} className="mt-3 space-y-2">
          <textarea
            name="question"
            required
            rows={2}
            placeholder="Question"
            className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          />
          <textarea
            name="solution"
            required
            rows={4}
            placeholder="Worked solution"
            className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          />
          <input
            name="sortOrder"
            type="number"
            placeholder="Order"
            className="w-24 rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          />
          <button className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">
            Add exercise
          </button>
        </form>

        <details className="mt-4 rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium hover:bg-brand/5">
            Bulk add exercises
          </summary>
          <form action={bulkAddExercises.bind(null, topicId)} className="space-y-2 px-3 pb-3">
            <p className="text-xs text-foreground/60">
              One exercise per block: a line starting with <code>Q:</code>, then a line starting with{" "}
              <code>A:</code> (either may span multiple lines — worked solutions rarely fit on one).
              Separate blocks with a line of three or more dashes (<code>---</code>). Appended after
              what&apos;s already stored.
            </p>
            <textarea
              name="bulkText"
              rows={10}
              placeholder={
                "Q: Solve for x: 2x + 3 = 11\nA: Subtract 3 from both sides: 2x = 8\nDivide both sides by 2: x = 4\n---\nQ: Find the area of a rectangle with length 5 cm and breadth 3 cm.\nA: Area = length x breadth = 5 x 3 = 15 sq. cm"
              }
              className="w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-sm"
            />
            <button className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-brand/5">
              Bulk add exercises
            </button>
          </form>
        </details>
      </section>

      <section>
        <p className="text-xs font-semibold uppercase tracking-wide text-foreground/40">
          {(exercises ?? []).length} exercise{(exercises ?? []).length === 1 ? "" : "s"}
        </p>
        <div className="mt-2 space-y-4">
          {(exercises ?? []).map((ex) => (
            <div key={ex.id} className="rounded-xl border border-border bg-surface p-4">
              <form action={updateExercise.bind(null, ex.id, topicId)}>
                <div className="flex items-start justify-between gap-3">
                  <label className="flex-1 text-xs font-medium uppercase tracking-wide text-foreground/40">
                    Question
                    <textarea
                      name="question"
                      defaultValue={ex.question}
                      required
                      rows={2}
                      className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm normal-case"
                    />
                  </label>
                  <input
                    name="sortOrder"
                    type="number"
                    defaultValue={ex.sort_order}
                    className="w-20 shrink-0 rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
                  />
                </div>
                <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-foreground/40">
                  Solution
                  <textarea
                    name="solution"
                    defaultValue={ex.solution}
                    required
                    rows={4}
                    className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm normal-case"
                  />
                </label>
                <button className="mt-3 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-brand/5">
                  Save
                </button>
              </form>
              <form action={removeExercise.bind(null, ex.id, topicId)} className="mt-2">
                <button className="text-xs text-red-600 hover:underline">Remove</button>
              </form>
            </div>
          ))}
          {(exercises ?? []).length === 0 && (
            <p className="rounded-xl border border-border bg-surface p-5 text-sm text-foreground/50">
              No exercises yet for this topic.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
