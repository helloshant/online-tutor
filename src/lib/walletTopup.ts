import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { BASE_RECHARGE_AMOUNT_PAISE, chargeAmountPaiseForBase, tokensForAmountPaise } from "@/lib/walletPricing";

// Shared by /api/wallet/recharge/initiate (the "Recharge" flow, plain or
// custom-amount) and redeemWalletCoupon (src/app/account/actions.ts,
// which needs a fresh pending row to apply a discount code against
// before any payment happens -- always at the reference amount, never a
// custom one, since a coupon is offered against the standard block) --
// both need the exact same row shape, so this is the one place that
// creates it.
//
// baseAmountPaise is the BASE (pre-GST) price the student picked --
// NOT validated here (bounds-checked by the caller,
// src/app/api/wallet/recharge/initiate/route.ts, so it can return a
// proper 400) and re-validated independently by
// services/payment/src/ccavenuePayment.ts's own reimplemented copy of
// this same formula before any CCAvenue request is ever built -- THAT is
// the real trust boundary, same "reimplement rather than share across a
// service boundary" convention every other cross-service constant in
// this app already follows. wallet_topups.amount_paise stores the
// GST-INCLUSIVE charge (what's actually collected and what CCAvenue
// sees); tokens_credited stays pinned to the base, never the inclusive
// total -- see GST_RATE's own comment in walletPricing.ts for why.
export async function createPendingWalletTopup(
  admin: SupabaseClient<Database>,
  userId: string,
  baseAmountPaise: number = BASE_RECHARGE_AMOUNT_PAISE,
): Promise<{ id: string } | null> {
  const { data: topup, error } = await admin
    .from("wallet_topups")
    .insert({
      user_id: userId,
      amount_paise: chargeAmountPaiseForBase(baseAmountPaise),
      tokens_credited: tokensForAmountPaise(baseAmountPaise),
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
