-- Corrects the live table comment 0055_student_wallets.sql set -- not
-- just a file-level comment, this is real schema metadata anyone
-- inspecting the database directly would see. It stated "₹500 = 200,000
-- tokens" as a single fact; that's no longer true now that the recharge
-- PRICE (₹1,099, see src/lib/walletTopup.ts) was raised above the real
-- COST of delivering 200,000 tokens' worth of usage (still ₹500, see
-- services/observability/src/walletPricing.ts's own comment on why that
-- stays fixed) to build in a profit margin.
comment on table public.student_wallets is
  'Prepaid LLM token wallet per student. balance_tokens is money-denominated, pinned to the real cost of delivering LLM usage (200,000 tokens costs ₹500 in real spend) -- see services/observability/src/walletPricing.ts. The recharge PRICE (₹1,099 for 200,000 tokens, see src/lib/walletTopup.ts) is independent of that cost basis and includes margin. Gates every LLM call; llm_provider picks gemini (default) or anthropic.';
