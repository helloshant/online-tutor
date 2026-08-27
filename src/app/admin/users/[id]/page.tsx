import Link from "next/link";
import { notFound } from "next/navigation";
import { isPasswordExpired, PASSWORD_EXPIRY_DAYS, requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveMonthlyTokenLimit, startOfCurrentMonthIso } from "@/lib/usageLimits";
import {
  activateSubscriptionWithoutPayment,
  cancelSubscription,
  deleteUser,
  sendPasswordResetEmail,
  setAccountExpired,
  setUserRole,
  updateSubscriptionBoardGrade,
  updateSubscriptionSubjects,
  updateUserProfile,
  updateUserUsageLimit,
} from "../../actions";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { SetPasswordForm } from "./set-password-form";
import type { ProfileRole } from "@/lib/supabase/types";

const ROLE_LABEL: Record<ProfileRole, string> = {
  user: "User",
  admin: "Admin",
  superadmin: "Superadmin",
};

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user: actingUser, profile: actingProfile } = await requireAdminPage("users");
  const { id } = await params;
  const admin = createAdminClient();

  const [
    { data: authUser },
    { data: profile },
    { data: subscriptions },
    { data: identityRows },
    { data: boards },
    { data: grades },
    { data: usageLimitOverride },
    { data: monthlyTokensUsed },
  ] = await Promise.all([
    admin.auth.admin.getUserById(id),
    admin.from("profiles").select("*").eq("id", id).single(),
    admin
      .from("subscriptions")
      .select("*, boards(name), grades(name), subscription_subjects(subjects(id, name))")
      .eq("user_id", id)
      .order("created_at", { ascending: false }),
    // admin.auth.admin.getUserById() doesn't reliably populate the
    // returned user's `identities` array -- query the real table via RPC
    // instead (see 0014_email_identity_check.sql).
    admin.rpc("get_users_with_email_identity", { p_user_ids: [id] }),
    // Flat, board-agnostic lists (same ones onboarding itself offers) --
    // fed to BoardGradeEditor below so it can offer every board/grade,
    // not just the subscription's current one.
    admin.from("boards").select("id, name").order("name"),
    admin.from("grades").select("id, name").order("level"),
    // Usage-based pricing (see supabase/migrations/0037_student_token_usage_limits.sql)
    // -- fetched unconditionally alongside everything else above (cheap,
    // one extra indexed query each) even though the section below only
    // renders it for a plain 'user' role; staff is unmetered so there's
    // nothing student-specific to branch the fetch itself on beforehand.
    admin.from("student_usage_limits").select("monthly_token_limit").eq("user_id", id).maybeSingle(),
    admin.rpc("monthly_llm_tokens_for_user", { p_user_id: id, p_since: startOfCurrentMonthIso() }),
  ]);

  if (!authUser?.user) notFound();

  const isSuperAdminViewer = actingProfile?.role === "superadmin";
  const targetRole: ProfileRole = profile?.role ?? "user";
  // Mirrors deleteUser's own guards (no self-delete; staff accounts need a
  // superadmin) so the button doesn't invite an action that's a no-op.
  const canDeleteTarget = id !== actingUser.id && (targetRole === "user" || isSuperAdminViewer);
  const passwordExpired = isPasswordExpired(profile);
  const hasPasswordIdentity = identityRows?.[0]?.has_email_identity ?? false;

  return (
    <div>
      <Link href="/admin" className="text-sm text-brand hover:underline">
        ← All users
      </Link>

      <div className="mt-4 flex items-start justify-between rounded-xl border border-border bg-surface p-6">
        <div>
          <h1 className="text-xl font-semibold">{profile?.full_name ?? "Unnamed user"}</h1>
          <p className="mt-1 text-sm text-foreground/60">{authUser.user.email}</p>
          <p className="mt-1 text-xs text-foreground/40">
            Joined {new Date(authUser.user.created_at).toLocaleDateString()}
          </p>
        </div>

        {isSuperAdminViewer ? (
          <div className="flex items-center gap-2">
            {(["user", "admin", "superadmin"] as ProfileRole[]).map((role) => (
              <form
                key={role}
                action={async () => {
                  "use server";
                  await setUserRole(id, role);
                }}
              >
                <button
                  type="submit"
                  disabled={role === targetRole}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                    role === targetRole
                      ? "border-brand bg-brand/10 text-brand"
                      : "border-border hover:bg-brand/5"
                  }`}
                >
                  {ROLE_LABEL[role]}
                </button>
              </form>
            ))}
          </div>
        ) : (
          <span className="rounded-full bg-foreground/10 px-3 py-1 text-sm font-medium text-foreground/70">
            {ROLE_LABEL[targetRole]}
            <span className="ml-2 text-xs text-foreground/40">(only a superadmin can change this)</span>
          </span>
        )}
      </div>

      <details className="mt-4 rounded-xl border border-border bg-surface">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:bg-brand/5">
          Edit profile
        </summary>
        <form
          action={updateUserProfile.bind(null, id)}
          className="grid gap-3 border-t border-border p-4 sm:grid-cols-2"
        >
          <input
            name="fullName"
            defaultValue={profile?.full_name ?? ""}
            placeholder="Full name"
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          />
          <input
            name="email"
            type="email"
            required
            defaultValue={authUser.user.email ?? ""}
            placeholder="Email"
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          />
          <button className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand/90 sm:col-span-2 sm:w-fit">
            Save changes
          </button>
        </form>
      </details>

      <div className="mt-4 rounded-xl border border-border bg-surface p-6">
        <h2 className="text-sm font-semibold">Password</h2>

        {hasPasswordIdentity ? (
          <p className="mt-1 text-sm text-foreground/60">
            {profile?.password_changed_at ? (
              <>Last changed {new Date(profile.password_changed_at).toLocaleDateString()} — </>
            ) : (
              "Last changed: unknown (predates tracking) — "
            )}
            <span className={passwordExpired ? "font-medium text-red-600" : "font-medium text-green-700"}>
              {passwordExpired ? "expired" : "active"}
            </span>
            , same as any native account after {PASSWORD_EXPIRY_DAYS} days.
          </p>
        ) : (
          <p className="mt-1 text-sm text-foreground/60">
            Signed in with Google only — no password with this app yet. Setting one below also
            lets this account sign in with email/password from then on.
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <form action={sendPasswordResetEmail.bind(null, id)}>
            <button className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-brand/5">
              Send password reset email
            </button>
          </form>

          {hasPasswordIdentity && (
            <form action={setAccountExpired.bind(null, id)} className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-sm text-foreground/70">
                <input type="checkbox" name="expired" defaultChecked={passwordExpired} className="h-4 w-4" />
                Account expired
              </label>
              <button className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-brand/5">
                Save
              </button>
            </form>
          )}
        </div>

        <div className="mt-3">
          <SetPasswordForm
            userId={id}
            placeholder={
              hasPasswordIdentity ? "New password (min. 8 characters)" : "Set a password (min. 8 characters)"
            }
            submitLabel={hasPasswordIdentity ? "Set new password" : "Set password"}
          />
        </div>
      </div>

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-foreground/50">
        Subscriptions
      </h2>

      <div className="mt-3 space-y-3">
        {(subscriptions ?? []).map((sub) => (
          <SubscriptionCard key={sub.id} sub={sub} userId={id} boards={boards ?? []} grades={grades ?? []} />
        ))}

        {(subscriptions ?? []).length === 0 && (
          <p className="rounded-xl border border-border bg-surface p-5 text-sm text-foreground/50">
            {targetRole === "admin" || targetRole === "superadmin"
              ? "Staff accounts get full subject access without a subscription."
              : "This user hasn't started onboarding yet."}
          </p>
        )}
      </div>

      {targetRole === "user" && (
        <UsageLimitCard
          userId={id}
          override={usageLimitOverride ?? null}
          usedThisMonth={monthlyTokensUsed ?? 0}
        />
      )}

      {canDeleteTarget && (
        <div className="mt-8 rounded-xl border border-red-200 bg-red-50 p-5">
          <h2 className="text-sm font-semibold text-red-700">Danger zone</h2>
          <p className="mt-1 text-sm text-red-700/80">
            Permanently deletes this account: profile, subscriptions, and chat history. This cannot be
            undone.
          </p>
          <form action={deleteUser.bind(null, id)} className="mt-3">
            <ConfirmSubmitButton
              confirmMessage={`Delete ${authUser.user.email}? This permanently removes their account, subscriptions, and chat history.`}
              className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-100"
            >
              Delete user
            </ConfirmSubmitButton>
          </form>
        </div>
      )}
    </div>
  );
}

// Usage-based pricing enforcement: displays this student's current-
// calendar-month LLM token usage (see monthly_llm_tokens_for_user) against
// their effective monthly cap -- the platform default, or their own
// override row if one exists -- and lets an admin set/clear that override.
// Only ever rendered for a plain 'user' role (see the call site) -- staff
// is unmetered, so there's no limit here to show or edit for them.
function UsageLimitCard({
  userId,
  override,
  usedThisMonth,
}: {
  userId: string;
  override: { monthly_token_limit: number } | null;
  usedThisMonth: number;
}) {
  const { unlimited, limit } = resolveMonthlyTokenLimit(override);
  const pctUsed = unlimited || limit === 0 ? 0 : Math.min(100, Math.round((usedThisMonth / limit) * 100));
  const overLimit = !unlimited && usedThisMonth >= limit;

  return (
    <div className="mt-8 rounded-xl border border-border bg-surface p-6">
      <h2 className="text-sm font-semibold">Usage-based pricing</h2>
      <p className="mt-1 text-sm text-foreground/60">
        This month:{" "}
        <span className={overLimit ? "font-medium text-red-600" : "font-medium"}>
          {usedThisMonth.toLocaleString()} tokens
        </span>{" "}
        {unlimited ? (
          "used, no limit set for this student."
        ) : (
          <>
            of {limit.toLocaleString()} allowed
            {override ? "" : " (platform default)"}
            {overLimit && " — further questions are blocked until next calendar month, or until this is raised."}
          </>
        )}
      </p>

      {!unlimited && (
        <div className="mt-2 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-foreground/10">
          <div
            className={`h-full rounded-full ${overLimit ? "bg-red-500" : "bg-brand"}`}
            style={{ width: `${pctUsed}%` }}
          />
        </div>
      )}

      <form action={updateUserUsageLimit.bind(null, userId)} className="mt-4 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Monthly token limit override
          <input
            name="monthlyTokenLimit"
            type="number"
            min={0}
            step={1}
            defaultValue={override?.monthly_token_limit ?? ""}
            placeholder="Platform default"
            className="w-44 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          />
        </label>
        <button className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">
          Save
        </button>
        <p className="w-full text-xs text-foreground/40">
          Leave blank to use the platform default. Enter 0 for unlimited. Any other number replaces the
          default with this student&apos;s own monthly cap.
        </p>
      </form>
    </div>
  );
}

// Shaped loosely rather than threading a full embedded-query type through
// -- same pragmatic choice the dashboard's own subject joins and this
// app's other admin pages make for their own boards(name)/grades(name)
// embeds.
type SubscriptionRow = {
  id: string;
  status: string;
  created_at: string;
  board_id: string;
  grade_id: string;
  medium: string;
  amount_paise: number | null;
  boards: { name: string } | null;
  grades: { name: string } | null;
  subscription_subjects: { subjects: { id: string; name: string } | null }[];
};

async function SubscriptionCard({
  sub,
  userId,
  boards,
  grades,
}: {
  sub: unknown;
  userId: string;
  boards: { id: string; name: string }[];
  grades: { id: string; name: string }[];
}) {
  const row = sub as SubscriptionRow;
  const currentSubjectIds = new Set(
    row.subscription_subjects.map((s) => s.subjects?.id).filter((v): v is string => Boolean(v))
  );
  const subjectNames = row.subscription_subjects.map((s) => s.subjects?.name).filter(Boolean);
  // Editing a cancelled/expired subscription's subjects has no effect on
  // anything the student can actually reach, so the form is hidden rather
  // than just left enabled-but-pointless -- mirrors why Cancel/Activate
  // above are each only shown for their one relevant status.
  const isEditable = row.status === "active" || row.status === "pending_payment";

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              row.status === "active"
                ? "bg-green-100 text-green-700"
                : row.status === "pending_payment"
                  ? "bg-yellow-100 text-yellow-700"
                  : "bg-foreground/10 text-foreground/60"
            }`}
          >
            {row.status}
          </span>
          <span className="text-sm text-foreground/60">{new Date(row.created_at).toLocaleDateString()}</span>
        </div>
        {row.status === "active" && (
          <form
            action={async () => {
              "use server";
              await cancelSubscription(row.id, userId);
            }}
          >
            <button
              type="submit"
              className="rounded-lg border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
            >
              Cancel subscription
            </button>
          </form>
        )}
        {row.status === "pending_payment" && (
          <form
            action={async () => {
              "use server";
              await activateSubscriptionWithoutPayment(row.id, userId);
            }}
          >
            <button
              type="submit"
              className="rounded-lg border border-green-200 px-3 py-1 text-xs font-medium text-green-700 hover:bg-green-50"
            >
              Activate without payment
            </button>
          </form>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-foreground/50">Board</dt>
          <dd className="font-medium">{row.boards?.name ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-foreground/50">Grade</dt>
          <dd className="font-medium">{row.grades?.name ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-foreground/50">Medium</dt>
          <dd className="font-medium">{row.medium}</dd>
        </div>
        <div>
          <dt className="text-foreground/50">Amount</dt>
          <dd className="font-medium">{row.amount_paise ? `₹${(row.amount_paise / 100).toFixed(0)}/mo` : "—"}</dd>
        </div>
        <div className="col-span-2 sm:col-span-4">
          <dt className="text-foreground/50">Subjects</dt>
          <dd className="font-medium">{subjectNames.length ? subjectNames.join(", ") : "—"}</dd>
        </div>
      </dl>

      {isEditable && (
        <>
          <BoardGradeEditor
            subscriptionId={row.id}
            userId={userId}
            boardId={row.board_id}
            gradeId={row.grade_id}
            boards={boards}
            grades={grades}
          />
          <SubjectEditor
            subscriptionId={row.id}
            userId={userId}
            boardId={row.board_id}
            gradeId={row.grade_id}
            currentSubjectIds={currentSubjectIds}
          />
        </>
      )}
    </div>
  );
}

// Lets an admin/superadmin correct a student's board and grade after the
// fact (wrong selection at onboarding, or a genuine grade change mid-year)
// -- same collapsed-<details> pattern as SubjectEditor below. Offers every
// board/grade (boards and grades are flat, board-agnostic lists -- see
// onboarding's own wizard), not just ones already in use for this
// student. Subjects that no longer validate for the newly-picked
// board/grade are re-checked and dropped server-side in
// updateSubscriptionBoardGrade, same as SubjectEditor's own submission
// re-validates against board_grade_subjects.
function BoardGradeEditor({
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
  return (
    <details className="mt-4 rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-foreground/60 hover:bg-brand/5">
        Edit board / grade
      </summary>
      <form
        action={updateSubscriptionBoardGrade.bind(null, subscriptionId, userId)}
        className="space-y-3 border-t border-border p-3"
      >
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-xs text-foreground/60">
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
          <label className="flex flex-col gap-1 text-xs text-foreground/60">
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
          <button className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-dark">
            Save board / grade
          </button>
          <p className="text-xs text-foreground/40">
            Subjects not offered under the new board/grade are dropped automatically. If none of the
            current subjects carry over, the change is blocked -- adjust subjects for the target
            board/grade separately first.
          </p>
        </div>
      </form>
    </details>
  );
}

// Lets an admin/superadmin add or remove subjects on a subscription after
// the fact (e.g. a student wants to drop or pick up a subject mid-term),
// not just once at onboarding. Offered subjects are scoped to this
// subscription's own board+grade (board_grade_subjects), same "only what's
// actually offered" constraint onboarding's own subject picker enforces --
// re-checked server-side in updateSubscriptionSubjects regardless, this
// just keeps the checkbox list from ever offering something invalid in
// the first place.
async function SubjectEditor({
  subscriptionId,
  userId,
  boardId,
  gradeId,
  currentSubjectIds,
}: {
  subscriptionId: string;
  userId: string;
  boardId: string;
  gradeId: string;
  currentSubjectIds: Set<string>;
}) {
  const supabase = createAdminClient();
  const { data: offerings } = await supabase
    .from("board_grade_subjects")
    .select("subjects(id, name)")
    .eq("board_id", boardId)
    .eq("grade_id", gradeId);

  const options = ((offerings ?? []) as unknown as { subjects: { id: string; name: string } | null }[])
    .map((o) => o.subjects)
    .filter((s): s is { id: string; name: string } => Boolean(s))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (options.length === 0) return null;

  return (
    <details className="mt-4 rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-foreground/60 hover:bg-brand/5">
        Edit subjects
      </summary>
      <form
        action={updateSubscriptionSubjects.bind(null, subscriptionId, userId)}
        className="space-y-2 border-t border-border p-3"
      >
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
          <button className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-dark">
            Save subjects
          </button>
          <p className="text-xs text-foreground/40">At least one subject must stay selected.</p>
        </div>
      </form>
    </details>
  );
}
