import Link from "next/link";
import { isStaff, requireFreshPassword } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveMonthlyTokenLimit,
  startOfCurrentMonthIso,
} from "@/lib/usageLimits";
import { NewPasswordForm } from "@/components/new-password-form";
import { changePassword } from "./actions";
import type { ProfileRole } from "@/lib/supabase/types";

const ROLE_LABEL: Record<ProfileRole, string> = {
  user: "User",
  admin: "Admin",
  superadmin: "Superadmin",
};

export default async function AccountPage() {
  const { user, profile } = await requireFreshPassword();
  const supabase = await createClient();
  const staff = isStaff(profile?.role);

  // Ordinary session client -- RLS already lets a student read their own
  // subscription/student_usage_limits rows directly (0002_rls_policies.sql,
  // 0037_student_token_usage_limits.sql), so this doesn't need the
  // service-role client the way the admin equivalent page does. Not scoped
  // to status in ("pending_payment", "active") the way dashboard/page.tsx's
  // own lookup is -- this is a read-only info page, not a feature gate, so a
  // cancelled/expired subscription should still show here rather than the
  // page pretending the student never subscribed at all.
  const [{ data: subscription }, { data: usageLimitOverride }] =
    await Promise.all([
      supabase
        .from("subscriptions")
        .select("id, status, medium, board_id, grade_id, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      staff
        ? Promise.resolve({ data: null })
        : supabase
            .from("student_usage_limits")
            .select("monthly_token_limit")
            .eq("user_id", user.id)
            .maybeSingle(),
    ]);

  const [{ data: board }, { data: grade }, { data: subjectRows }] = subscription
    ? await Promise.all([
        supabase
          .from("boards")
          .select("name")
          .eq("id", subscription.board_id)
          .single(),
        supabase
          .from("grades")
          .select("name")
          .eq("id", subscription.grade_id)
          .single(),
        supabase
          .from("subscription_subjects")
          .select("subjects(name)")
          .eq("subscription_id", subscription.id),
      ])
    : [{ data: null }, { data: null }, { data: null }];

  const subjectNames = (subjectRows ?? [])
    .map(
      (row) =>
        (row as unknown as { subjects: { name: string } | null }).subjects
          ?.name,
    )
    .filter((name): name is string => Boolean(name))
    .sort();

  // monthly_llm_tokens_for_user is service-role-only by design (see
  // 0037_student_token_usage_limits.sql's own revoke/grant comment) -- an
  // ordinary session, even the student's own, can't call it directly.
  // Skipped entirely for staff, who are unmetered (same gate the admin
  // equivalent page uses).
  const monthlyTokensUsed = staff
    ? null
    : await createAdminClient()
        .rpc("monthly_llm_tokens_for_user", {
          p_user_id: user.id,
          p_since: startOfCurrentMonthIso(),
        })
        .then((r) => r.data ?? 0);

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <Link
        href="/dashboard"
        className="text-sm text-foreground/50 hover:text-foreground"
      >
        ← Back to dashboard
      </Link>

      <h1 className="mt-4 text-lg font-semibold">Account</h1>

      <div className="mt-6 rounded-xl border border-border bg-surface p-6">
        <h2 className="text-sm font-semibold">Account information</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-foreground/50">Name</dt>
            <dd className="text-right">{profile?.full_name ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-foreground/50">Email</dt>
            <dd className="text-right">{user.email}</dd>
          </div>
          {staff && (
            <div className="flex justify-between gap-4">
              <dt className="text-foreground/50">Role</dt>
              <dd className="text-right">
                {ROLE_LABEL[profile?.role ?? "user"]}
              </dd>
            </div>
          )}
          {subscription && board && grade ? (
            <>
              <div className="flex justify-between gap-4">
                <dt className="text-foreground/50">Board · Grade</dt>
                <dd className="text-right">
                  {board.name} · {grade.name}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-foreground/50">Medium</dt>
                <dd className="text-right">{subscription.medium}</dd>
              </div>
              {subjectNames.length > 0 && (
                <div className="flex justify-between gap-4">
                  <dt className="text-foreground/50">Subjects</dt>
                  <dd className="text-right">{subjectNames.join(", ")}</dd>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <dt className="text-foreground/50">Subscription status</dt>
                <dd className="text-right capitalize">
                  {subscription.status.replace("_", " ")}
                </dd>
              </div>
            </>
          ) : (
            !staff && (
              <div className="flex justify-between gap-4">
                <dt className="text-foreground/50">Subscription</dt>
                <dd className="text-right">
                  <Link
                    href="/onboarding"
                    className="text-brand hover:underline"
                  >
                    Not subscribed yet
                  </Link>
                </dd>
              </div>
            )
          )}
        </dl>
      </div>

      {!staff && (
        <UsageCard
          override={usageLimitOverride ?? null}
          usedThisMonth={monthlyTokensUsed ?? 0}
        />
      )}

      <div className="mt-8 rounded-xl border border-border bg-surface p-6">
        <h2 className="text-sm font-semibold">Change password</h2>
        <NewPasswordForm
          action={changePassword}
          submitLabel="Update password"
        />
      </div>
    </div>
  );
}

// Read-only student-facing sibling of admin/users/[id]/page.tsx's own
// UsageLimitCard -- same numbers, same meter, but no override form (a
// student can see their own cap, not change it).
function UsageCard({
  override,
  usedThisMonth,
}: {
  override: { monthly_token_limit: number } | null;
  usedThisMonth: number;
}) {
  const { unlimited, limit } = resolveMonthlyTokenLimit(override);
  const remaining = unlimited ? null : Math.max(0, limit - usedThisMonth);
  const pctUsed =
    unlimited || limit === 0
      ? 0
      : Math.min(100, Math.round((usedThisMonth / limit) * 100));
  const overLimit = !unlimited && usedThisMonth >= limit;

  return (
    <div className="mt-8 rounded-xl border border-border bg-surface p-6">
      <h2 className="text-sm font-semibold">AI tutoring usage this month</h2>
      <p className="mt-1 text-sm text-foreground/60">
        {unlimited ? (
          <>
            <span className="font-medium">
              {usedThisMonth.toLocaleString()} tokens
            </span>{" "}
            used, no monthly limit on your account.
          </>
        ) : (
          <>
            <span
              className={overLimit ? "font-medium text-red-600" : "font-medium"}
            >
              {remaining?.toLocaleString()} tokens
            </span>{" "}
            remaining of {limit.toLocaleString()} this month
            {overLimit &&
              " — you've reached this month's limit; it resets at the start of next month."}
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
    </div>
  );
}
