import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { encrypt, getAccessCode, getMerchantIdForRequest, getTransactionUrl } from "@/lib/ccavenue";

// Every code path below must return through NextResponse.json -- this
// top-level catch is the backstop so an unexpected throw (e.g. a missing
// env var) never reaches the client as an empty/non-JSON body.
export async function POST(request: Request) {
  try {
    return await handleInitiate(request);
  } catch (err) {
    console.error("Unexpected error in POST /api/ccavenue/initiate:", err);
    return NextResponse.json({ error: "Could not start payment" }, { status: 500 });
  }
}

async function handleInitiate(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("id, amount_paise, status")
    .eq("user_id", user.id)
    .eq("status", "pending_payment")
    .maybeSingle();

  if (!subscription) {
    return NextResponse.json({ error: "No pending subscription found" }, { status: 404 });
  }
  if (!subscription.amount_paise || subscription.amount_paise <= 0) {
    return NextResponse.json({ error: "Invalid subscription amount" }, { status: 400 });
  }

  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  // We choose the order_id sent to CCAvenue (unlike Razorpay, which minted
  // its own) -- using the subscription's own id means the callback route
  // can look the subscription up directly by id, with no extra column
  // needed to remember which order belongs to which subscription.
  const orderId = subscription.id;
  const amountRupees = (subscription.amount_paise / 100).toFixed(2);

  const requestString = new URLSearchParams({
    merchant_id: getMerchantIdForRequest(),
    order_id: orderId,
    currency: "INR",
    amount: amountRupees,
    redirect_url: `${origin}/api/ccavenue/callback`,
    cancel_url: `${origin}/api/ccavenue/callback`,
    language: "EN",
    billing_email: user.email ?? "",
  }).toString();

  return NextResponse.json({
    encRequest: encrypt(requestString),
    accessCode: getAccessCode(),
    actionUrl: getTransactionUrl(),
  });
}
