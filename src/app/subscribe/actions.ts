"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export interface RedeemCouponState {
  error?: string;
}

// Self-service version of the admin's activateSubscriptionWithoutPayment
// (src/app/admin/actions.ts) -- same end state (status -> active,
// activated_at stamped, no payment reference), just gated by knowing a
// valid, unused code instead of admin access. Runs entirely through the
// service-role client after authenticating the caller here: coupon_codes
// has no student-facing RLS policy, and subscriptions has no user-facing
// UPDATE policy at all (see 0002_rls_policies.sql), so there's no path for
// a plain session client to do any of this.
export async function redeemCoupon(_prevState: RedeemCouponState, formData: FormData): Promise<RedeemCouponState> {
  const { user } = await requireUser();
  const code = String(formData.get("code") ?? "")
    .trim()
    .toUpperCase();

  if (!code) {
    return { error: "Enter a coupon code." };
  }

  const admin = createAdminClient();

  const { data: subscription } = await admin
    .from("subscriptions")
    .select("id, status")
    .eq("user_id", user.id)
    .eq("status", "pending_payment")
    .maybeSingle();

  if (!subscription) {
    return { error: "No pending subscription to apply this code to." };
  }

  const { data: coupon } = await admin.from("coupon_codes").select("id, used_by").eq("code", code).maybeSingle();

  if (!coupon) {
    return { error: "That coupon code isn't valid." };
  }
  if (coupon.used_by) {
    return { error: "That coupon code has already been used." };
  }

  // Atomic claim: the `is("used_by", null)` guard means two simultaneous
  // redemption attempts for the same code can't both succeed -- whichever
  // request loses the race gets zero rows back here and reports "already
  // used", the same double-guard pattern the old Razorpay verify route used
  // for its subscription-activation update.
  const { data: claimed } = await admin
    .from("coupon_codes")
    .update({ used_by: user.id, used_at: new Date().toISOString(), subscription_id: subscription.id })
    .eq("id", coupon.id)
    .is("used_by", null)
    .select("id")
    .maybeSingle();

  if (!claimed) {
    return { error: "That coupon code has already been used." };
  }

  const { error: activateError } = await admin
    .from("subscriptions")
    .update({ status: "active", activated_at: new Date().toISOString() })
    .eq("id", subscription.id)
    .eq("status", "pending_payment");

  if (activateError) {
    return { error: "Could not activate your subscription. Please contact support." };
  }

  redirect("/dashboard");
}
