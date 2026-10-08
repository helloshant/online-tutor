import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { BASE_RECHARGE_AMOUNT_PAISE, tokensForAmountPaise } from "@/lib/walletPricing";

// Shared by /api/wallet/recharge/initiate (the "Recharge" flow, plain or
// custom-amount) and redeemWalletCoupon (src/app/account/actions.ts,
// which needs a fresh pending row to apply a discount code against
// before any payment happens -- always at the reference amount, never a
// custom one, since a coupon is offered against the standard block) --
// both need the exact same row shape, so this is the one place that
// creates it.
//
// amountPaise is NOT validated here -- bounds-checked by the caller
// (src/app/api/wallet/recharge/initiate/route.ts, so it can return a
// proper 400) and re-validated independently by
// services/payment/src/ccavenuePayment.ts's own reimplemented copy of
// tokensForAmountPaise before any CCAvenue request is ever built -- THAT
// is the real trust boundary, same "reimplement rather than share across
// a service boundary" convention every other cross-service constant in
// this app already follows.
export async function createPendingWalletTopup(
  admin: SupabaseClient<Database>,
  userId: string,
  amountPaise: number = BASE_RECHARGE_AMOUNT_PAISE,
): Promise<{ id: string } | null> {
  const { data: topup, error } = await admin
    .from("wallet_topups")
    .insert({
      user_id: userId,
      amount_paise: amountPaise,
      tokens_credited: tokensForAmountPaise(amountPaise),
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
