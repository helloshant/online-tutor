import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { initiatePayment } from "@/lib/paymentClient";

// Every code path below must return through NextResponse.json -- this
// top-level catch is the backstop so an unexpected throw (e.g. the payment
// service being unreachable) never reaches the client as an empty/non-JSON
// body.
export async function POST(request: Request) {
  try {
    return await handleInitiate(request);
  } catch (err) {
    console.error("Unexpected error in POST /api/ccavenue/initiate:", err);
    return NextResponse.json({ error: "Could not start payment" }, { status: 500 });
  }
}

// A thin proxy: authenticates the caller and does a cheap ownership check,
// then hands off to services/payment, which owns the actual CCAvenue
// integration (request encryption) and independently re-verifies the
// subscription before charging it -- see src/lib/paymentClient.ts.
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
    .select("id")
    .eq("user_id", user.id)
    .eq("status", "pending_payment")
    .maybeSingle();

  if (!subscription) {
    return NextResponse.json({ error: "No pending subscription found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  try {
    const result = await initiatePayment({
      subscriptionId: subscription.id,
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
