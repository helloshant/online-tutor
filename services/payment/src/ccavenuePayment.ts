import { getSupabaseClient } from "./supabaseClient.js";
import { decrypt, encrypt, getAccessCode, getMerchantIdForRequest, getTransactionUrl } from "./ccavenue.js";

export type InitiateResult =
  | { encRequest: string; accessCode: string; actionUrl: string }
  | { error: string };

// origin is the web app's own public origin (it knows this from the
// incoming request it received from the browser; this service, being
// internal-only, has no way to know it independently) -- used only to build
// where CCAvenue redirects the customer's browser back to, not treated as
// sensitive.
export async function initiatePayment(params: {
  subscriptionId: string;
  userId: string;
  userEmail: string;
  origin: string;
}): Promise<InitiateResult> {
  const supabase = getSupabaseClient();

  // Re-fetched and re-validated here rather than trusted from the caller --
  // same reasoning as redeemCoupon in coupons.ts. The amount charged must
  // never come from anywhere but this service's own read of the
  // subscription row.
  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("id, user_id, amount_paise, status")
    .eq("id", params.subscriptionId)
    .maybeSingle();

  if (!subscription || subscription.user_id !== params.userId || subscription.status !== "pending_payment") {
    return { error: "No pending subscription found" };
  }
  if (!subscription.amount_paise || subscription.amount_paise <= 0) {
    return { error: "Invalid subscription amount" };
  }

  // We choose the order_id sent to CCAvenue (unlike Razorpay, which minted
  // its own) -- using the subscription's own id means the callback can look
  // the subscription up directly by id, with no extra column needed to
  // remember which order belongs to which subscription.
  const orderId = subscription.id;
  const amountRupees = (subscription.amount_paise / 100).toFixed(2);

  const requestString = new URLSearchParams({
    merchant_id: getMerchantIdForRequest(),
    order_id: orderId,
    currency: "INR",
    amount: amountRupees,
    redirect_url: `${params.origin}/api/ccavenue/callback`,
    cancel_url: `${params.origin}/api/ccavenue/callback`,
    language: "EN",
    billing_email: params.userEmail || "",
  }).toString();

  return {
    encRequest: encrypt(requestString),
    accessCode: getAccessCode(),
    actionUrl: getTransactionUrl(),
  };
}

// CCAvenue POSTs its encrypted response to the web app's public callback
// route (both success and failure/cancel -- redirect_url and cancel_url
// point at the same route, distinguished by order_status in the decrypted
// response), which forwards the raw encResp here. The encrypted response
// itself *is* the integrity check -- only someone holding the working key
// could have produced a payload that decrypts cleanly, so there's no
// separate signature check the way Razorpay's HMAC verification needed.
export async function handleCallback(encResp: string): Promise<{ redirectTo: string }> {
  let decoded: string;
  try {
    decoded = decrypt(encResp);
  } catch {
    return { redirectTo: "/subscribe?error=invalid_response" };
  }

  const params = new URLSearchParams(decoded);
  const orderId = params.get("order_id");
  const orderStatus = params.get("order_status");
  const trackingId = params.get("tracking_id");

  if (!orderId) {
    return { redirectTo: "/subscribe?error=invalid_response" };
  }
  if (orderStatus !== "Success") {
    return { redirectTo: "/subscribe?error=payment_failed" };
  }

  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("subscriptions")
    .update({
      status: "active",
      ccavenue_tracking_id: trackingId,
      activated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .eq("status", "pending_payment");

  if (error) {
    return { redirectTo: "/subscribe?error=activation_failed" };
  }

  return { redirectTo: "/dashboard" };
}
