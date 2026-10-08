// Converts a call's real USD cost (already computed by calculateCostUsd in
// pricing.ts) into wallet-tokens -- the unit student_wallets.balance_tokens
// is denominated in (see supabase/migrations/0055_student_wallets.sql).
// Anthropic's real per-LLM-token cost is higher than Gemini's (see
// pricing.ts's own DEFAULT_ANTHROPIC_PRICING vs DEFAULT_GEMINI_PRICING) --
// converting through real USD cost rather than raw token counts is what
// makes choosing Anthropic burn this SAME wallet faster, without a
// separate "upgrade fee."
//
// This is pinned to the real COST BASIS of a 200,000-token top-up (₹500
// -- see WALLET_TOPUP_AMOUNT_PAISE's own comment for why that no longer
// equals the price a student actually pays), NOT the current recharge
// price -- the whole point of margin is that what's charged (₹1,099, see
// src/lib/walletTopup.ts) exceeds what 200,000 tokens' worth of real
// usage actually costs to deliver (₹500 worth, at an accurate FX rate).
// Changing this to track the sale price instead would silently hand
// every student MORE real AI usage per wallet-token than intended,
// erasing the margin entirely.
const TOKENS_PER_RUPEE = 400; // 200,000 tokens costs ₹500 in real LLM spend

// No live FX feed -- this app has never needed one before (every other
// price in it is already quoted in INR). Override via env if this drifts
// enough to matter; same "as of" dating convention pricing.ts's own rate
// tables already use for LLM pricing, since neither is a feed that updates
// itself. Confirmed against the real market rate directly (not a third-
// party aggregator) -- the previous default of 88 had drifted roughly 8-9%
// below the real ~96, which was silently eating the ENTIRE margin on top
// of the real LLM cost (confirmed live: a recharge's real cost worked out
// to more than its price). Keep this in sync with reality, not just set
// once.
const USD_TO_INR_RATE = Number(process.env.USD_TO_INR_RATE) || 96; // as of 2026-10

export function walletTokensForCostUsd(costUsd: number): number {
  return Math.round(costUsd * USD_TO_INR_RATE * TOKENS_PER_RUPEE);
}
