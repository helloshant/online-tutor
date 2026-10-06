import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { initiateWalletTopup } from "@/lib/paymentClient";

// Fixed top-up block, confirmed explicitly -- not a rate a student can pick
// an arbitrary amount against. Duplicated in
// services/payment/src/ccavenuePayment.ts (that service's own copy is the
// real trust boundary, re-validated against the row this route creates,
// never trusted from here) -- same "reimplement rather than share across
// a service boundary" convention every other cross-service constant in
// this app already follows.
const WALLET_TOPUP_AMOUNT_PAISE = 50_000; // ₹500
const WALLET_TOPUP_TOKENS = 200_000;

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

// A thin proxy, same shape as /api/ccavenue/initiate: creates the pending
// wallet_topups row here (this app owns that table's writes, same as
// subscriptions), then hands off to services/payment, which owns the
// actual CCAvenue integration and independently re-verifies the row
// before charging it -- see initiateWalletTopup in
// services/payment/src/ccavenuePayment.ts.
async function handleInitiate(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: topup, error: insertError } = await admin
    .from("wallet_topups")
    .insert({
      user_id: user.id,
      amount_paise: WALLET_TOPUP_AMOUNT_PAISE,
      tokens_credited: WALLET_TOPUP_TOKENS,
      status: "pending_payment",
    })
    .select("id")
    .single();

  if (insertError || !topup) {
    console.error("Failed to create wallet_topups row:", insertError);
    return NextResponse.json({ error: "Could not start payment" }, { status: 500 });
  }

  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  try {
    const result = await initiateWalletTopup({
      topupId: topup.id,
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
