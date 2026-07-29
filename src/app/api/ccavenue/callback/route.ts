import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/ccavenue";

// CCAvenue POSTs here (both on success and on failure/cancel -- redirect_url
// and cancel_url point at the same route, distinguished by order_status in
// the decrypted response) as the customer's browser is redirected back from
// their hosted checkout page. Unlike Razorpay's client-relayed signature
// check, the encrypted response itself *is* the integrity check here --
// only someone holding the working key could have produced a payload that
// decrypts cleanly, so there's no separate verification step beyond
// decrypting and reading order_status.
export async function POST(request: Request) {
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  try {
    return await handleCallback(request, origin);
  } catch (err) {
    console.error("Unexpected error in POST /api/ccavenue/callback:", err);
    return NextResponse.redirect(`${origin}/subscribe?error=activation_failed`, { status: 303 });
  }
}

async function handleCallback(request: Request, origin: string) {
  const formData = await request.formData();
  const encResp = formData.get("encResp");

  if (typeof encResp !== "string" || !encResp) {
    return NextResponse.redirect(`${origin}/subscribe?error=invalid_response`, { status: 303 });
  }

  let decoded: string;
  try {
    decoded = decrypt(encResp);
  } catch {
    return NextResponse.redirect(`${origin}/subscribe?error=invalid_response`, { status: 303 });
  }

  const params = new URLSearchParams(decoded);
  const orderId = params.get("order_id");
  const orderStatus = params.get("order_status");
  const trackingId = params.get("tracking_id");

  if (!orderId) {
    return NextResponse.redirect(`${origin}/subscribe?error=invalid_response`, { status: 303 });
  }
  if (orderStatus !== "Success") {
    return NextResponse.redirect(`${origin}/subscribe?error=payment_failed`, { status: 303 });
  }

  // Activation must bypass RLS (a user can never set their own subscription
  // to 'active') -- same reasoning as the old Razorpay verify route, just
  // gated on a successful decrypt + order_status instead of an HMAC check.
  // order_id is the subscription's own id (see initiate/route.ts), and the
  // status guard prevents replaying an old callback against an
  // already-activated or since-cancelled subscription.
  const admin = createAdminClient();
  const { error } = await admin
    .from("subscriptions")
    .update({
      status: "active",
      ccavenue_tracking_id: trackingId,
      activated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .eq("status", "pending_payment");

  if (error) {
    return NextResponse.redirect(`${origin}/subscribe?error=activation_failed`, { status: 303 });
  }

  return NextResponse.redirect(`${origin}/dashboard`, { status: 303 });
}
