// Shared wallet-recharge pricing: the reference rate (₹1,099 = 200,000
// tokens) and the bounds/formula a CUSTOM amount is derived from. No
// "server-only" guard here, unlike src/lib/walletTopup.ts -- this is
// imported both server-side (that file's createPendingWalletTopup, and
// the initiate route's own bounds check) AND client-side
// (recharge-checkout.tsx's live token preview while typing a custom
// amount). The client-side use is non-authoritative display only; the
// real trust boundary is services/payment/src/ccavenuePayment.ts's own
// reimplemented copy of this exact formula, which re-derives tokens from
// amount_paise rather than trusting whatever this app's own insert wrote.
export const BASE_RECHARGE_AMOUNT_PAISE = 109_900; // ₹1,099
export const BASE_RECHARGE_TOKENS = 200_000;

// A custom amount has to sit somewhere between "too small to be worth a
// CCAvenue transaction" and "almost certainly a typo" -- ₹100 and
// ₹10,000, confirmed explicitly rather than left unbounded.
export const MIN_RECHARGE_AMOUNT_PAISE = 10_000; // ₹100
export const MAX_RECHARGE_AMOUNT_PAISE = 1_000_000; // ₹10,000

// Proportional at the SAME rate as the reference block -- a ₹5,000
// recharge gets exactly 5,000/1,099 times as many tokens as the ₹1,099
// one, preserving the same margin regardless of amount chosen. Rounds to
// the nearest whole token; the paise-level rounding this introduces is
// immaterial at these amounts.
export function tokensForAmountPaise(amountPaise: number): number {
  return Math.round((amountPaise * BASE_RECHARGE_TOKENS) / BASE_RECHARGE_AMOUNT_PAISE);
}

export function isValidRechargeAmountPaise(amountPaise: number): boolean {
  return (
    Number.isInteger(amountPaise) &&
    amountPaise >= MIN_RECHARGE_AMOUNT_PAISE &&
    amountPaise <= MAX_RECHARGE_AMOUNT_PAISE
  );
}
