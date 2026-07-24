"use client";

import { useActionState, useMemo, useState } from "react";
import type { Board, BoardGradeSubject, Grade, Medium, Subject } from "@/lib/supabase/types";
import { PRICE_PER_SUBJECT_INR } from "@/lib/pricing";
import { confirmSelection, type OnboardingState } from "./actions";

const MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];
const STEPS = ["Board & Grade", "Subjects", "Medium", "Confirm"] as const;

const initialState: OnboardingState = {};

export function OnboardingWizard({
  boards,
  grades,
  subjects,
  mappings,
  initial,
}: {
  boards: Board[];
  grades: Grade[];
  subjects: Subject[];
  mappings: BoardGradeSubject[];
  initial?: { boardId: string; gradeId: string; medium: Medium; subjectIds: string[] };
}) {
  const [step, setStep] = useState(0);
  const [boardId, setBoardId] = useState(initial?.boardId ?? "");
  const [gradeId, setGradeId] = useState(initial?.gradeId ?? "");
  const [medium, setMedium] = useState<Medium | "">(initial?.medium ?? "");
  const [subjectIds, setSubjectIds] = useState<Set<string>>(new Set(initial?.subjectIds ?? []));
  const [state, formAction, pending] = useActionState(confirmSelection, initialState);

  const availableSubjects = useMemo(() => {
    if (!boardId || !gradeId) return [];
    const allowed = new Set(
      mappings
        .filter((m) => m.board_id === boardId && m.grade_id === gradeId)
        .map((m) => m.subject_id)
    );
    return subjects.filter((s) => allowed.has(s.id));
  }, [boardId, gradeId, mappings, subjects]);

  const selectedBoard = boards.find((b) => b.id === boardId);
  const selectedGrade = grades.find((g) => g.id === gradeId);
  const selectedSubjects = subjects.filter((s) => subjectIds.has(s.id));

  function toggleSubject(id: string) {
    setSubjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function onBoardOrGradeChange(nextBoardId: string, nextGradeId: string) {
    setBoardId(nextBoardId);
    setGradeId(nextGradeId);
    setSubjectIds(new Set());
  }

  const canProceedStep0 = Boolean(boardId && gradeId);
  const canProceedStep1 = subjectIds.size > 0;
  const canProceedStep2 = Boolean(medium);

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-4 py-10">
      <ol className="mb-8 flex items-center justify-between text-xs font-medium text-foreground/50">
        {STEPS.map((label, i) => (
          <li key={label} className={`flex items-center gap-2 ${i <= step ? "text-brand" : ""}`}>
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full border text-[11px] ${
                i <= step ? "border-brand bg-brand text-white" : "border-border"
              }`}
            >
              {i + 1}
            </span>
            <span className="hidden sm:inline">{label}</span>
          </li>
        ))}
      </ol>

      <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8">
        {step === 0 && (
          <section>
            <h2 className="text-lg font-semibold">Which board and grade?</h2>
            <p className="mt-1 text-sm text-foreground/60">
              Your syllabus and Q&amp;A scope will be based on this selection.
            </p>

            <div className="mt-6">
              <h3 className="text-sm font-medium text-foreground/70">Board</h3>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {boards.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => onBoardOrGradeChange(b.id, gradeId)}
                    className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                      boardId === b.id
                        ? "border-brand bg-brand/5 font-medium text-brand"
                        : "border-border hover:border-brand/50"
                    }`}
                  >
                    {b.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-6">
              <h3 className="text-sm font-medium text-foreground/70">Grade</h3>
              <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-7">
                {grades.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => onBoardOrGradeChange(boardId, g.id)}
                    className={`rounded-lg border px-2 py-2 text-sm transition ${
                      gradeId === g.id
                        ? "border-brand bg-brand/5 font-medium text-brand"
                        : "border-border hover:border-brand/50"
                    }`}
                  >
                    {g.level}
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {step === 1 && (
          <section>
            <h2 className="text-lg font-semibold">Choose your subjects</h2>
            <p className="mt-1 text-sm text-foreground/60">
              Subjects offered for {selectedBoard?.name}, {selectedGrade?.name}. Q&amp;A will be
              confined to whichever subject you select in the dashboard.
            </p>

            <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {availableSubjects.map((s) => {
                const checked = subjectIds.has(s.id);
                return (
                  <label
                    key={s.id}
                    className={`flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 text-sm transition ${
                      checked ? "border-brand bg-brand/5 font-medium text-brand" : "border-border"
                    }`}
                  >
                    {s.name}
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSubject(s.id)}
                      className="h-4 w-4 accent-[var(--brand)]"
                    />
                  </label>
                );
              })}
            </div>
          </section>
        )}

        {step === 2 && (
          <section>
            <h2 className="text-lg font-semibold">Medium of instruction</h2>
            <p className="mt-1 text-sm text-foreground/60">
              The tutor will always answer in this language.
            </p>

            <div className="mt-6 grid grid-cols-3 gap-2">
              {MEDIUMS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMedium(m)}
                  className={`rounded-lg border px-3 py-3 text-sm transition ${
                    medium === m
                      ? "border-brand bg-brand/5 font-medium text-brand"
                      : "border-border hover:border-brand/50"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </section>
        )}

        {step === 3 && (
          <section>
            <h2 className="text-lg font-semibold">Confirm your subscription</h2>
            <dl className="mt-6 space-y-3 text-sm">
              <div className="flex justify-between border-b border-border pb-2">
                <dt className="text-foreground/60">Board</dt>
                <dd className="font-medium">{selectedBoard?.name}</dd>
              </div>
              <div className="flex justify-between border-b border-border pb-2">
                <dt className="text-foreground/60">Grade</dt>
                <dd className="font-medium">{selectedGrade?.name}</dd>
              </div>
              <div className="flex justify-between border-b border-border pb-2">
                <dt className="text-foreground/60">Medium</dt>
                <dd className="font-medium">{medium}</dd>
              </div>
              <div className="flex justify-between border-b border-border pb-2">
                <dt className="text-foreground/60">Subjects</dt>
                <dd className="text-right font-medium">
                  {selectedSubjects.map((s) => s.name).join(", ")}
                </dd>
              </div>
              <div className="flex justify-between pt-1 text-base">
                <dt className="font-semibold">Total</dt>
                <dd className="font-semibold">
                  ₹{selectedSubjects.length * PRICE_PER_SUBJECT_INR}/month
                </dd>
              </div>
            </dl>

            <form action={formAction} className="mt-6">
              <input type="hidden" name="boardId" value={boardId} />
              <input type="hidden" name="gradeId" value={gradeId} />
              <input type="hidden" name="medium" value={medium} />
              {[...subjectIds].map((id) => (
                <input key={id} type="hidden" name="subjectIds" value={id} />
              ))}

              {state?.error && <p className="mb-3 text-sm text-red-600">{state.error}</p>}

              <button
                type="submit"
                disabled={pending}
                className="w-full rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
              >
                {pending ? "Saving…" : "Continue to payment"}
              </button>
            </form>
          </section>
        )}

        <div className="mt-8 flex justify-between">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
            className="rounded-lg px-4 py-2 text-sm font-medium text-foreground/60 disabled:opacity-0"
          >
            Back
          </button>
          {step < 3 && (
            <button
              type="button"
              onClick={() => setStep((s) => Math.min(3, s + 1))}
              disabled={
                (step === 0 && !canProceedStep0) ||
                (step === 1 && !canProceedStep1) ||
                (step === 2 && !canProceedStep2)
              }
              className="rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
