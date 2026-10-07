import Link from "next/link";
import { isStaff, requireFreshPassword } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWalletBalance } from "@/lib/walletBalance";
import { NewPasswordForm } from "@/components/new-password-form";
import { changePassword } from "./actions";
import { AiModelSwitcher } from "./ai-model-switcher";
import { RechargeCheckout } from "./recharge-checkout";
import { CouponForm } from "./coupon-form";
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
  // subscription row directly (0002_rls_policies.sql). Not scoped to
  // status in ("pending_payment", "active") the way dashboard/page.tsx's
  // own lookup is -- this is a read-only info page, not a feature gate, so a
  // cancelled/expired subscription should still show here rather than the
  // page pretending the student never subscribed at all.
  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("id, status, medium, board_id, grade_id, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Service-role: student_wallets has no client-facing read beyond the
  // student's own row (which this already is, via RLS), but using the
  // same admin client every other wallet read in this app uses keeps this
  // consistent -- and avoids a second round trip, since getWalletBalance
  // already handles the "no row" default cleanly.
  const admin = createAdminClient();
  const wallet = staff ? null : await getWalletBalance(admin, user.id);

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

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex items-center justify-between">
        <Link
          href="/dashboard"
          className="text-sm text-foreground/68 hover:text-foreground"
        >
          ← Back to dashboard
        </Link>
        <Link
          href="/pricing"
          className="text-sm text-foreground/68 hover:text-foreground"
        >
          Pricing
        </Link>
      </div>

      <h1 className="mt-3 text-lg font-semibold">Account</h1>

      <div className="mt-4 rounded-xl border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-sm font-semibold">Account information</h2>
        <dl className="mt-2.5 space-y-1.5 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-foreground/68">Name</dt>
            <dd className="text-right">{profile?.full_name ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-foreground/68">Email</dt>
            <dd className="text-right">{user.email}</dd>
          </div>
          {staff && (
            <div className="flex justify-between gap-4">
              <dt className="text-foreground/68">Role</dt>
              <dd className="text-right">
                {ROLE_LABEL[profile?.role ?? "user"]}
              </dd>
            </div>
          )}
          {subscription && board && grade ? (
            <>
              <div className="flex justify-between gap-4">
                <dt className="text-foreground/68">Board · Grade</dt>
                <dd className="text-right">
                  {board.name} · {grade.name}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-foreground/68">Medium</dt>
                <dd className="text-right">{subscription.medium}</dd>
              </div>
              {subjectNames.length > 0 && (
                <div className="flex justify-between gap-4">
                  <dt className="text-foreground/68">Subjects</dt>
                  <dd className="text-right">{subjectNames.join(", ")}</dd>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <dt className="text-foreground/68">Subscription status</dt>
                <dd className="text-right capitalize">
                  {subscription.status.replace("_", " ")}
                </dd>
              </div>
            </>
          ) : (
            !staff && (
              <div className="flex justify-between gap-4">
                <dt className="text-foreground/68">Subscription</dt>
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

      {!staff && wallet && (
        <>
          <WalletCard balance={wallet.balance} />

          <div className="mt-5 rounded-xl border border-border bg-surface p-4 sm:p-5">
            <h2 className="text-sm font-semibold">AI model</h2>
            <p className="mt-1 text-xs text-foreground/68">
              Gemini is the default, included in your wallet balance at the
              standard rate. Anthropic (Claude) is a premium model -- no
              separate charge to switch, it just burns your wallet balance
              faster.
            </p>
            <div className="mt-3">
              <AiModelSwitcher currentProvider={wallet.provider} />
            </div>
          </div>
        </>
      )}

      <div className="mt-5 rounded-xl border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-sm font-semibold">Change password</h2>
        <NewPasswordForm
          action={changePassword}
          submitLabel="Update password"
        />
      </div>
    </div>
  );
}

// Student-facing wallet balance + recharge -- replaces the old monthly/
// trial usage meter now that the wallet balance is the one thing that
// decides whether the tutor will answer (see src/lib/walletBalance.ts).
function WalletCard({ balance }: { balance: number }) {
  const exhausted = balance <= 0;

  return (
    <div className="mt-5 rounded-xl border border-border bg-surface p-4 sm:p-5">
      <h2 className="text-sm font-semibold">Token wallet</h2>
      <p className="mt-1 text-sm text-foreground/75">
        {exhausted ? (
          <span className="font-medium text-red-600">
            Out of tokens -- recharge to keep using the tutor.
          </span>
        ) : (
          <>
            <span className="font-medium">{balance.toLocaleString()} tokens</span>{" "}
            remaining.
          </>
        )}
      </p>
      <div className="mt-3">
        <RechargeCheckout />
      </div>
      <CouponForm />
    </div>
  );
}
