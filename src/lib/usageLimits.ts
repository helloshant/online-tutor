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
