import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { initiateWalletTopup } from "@/lib/paymentClient";
import { createPendingWalletTopup } from "@/lib/walletTopup";
import {
  BASE_RECHARGE_AMOUNT_PAISE,
  MAX_RECHARGE_AMOUNT_PAISE,
  MIN_RECHARGE_AMOUNT_PAISE,
  isValidRechargeAmountPaise,
} from "@/lib/walletPricing";

// Every code path below must return through NextResponse.json -- this
// top-level catch is the backstop so an unexpected throw (e.g. the payment
// service being unreachable) never reaches the client as an empty/non-JSON
// body. Same pattern as /api/ccavenue/initiate.
export async function POST(request: Request) {
  try {
    return await handleInitiate(request);
  } catch (err) {
    console.error(
      "Unexpected error in POST /api/wallet/recharge/initiate:",
      err,
    );
    return NextResponse.json({ error: "Could not start payment" }, { status: 500 });
  }
}

// A thin proxy, same shape as /api/ccavenue/initiate: either creates a
// fresh pending wallet_topups row (the "Recharge" flow -- a preset or a
// custom amount, see `amountPaise` below) or, when `topupId` is given,
// pays for an EXISTING one instead -- the latter is what a discounted-
// but-not-free coupon redemption needs (see src/app/account/actions.ts's
// redeemWalletCoupon, which already created the row and applied the
// discount; this just completes payment for it). Either way, this app
// owns the row's writes (same as subscriptions), then hands off to
// services/payment, which owns the actual CCAvenue integration and
// independently re-verifies the row before charging it -- see
// initiateWalletTopup in services/payment/src/ccavenuePayment.ts.
async function handleInitiate(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const existingTopupId =
    typeof body?.topupId === "string" ? body.topupId : undefined;
  const requestedAmountPaise =
    typeof body?.amountPaise === "number" ? body.amountPaise : undefined;

  const admin = createAdminClient();
  let topupId: string;

  if (existingTopupId) {
    // Re-validated server-side (ownership + still pending), never trusted
    // from the client -- the actual amount/tokens are re-derived from the
    // row itself by initiateWalletTopup below, same trust boundary every
    // other payment-initiating route in this app already draws.
    const { data: topup } = await admin
      .from("wallet_topups")
      .select("id")
      .eq("id", existingTopupId)
      .eq("user_id", user.id)
      .eq("status", "pending_payment")
      .maybeSingle();
    if (!topup) {
      return NextResponse.json(
        { error: "No pending recharge found" },
        { status: 404 },
      );
    }
    topupId = topup.id;
  } else {
    // A student-chosen custom amount -- bounds-checked here so a bad
    // amount gets a real error message instead of silently falling back
    // to the reference block; re-validated again, independently, by
    // services/payment/src/ccavenuePayment.ts before any CCAvenue request
    // is built, which is the actual trust boundary, not this check.
    const amountPaise = requestedAmountPaise ?? BASE_RECHARGE_AMOUNT_PAISE;
    if (!isValidRechargeAmountPaise(amountPaise)) {
      return NextResponse.json(
        {
          error: `Enter an amount between ₹${MIN_RECHARGE_AMOUNT_PAISE / 100} and ₹${MAX_RECHARGE_AMOUNT_PAISE / 100}.`,
        },
        { status: 400 },
      );
    }
    const topup = await createPendingWalletTopup(admin, user.id, amountPaise);
    if (!topup) {
      return NextResponse.json({ error: "Could not start payment" }, { status: 500 });
    }
    topupId = topup.id;
  }

  // request.url reflects the Node process's own internal bind address
  // (e.g. 0.0.0.0:3000) when this app runs behind a reverse proxy, not the
  // public domain the browser actually used -- confirmed live as the
  // cause of CCAvenue's redirect/cancel URL pointing at 0.0.0.0:3000,
  // unreachable once the student's browser tried to come back from the
  // hosted payment page. Same x-forwarded-host/x-forwarded-proto fix
  // already used for an email's redirectTo in forgot-password/actions.ts
  // and admin/actions.ts.
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto") ?? "http";
  const origin = `${protocol}://${host}`;

  try {
    const result = await initiateWalletTopup({
      topupId,
      userId: user.id,
      userEmail: user.email ?? "",
      origin,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error("Payment service initiate request failed:", err);
    return NextResponse.json({ error: "Could not start payment" }, { status: 502 });
  }
}
