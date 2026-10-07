import { getSupabaseClient } from "./supabaseClient.js";
import { decrypt, encrypt, getAccessCode, getMerchantIdForRequest, getTransactionUrl } from "./ccavenue.js";

export type InitiateResult =
  | { encRequest: string; accessCode: string; actionUrl: string }
  | { error: string };

// Fixed top-up block -- confirmed explicitly, not a rate students can pick
// an arbitrary amount against. Kept here (not just in the web app) since
// this is also what gets validated against a wallet_topups row before
// ever building a CCAvenue request -- see initiateWalletTopup below.
const WALLET_TOPUP_AMOUNT_PAISE = 50_000; // ₹500
const WALLET_TOPUP_TOKENS = 200_000;

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

// Parallel, additive sibling of initiatePayment above for a wallet
// recharge -- kept separate rather than widening initiatePayment itself
// since the two have genuinely different validation (fixed amount, no
// pre-existing row to look up) and this way the existing, working
// subscription path is never touched. The CCAvenue order_id gets a "w_"
// prefix (subscription order_ids stay bare UUIDs, unchanged) so
// handleCallback -- which only ever receives the decrypted response, never
// the original request -- can tell the two apart deterministically with no
// extra lookup. Deliberately NOT "wtop_" (the original choice): CCAvenue
// rejects any order_id over 40 characters with status_message "Order no.
// should not exceed 40 characters." -- confirmed live as the cause of
// every wallet recharge failing with order_status "Invalid" -- and
// "wtop_" + a 36-character UUID is 41, one over. "w_" + the same UUID is
// 38, safely under.
export async function initiateWalletTopup(params: {
  topupId: string;
  userId: string;
  userEmail: string;
  origin: string;
}): Promise<InitiateResult> {
  const supabase = getSupabaseClient();

  const { data: topup } = await supabase
    .from("wallet_topups")
    .select("id, user_id, amount_paise, tokens_credited, status")
    .eq("id", params.topupId)
    .maybeSingle();

  if (!topup || topup.user_id !== params.userId || topup.status !== "pending_payment") {
    return { error: "No pending wallet top-up found" };
  }
  // Re-validated against the fixed block, same "never trust a client-
  // supplied amount" posture as initiatePayment -- the web app route that
  // creates this row already writes WALLET_TOPUP_AMOUNT_PAISE/
  // WALLET_TOPUP_TOKENS, but this is the actual trust boundary, not that
  // route.
  if (
    topup.amount_paise !== WALLET_TOPUP_AMOUNT_PAISE ||
    topup.tokens_credited !== WALLET_TOPUP_TOKENS
  ) {
    return { error: "Invalid wallet top-up amount" };
  }

  const orderId = `w_${topup.id}`;
  const amountRupees = (topup.amount_paise / 100).toFixed(2);

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

  const orderType = orderId.startsWith("w_") ? "wallet_topup" : "subscription";

  if (orderStatus !== "Success") {
    // Previously: any non-Success status just mapped to the same generic
    // "payment_failed" redirect in both branches below, with nothing
    // about WHY logged or stored anywhere -- confirmed live as the cause
    // of a report where a real transaction failed with no way to tell
    // whether it was a merchant-auth rejection, a declined card, an
    // abandoned 3D-secure step, or something else. CCAvenue's own
    // decrypted response carries more than just order_status --
    // failure_message/status_message typically explain why. Logged AND
    // persisted to payment_callback_failures (see that table's own
    // migration comment) so a report like this one is diagnosable
    // straight from Supabase; never surfaced to the student either way.
    const failureMessage =
      params.get("failure_message") ?? params.get("status_message") ?? null;
    console.error(
      `CCAvenue payment did not succeed for order ${orderId} (${orderType}): ` +
        `status="${orderStatus}", message="${failureMessage ?? "(none given)"}", ` +
        `tracking_id="${trackingId ?? "(none)"}"`,
    );
    try {
      const supabase = getSupabaseClient();
      const { error: logError } = await supabase.from("payment_callback_failures").insert({
        order_id: orderId,
        order_type: orderType,
        order_status: orderStatus,
        failure_message: failureMessage,
        raw_response: decoded.slice(0, 2000),
      });
      if (logError) {
        console.error("Failed to record payment_callback_failures row:", logError);
      }
    } catch (err) {
      console.error("Failed to record payment_callback_failures row:", err);
    }
  }

  // "w_" prefix (see initiateWalletTopup above) means this is a wallet
  // recharge, not a subscription payment -- the only signal available
  // here, since this handler only ever sees CCAvenue's own decrypted
  // response, never the original initiate request. Anything else falls
  // through to the existing, unchanged subscription logic below.
  if (orderId.startsWith("w_")) {
    return handleWalletTopupCallback(orderId.slice("w_".length), orderStatus, trackingId);
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

async function handleWalletTopupCallback(
  topupId: string,
  orderStatus: string | null,
  trackingId: string | null,
): Promise<{ redirectTo: string }> {
  if (orderStatus !== "Success") {
    return { redirectTo: "/account?error=payment_failed" };
  }

  const supabase = getSupabaseClient();
  const { data: topup, error } = await supabase
    .from("wallet_topups")
    .update({
      status: "active",
      ccavenue_tracking_id: trackingId,
      activated_at: new Date().toISOString(),
    })
    .eq("id", topupId)
    .eq("status", "pending_payment")
    .select("id, user_id, tokens_credited")
    .maybeSingle();

  if (error || !topup) {
    return { redirectTo: "/account?error=activation_failed" };
  }

  // credit_wallet, not a plain UPDATE -- the student's balance may have
  // changed (real usage, another top-up) since this row was created, so
  // this has to be an atomic add, not a blind overwrite -- see
  // supabase/migrations/0055_student_wallets.sql.
  const { error: creditError } = await supabase.rpc("credit_wallet", {
    p_user_id: topup.user_id,
    p_tokens: topup.tokens_credited,
  });

  if (creditError) {
    // The payment itself succeeded and is already recorded as `active`
    // above -- never tell the student it failed over a crediting error,
    // that would be wrong and could prompt a duplicate payment. Logged for
    // manual reconciliation instead.
    console.error(
      `Wallet top-up ${topup.id} marked active but crediting the wallet failed -- manual reconciliation needed:`,
      creditError,
    );
  }

  return { redirectTo: "/account" };
}
