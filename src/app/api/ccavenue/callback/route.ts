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

  const { redirectTo } = await handlePaymentCallback(encResp);
  return NextResponse.redirect(`${origin}${redirectTo}`, { status: 303 });
}
