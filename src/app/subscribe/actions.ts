"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { redeemCoupon as redeemCouponWithPaymentService } from "@/lib/paymentClient";

export interface RedeemCouponState {
  error?: string;
}

// Self-service version of the admin's activateSubscriptionWithoutPayment
// (src/app/admin/actions.ts) -- same end state (status -> active,
// activated_at stamped, no payment reference), just gated by knowing a
// valid, unused code instead of admin access. The actual claim + activation
// happens in services/payment (see src/lib/paymentClient.ts) -- this only
// does a cheap RLS-bound ownership check (does this user have a pending
// subscription at all) before handing off, since coupon_codes has no
// student-facing RLS policy and subscriptions has no user-facing UPDATE
// policy at all (see 0002_rls_policies.sql) -- there's no path for a plain
// session client to do the actual write anyway.
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

  redirect("/dashboard");
}
