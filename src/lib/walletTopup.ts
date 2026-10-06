import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

// Fixed top-up block, confirmed explicitly -- not a rate a student can pick
// an arbitrary amount against. Duplicated in
// services/payment/src/ccavenuePayment.ts (that service's own copy is the
// real trust boundary, re-validated against the row this creates, never
// trusted from here) -- same "reimplement rather than share across a
// service boundary" convention every other cross-service constant in this
// app already follows.
export const WALLET_TOPUP_AMOUNT_PAISE = 50_000; // ₹500
export const WALLET_TOPUP_TOKENS = 200_000;

// Shared by /api/wallet/recharge/initiate (the plain "Recharge" button) and
// redeemWalletCoupon (src/app/account/actions.ts, which needs a fresh
// pending row to apply a discount code against before any payment happens)
// -- both need the exact same row shape, so this is the one place that
// creates it.
export async function createPendingWalletTopup(
  admin: SupabaseClient<Database>,
  userId: string,
): Promise<{ id: string } | null> {
  const { data: topup, error } = await admin
    .from("wallet_topups")
    .insert({
      user_id: userId,
      amount_paise: WALLET_TOPUP_AMOUNT_PAISE,
      tokens_credited: WALLET_TOPUP_TOKENS,
      status: "pending_payment",
    })
    .select("id")
    .single();

  if (error || !topup) {
    console.error("Failed to create wallet_topups row:", error);
    return null;
  }
  return topup;
}
