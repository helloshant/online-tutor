import "server-only";

// Everything about turning a pending subscription into an active one --
// the CCAvenue integration and coupon-code generation/redemption -- lives
// in services/payment now. This app only authenticates the caller and
// checks they own the subscription/action in question (a cheap RLS-bound
// check) before handing off; the service is the actual trust boundary for
// what amount gets charged or which coupon gets spent, re-deriving both
// itself rather than trusting anything relayed here.
function getPaymentUrl(): string {
  const url = process.env.PAYMENT_URL;
  if (!url) throw new Error("Missing PAYMENT_URL environment variable");
  return url;
}

async function callPaymentService<T>(path: string, body: unknown): Promise<T> {
  const url = `${getPaymentUrl().replace(/\/$/, "")}${path}`;
  const sharedSecret = process.env.PAYMENT_SHARED_SECRET;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sharedSecret ? { "x-internal-api-key": sharedSecret } : {}),
    },
    body: JSON.stringify(body),
  });

  const responseBody = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(responseBody?.error ?? `Payment service request failed with status ${res.status}`);
  }
  return responseBody as T;
}

export type InitiatePaymentResult = { encRequest: string; accessCode: string; actionUrl: string };

export async function initiatePayment(params: {
  subscriptionId: string;
  userId: string;
  userEmail: string;
  origin: string;
}): Promise<InitiatePaymentResult> {
  return callPaymentService<InitiatePaymentResult>("/v1/payment/initiate", params);
}

export async function handlePaymentCallback(encResp: string): Promise<{ redirectTo: string }> {
  return callPaymentService<{ redirectTo: string }>("/v1/payment/callback", { encResp });
}

export async function generateCoupons(
  count: number,
  createdBy: string,
  expiresAt?: string | null,
  discountPercent?: number
): Promise<{ codes: string[] }> {
  return callPaymentService<{ codes: string[] }>("/v1/coupons/generate", {
    count,
    createdBy,
    expiresAt,
    discountPercent,
  });
}

export async function revokeCoupon(id: string): Promise<void> {
  await callPaymentService("/v1/coupons/revoke", { id });
}

// Unlike the others, a redemption failure (invalid/already-used code) is an
// expected outcome the caller displays inline, not an exceptional one -- so
// this resolves with an error message rather than throwing, mirroring how
// the service itself returns 400 with an error body for this one route.
export async function redeemCoupon(params: {
  code: string;
  userId: string;
  subscriptionId: string;
}): Promise<{ error?: string; activated?: boolean; newAmountPaise?: number }> {
  try {
    return await callPaymentService<{ activated?: boolean; newAmountPaise?: number }>(
      "/v1/coupons/redeem",
      params
    );
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong." };
  }
}
