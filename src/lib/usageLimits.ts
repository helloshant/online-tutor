import "server-only";

// Shared between /api/chat/route.ts (which enforces this) and
// /admin/users/[id]/page.tsx (which displays/lets an admin override it) --
// kept in one place so the two can never quietly disagree on what the
// platform default actually is, or on what a missing/zero override row
// means. See supabase/migrations/0037_student_token_usage_limits.sql for
// the table and RPC this is built around.

// Platform-wide monthly LLM token allowance for a student with no
// individual override row in student_usage_limits. Never itself 0 -- an
// unset/invalid env var falling back silently to "unlimited" would defeat
// the whole point of having a cap at all.
export const DEFAULT_MONTHLY_TOKEN_LIMIT = Number(process.env.DEFAULT_MONTHLY_TOKEN_LIMIT) || 200_000;

// UTC calendar month boundary -- simple and unambiguous across a student
// base that isn't all in one timezone; the cost/observability side
// (chat_events, cost_usd) already has no notion of "local month" either,
// so this doesn't introduce a new timezone concept the rest of the app
// doesn't share.
export function startOfCurrentMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// Resolves what a student's monthly_token_limit override row (or the
// absence of one) actually means: no row -> the platform default applies;
// a row with 0 -> the admin's explicit "no limit" override (see the
// migration's own comment on why 0 is reused as that sentinel rather than
// a second boolean column); a row with N>0 -> that student's own cap in
// place of the default.
export function resolveMonthlyTokenLimit(overrideRow: { monthly_token_limit: number } | null): {
  unlimited: boolean;
  limit: number;
} {
  if (!overrideRow) return { unlimited: false, limit: DEFAULT_MONTHLY_TOKEN_LIMIT };
  if (overrideRow.monthly_token_limit === 0) return { unlimited: true, limit: Infinity };
  return { unlimited: false, limit: overrideRow.monthly_token_limit };
}

// A brand-new signup's free-trial allowance -- deliberately small, and (see
// resolveUsageLimit below) a ONE-TIME lifetime cap, never a resetting one:
// the whole point is limited testing ahead of a real subscription, not a
// permanent free tier. Never itself 0, same reasoning as
// DEFAULT_MONTHLY_TOKEN_LIMIT above.
export const DEFAULT_TRIAL_TOKEN_LIMIT = Number(process.env.DEFAULT_TRIAL_TOKEN_LIMIT) || 5_000;

// Passed as monthly_llm_tokens_for_user's own p_since when a lifetime total
// is wanted instead of a since-this-month one -- that RPC just sums a
// student's LLM tokens at or after a given timestamp (see
// 0037_student_token_usage_limits.sql), so "since the beginning of time"
// gives a lifetime total for free, no separate RPC needed.
export const EPOCH_ISO = new Date(0).toISOString();

// A student's own `subscriptions.status`, as far as usage-capping cares --
// "cancelled"/other statuses never reach here (every enforcement call site
// only looks up rows with status in ("active", "pending_payment") to begin
// with) and are treated as no-subscription-at-all by their own callers.
export type SubscriptionStatusForUsage = "active" | "pending_payment";

// Which usage cap actually applies to a request, and what to tell the
// student when they're over it -- the one thing every enforcement call site
// (`/api/chat`, `/api/topics/[id]/exercises/generate`,
// `/api/practice-papers`) needs, now resolved in one place instead of each
// re-deriving its own "since" timestamp and message text. `pending_payment`
// (a trial student who hasn't paid yet) gets the small lifetime cap above;
// `active` (a paying student) keeps the existing resetting monthly cap. An
// admin's explicit "unlimited" override (monthly_token_limit === 0, see
// resolveMonthlyTokenLimit's own comment on the sentinel) wins regardless
// of subscription status -- a comped student should never be trial-capped
// just because they haven't paid yet.
export function resolveUsageLimit(
  status: SubscriptionStatusForUsage,
  overrideRow: { monthly_token_limit: number } | null,
): { unlimited: boolean; limit: number; sinceIso: string; exceededMessage: string } {
  if (overrideRow?.monthly_token_limit === 0) {
    return { unlimited: true, limit: Infinity, sinceIso: EPOCH_ISO, exceededMessage: "" };
  }
  if (status === "pending_payment") {
    return {
      unlimited: false,
      limit: DEFAULT_TRIAL_TOKEN_LIMIT,
      sinceIso: EPOCH_ISO,
      exceededMessage: "You've used up your free trial's AI tutoring tokens. Subscribe to keep going.",
    };
  }
  const { unlimited, limit } = resolveMonthlyTokenLimit(overrideRow);
  return {
    unlimited,
    limit,
    sinceIso: startOfCurrentMonthIso(),
    exceededMessage: "You've reached this month's AI tutoring usage limit. It resets at the start of next month.",
  };
}
