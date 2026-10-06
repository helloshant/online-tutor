// Converts a call's real USD cost (already computed by calculateCostUsd in
// pricing.ts) into wallet-tokens -- the unit student_wallets.balance_tokens
// is denominated in (see supabase/migrations/0055_student_wallets.sql).
// A wallet token is money, not an LLM token: ₹500 buys a fixed 200,000-
// token top-up (see src/app/api/wallet/recharge/initiate/route.ts), so
// this rate is fixed too. Anthropic's real per-LLM-token cost is higher
// than Gemini's (see pricing.ts's own DEFAULT_ANTHROPIC_PRICING vs
// DEFAULT_GEMINI_PRICING) -- converting through real USD cost rather than
// raw token counts is what makes choosing Anthropic burn this SAME wallet
// faster, without a separate "upgrade fee."
const TOKENS_PER_RUPEE = 400; // ₹500 = 200,000 tokens

// No live FX feed -- this app has never needed one before (every other
// price in it is already quoted in INR). Override via env if this drifts
// enough to matter; same "as of" dating convention pricing.ts's own rate
// tables already use for LLM pricing, since neither is a feed that updates
// itself.
const USD_TO_INR_RATE = Number(process.env.USD_TO_INR_RATE) || 88; // as of 2026-10

export function walletTokensForCostUsd(costUsd: number): number {
  return Math.round(costUsd * USD_TO_INR_RATE * TOKENS_PER_RUPEE);
}
