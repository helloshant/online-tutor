"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { redeemCoupon as redeemCouponWithPaymentService } from "@/lib/paymentClient";

export interface RedeemCouponState {
  error?: string;
  discountMessage?: string;
}

// Self-service application of an admin-generated discount code. A 100%-off
// code reproduces the old free-access outcome (status -> active, no payment
// reference) -- anything less reduces the pending subscription's
// amount_paise instead, and the student still pays the remainder through
// CCAvenue. The actual claim + amount change happens in services/payment
// (see src/lib/paymentClient.ts) -- this only does a cheap RLS-bound
// ownership check (does this user have a pending subscription at all)
// before handing off, since coupon_codes has no student-facing RLS policy
// and subscriptions has no user-facing UPDATE policy at all (see
// 0002_rls_policies.sql) -- there's no path for a plain session client to
// do the actual write anyway.
export async function redeemCoupon(_prevState: RedeemCouponState, formData: FormData): Promise<RedeemCouponState> {
  const { user } = await requireUser();
  const code = String(formData.get("code") ?? "").trim();

  if (!code) {
    return { error: "Enter a coupon code." };
  }

  const supabase = await createClient();
  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("id")
    .eq("user_id", user.id)
    .eq("status", "pending_payment")
    .maybeSingle();

  if (!subscription) {
    return { error: "No pending subscription to apply this code to." };
  }

  const result = await redeemCouponWithPaymentService({
    code,
    userId: user.id,
    subscriptionId: subscription.id,
  });

  if (result.error) {
    return { error: result.error };
  }

  if (result.activated) {
    redirect("/dashboard");
  }

  // Not a redirect/notFound -- Next.js re-renders the current route's server
  // components after a Server Action completes, so the page below picks up
  // the discounted amount_paise on its own without an explicit refresh call.
  const newAmount = ((result.newAmountPaise ?? 0) / 100).toFixed(0);
  return { discountMessage: `Coupon applied! New total: ₹${newAmount}/month.` };
}
