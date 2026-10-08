// Shared wallet-recharge pricing: the reference rate (₹1,099 = 200,000
// tokens) and the bounds/formula a CUSTOM amount is derived from. No
// "server-only" guard here, unlike src/lib/walletTopup.ts -- this is
// imported both server-side (that file's createPendingWalletTopup, and
// the initiate route's own bounds check) AND client-side
// (recharge-checkout.tsx's live token/GST preview while typing a custom
// amount). The client-side use is non-authoritative display only; the
// real trust boundary is services/payment/src/ccavenuePayment.ts's own
// reimplemented copy of this exact formula, which re-derives tokens from
// amount_paise rather than trusting whatever this app's own insert wrote.
export const BASE_RECHARGE_AMOUNT_PAISE = 109_900; // ₹1,099 -- the BASE (pre-GST) price
export const BASE_RECHARGE_TOKENS = 200_000;

// GST, confirmed explicitly: 18%, the standard rate for online/digital
// services in India. Every amount a student picks -- a preset or a
// custom one -- is treated as the BASE (pre-tax) price; GST is added on
// top to get the amount actually charged (see chargeAmountPaiseForBase).
// Tokens stay pinned to the BASE amount, not the GST-inclusive charge --
// GST is money owed to the tax authority, never business revenue, so
// basing tokens on the inclusive total would silently hand out more real
// usage than the business actually keeps, eroding the margin this app's
// own pricing review (see walletPricing.ts in services/observability)
// was built around.
export const GST_RATE = 0.18;

// A custom BASE amount has to sit somewhere between "too small to be
// worth a CCAvenue transaction" and "almost certainly a typo" -- ₹100
// and ₹10,000, confirmed explicitly rather than left unbounded. Also
// must be a whole number of rupees (a multiple of 100 paise) -- not a
// UX nicety, this is what keeps chargeAmountPaiseForBase/
// baseAmountPaiseFromCharge exact integer arithmetic (base/100 * 118) in
// both directions with zero floating-point drift, which is what lets
// ccavenuePayment.ts reverse-derive the exact original base amount (and
// therefore the exact expected token count) from nothing but the
// GST-inclusive charge it actually collected.
export const MIN_RECHARGE_AMOUNT_PAISE = 10_000; // ₹100
export const MAX_RECHARGE_AMOUNT_PAISE = 1_000_000; // ₹10,000

// Proportional at the SAME rate as the reference block -- a ₹5,000 BASE
// amount gets exactly 5,000/1,099 times as many tokens as the ₹1,099
// one, preserving the same margin regardless of amount chosen. Rounds to
// the nearest whole token; the paise-level rounding this introduces is
// immaterial at these amounts.
export function tokensForAmountPaise(amountPaise: number): number {
  return Math.round((amountPaise * BASE_RECHARGE_TOKENS) / BASE_RECHARGE_AMOUNT_PAISE);
}

export function isValidRechargeAmountPaise(amountPaise: number): boolean {
  return (
    Number.isInteger(amountPaise) &&
    amountPaise % 100 === 0 &&
    amountPaise >= MIN_RECHARGE_AMOUNT_PAISE &&
    amountPaise <= MAX_RECHARGE_AMOUNT_PAISE
  );
}

// GST-inclusive amount actually charged for a given BASE price -- see
// GST_RATE's own comment for why this exists at all. Exact integer math
// (never `baseAmountPaise * (1 + GST_RATE)`, which is floating-point
// multiplication and can drift): baseAmountPaise is always a multiple of
// 100 (enforced by isValidRechargeAmountPaise), so dividing by 100 first
// gives a whole-rupee integer, and multiplying a whole integer by the
// integer 118 can never introduce rounding error.
export function chargeAmountPaiseForBase(baseAmountPaise: number): number {
  return (baseAmountPaise / 100) * 118;
}

// The exact inverse of chargeAmountPaiseForBase -- given a GST-inclusive
// charge, recovers the original BASE price. Only exact (an integer
// multiple of 100) when chargeAmountPaise is itself 118 × some whole
// number of rupees, i.e. was actually produced by
// chargeAmountPaiseForBase from a valid whole-rupee base; anything else
// (a tampered or malformed amount) comes out non-integer or not a
// multiple of 100, which isValidRechargeAmountPaise then correctly
// rejects. This asymmetry (clean forward math, self-validating reverse
// math) is exactly what lets ccavenuePayment.ts re-derive and validate
// the base amount from nothing but the stored, GST-inclusive
// amount_paise, without a separate column to remember it in.
export function baseAmountPaiseFromCharge(chargeAmountPaise: number): number {
  return (chargeAmountPaise / 118) * 100;
}
