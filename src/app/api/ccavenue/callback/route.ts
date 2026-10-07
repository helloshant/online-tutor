import { NextResponse } from "next/server";
import { handlePaymentCallback } from "@/lib/paymentClient";

// CCAvenue POSTs here (both on success and on failure/cancel -- redirect_url
// and cancel_url point at the same route, distinguished by order_status
// inside the encrypted response) as the customer's browser is redirected
// back from their hosted checkout page. This is the one public entry point
// into the payment flow that has to live in the web app rather than
// services/payment: that service has no public ingress of its own
// (internal-only, same as the orchestrator), but CCAvenue can only redirect
// a browser to a real public URL. This route does nothing but forward the
// raw encrypted response and turn the result into an HTTP redirect --
// decrypting, validating order_status, and activating the subscription all
// happen in the service (src/lib/paymentClient.ts).
export async function POST(request: Request) {
  // request.url reflects the Node process's own internal bind address
  // (e.g. 0.0.0.0:3000) when this app runs behind a reverse proxy, not the
  // public domain the browser actually used -- confirmed live as the
  // cause of the post-payment redirect pointing the browser at
  // 0.0.0.0:3000. Same x-forwarded-host/x-forwarded-proto fix already
  // used for an email's redirectTo in forgot-password/actions.ts and
  // admin/actions.ts, and for the redirect_url/cancel_url this app hands
  // CCAvenue in the first place (see /api/ccavenue/initiate and
  // /api/wallet/recharge/initiate).
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto") ?? "http";
  const origin = `${protocol}://${host}`;

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

  const { redirectTo } = await handlePaymentCallback(encResp);
  return NextResponse.redirect(`${origin}${redirectTo}`, { status: 303 });
}
