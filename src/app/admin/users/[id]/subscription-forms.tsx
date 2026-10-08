"use client";

import { useActionState } from "react";
import {
  activateSubscriptionWithoutPayment,
  cancelSubscription,
  updateSubscriptionBoardGrade,
  updateSubscriptionSubjects,
  type AdminActionState,
} from "../../actions";
import { ActionMessage, SubmitButton } from "./submit-button";

const INITIAL_STATE: AdminActionState = {};

// Client wrapper around cancelSubscription -- useActionState is what
// gives SubmitButton/ActionMessage something to render (pending state,
// then the confirmation/error the action now returns), which a plain
// server-rendered <form action={...}> never had.
export function CancelSubscriptionForm({
  subscriptionId,
  userId,
}: {
  subscriptionId: string;
  userId: string;
}) {
  const [state, formAction] = useActionState(
    cancelSubscription.bind(null, subscriptionId, userId),
    INITIAL_STATE,
  );
  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <SubmitButton
        pendingLabel="Cancelling…"
        className="rounded-lg border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
      >
        Cancel subscription
      </SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}

// Same shape as CancelSubscriptionForm, for activateSubscriptionWithoutPayment.
export function ActivateSubscriptionForm({
  subscriptionId,
  userId,
}: {
  subscriptionId: string;
  userId: string;
}) {
  const [state, formAction] = useActionState(
    activateSubscriptionWithoutPayment.bind(null, subscriptionId, userId),
    INITIAL_STATE,
  );
  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <SubmitButton
        pendingLabel="Activating…"
        className="rounded-lg border border-green-200 px-3 py-1 text-xs font-medium text-green-700 hover:bg-green-50"
      >
        Activate without payment
      </SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}

// The actual <form> for BoardGradeEditor (src/app/admin/users/[id]/
// page.tsx) -- split out as its own client component (that component
// itself stays a server component, since it has no data of its own to
// fetch, but still needs to live alongside the other admin forms this
// page renders) so useActionState has somewhere to live.
export function BoardGradeEditorForm({
  subscriptionId,
  userId,
  boardId,
  gradeId,
  boards,
  grades,
}: {
  subscriptionId: string;
  userId: string;
  boardId: string;
  gradeId: string;
  boards: { id: string; name: string }[];
  grades: { id: string; name: string }[];
}) {
  const [state, formAction] = useActionState(
    updateSubscriptionBoardGrade.bind(null, subscriptionId, userId),
    INITIAL_STATE,
  );
  return (
    <form action={formAction} className="space-y-3 border-t border-border p-3">
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs text-foreground/75">
          Board
          <select
            name="boardId"
            defaultValue={boardId}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground/75">
          Grade
          <select
            name="gradeId"
            defaultValue={gradeId}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            {grades.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <SubmitButton className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-dark">
          Save board / grade
        </SubmitButton>
        <p className="text-xs text-foreground/65">
          Subjects not offered under the new board/grade are dropped automatically. If none of the
          current subjects carry over, the change is blocked -- adjust subjects for the target
          board/grade separately first.
        </p>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}

// The actual <form> for SubjectEditor (src/app/admin/users/[id]/
// page.tsx) -- same split as BoardGradeEditorForm above, for the same
// reason.
export function SubjectEditorForm({
  subscriptionId,
  userId,
  options,
  currentSubjectIds,
}: {
  subscriptionId: string;
  userId: string;
  options: { id: string; name: string }[];
  currentSubjectIds: Set<string>;
}) {
  const [state, formAction] = useActionState(
    updateSubscriptionSubjects.bind(null, subscriptionId, userId),
    INITIAL_STATE,
  );
  return (
    <form action={formAction} className="space-y-2 border-t border-border p-3">
      <div className="flex flex-wrap gap-2">
        {options.map((s) => (
          <label
            key={s.id}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs has-[:checked]:border-brand has-[:checked]:bg-brand/5"
          >
            <input type="checkbox" name="subjectIds" value={s.id} defaultChecked={currentSubjectIds.has(s.id)} />
            {s.name}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <SubmitButton className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-dark">
          Save subjects
        </SubmitButton>
        <p className="text-xs text-foreground/65">At least one subject must stay selected.</p>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}
