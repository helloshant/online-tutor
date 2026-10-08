"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redeemWalletTopupCoupon } from "@/lib/paymentClient";
import { createPendingWalletTopup } from "@/lib/walletTopup";
import type { ResetPasswordState } from "@/app/reset-password/actions";
import type { LlmProvider } from "@/lib/supabase/types";

// Same core operation as reset-password/actions.ts's own resetPassword
// (same validation, same supabase.auth.updateUser({ password }) call,
// same auto-stamped profiles.password_changed_at trigger) -- kept as its
// own action rather than reused directly because this one stays on the
// account page and returns a success message instead of redirect()ing to
// /dashboard, which would be the wrong outcome for a page the user is
// already on and likely wants to keep using afterward.
export async function changePassword(
  _prevState: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (password !== confirmPassword) {
    return { error: "Passwords don't match." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    return { error: error.message };
  }

  return { success: true };
}

// Switches a student's own llm_provider choice (gemini default, anthropic
// optional) -- see supabase/migrations/0055_student_wallets.sql. Uses the
// admin (service-role) client since student_wallets deliberately has no
// client-facing UPDATE policy (balance changes only ever happen through
// deduct_wallet/credit_wallet, never a direct write) -- this is the one
// field on that table a student DOES get to change directly, routed
// through a server action rather than a relaxed RLS policy so the write
// stays scoped to exactly this one column, for exactly the authenticated
// user's own row. Free and immediate either direction -- switching to
// Anthropic doesn't charge anything up front, it just means the SAME
// wallet balance burns faster on real usage (see
// services/observability/src/walletPricing.ts); switching back to Gemini
// is free too, with no refund for tokens already spent on Anthropic.
export async function switchLlmProvider(provider: LlmProvider): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  await createAdminClient()
    .from("student_wallets")
    .update({ llm_provider: provider })
    .eq("user_id", user.id);

  revalidatePath("/account");
}

export interface RedeemWalletCouponState {
  error?: string;
  // Set when the code was 100% off -- the wallet is already credited by
  // the time this returns, nothing left to pay.
  activatedMessage?: string;
  // Set when the code was a PARTIAL discount -- a real wallet_topups row
  // now exists at this already-reduced amount, still needing payment (see
  // CouponForm, which renders a "Pay ₹N" button pointed at this specific
  // topupId once this is set, through the same /api/wallet/recharge/
  // initiate route the plain "Recharge" button uses).
  pendingTopup?: { id: string; amountPaise: number };
}

// Self-service application of an admin-generated discount code to a wallet
// recharge -- see services/payment/src/coupons.ts's own
// redeemWalletTopupCoupon for the actual claim/discount logic, and
// supabase/migrations/0056_coupon_codes_wallet_topups.sql for why this
// targets wallet_topups rather than subscriptions now. Creates a fresh
// pending topup row up front (same fixed ₹1,099/200,000-token block the
// plain Recharge button creates) since a coupon needs something real to
// discount -- an abandoned, never-paid row left behind by a student who
// enters an invalid code or never completes payment is harmless, same as
// the old subscription flow already tolerated for pending_payment rows.
export async function redeemWalletCoupon(
  _prevState: RedeemWalletCouponState,
  formData: FormData,
): Promise<RedeemWalletCouponState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: "Not authenticated" };
  }

  const code = String(formData.get("code") ?? "").trim();
  if (!code) {
    return { error: "Enter a coupon code." };
  }

  const admin = createAdminClient();
  const topup = await createPendingWalletTopup(admin, user.id);
  if (!topup) {
    return { error: "Could not apply this code right now. Please try again." };
  }

  const result = await redeemWalletTopupCoupon({
    code,
    userId: user.id,
    topupId: topup.id,
  });

  if (result.error) {
    return { error: result.error };
  }

  if (result.activated) {
    revalidatePath("/account");
    return { activatedMessage: "Coupon applied! 200,000 tokens added to your wallet." };
  }

  return { pendingTopup: { id: topup.id, amountPaise: result.newAmountPaise ?? 0 } };
}
