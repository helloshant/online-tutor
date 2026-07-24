import "server-only";

import Razorpay from "razorpay";
import crypto from "node:crypto";

function getKeyId(): string {
  const key = process.env.RAZORPAY_KEY_ID;
  if (!key) throw new Error("Missing RAZORPAY_KEY_ID environment variable");
  return key;
}

function getKeySecret(): string {
  const key = process.env.RAZORPAY_KEY_SECRET;
  if (!key) throw new Error("Missing RAZORPAY_KEY_SECRET environment variable");
  return key;
}

// Razorpay's key_id is not a secret (it's shipped to the browser as part of
// checkout), only key_secret is. Exposing it via this getter instead of a
// NEXT_PUBLIC_ env var keeps a single source of truth and avoids leaking the
// secret if someone mistypes the NEXT_PUBLIC_ prefix on the wrong key.
export function getPublicKeyId(): string {
  return getKeyId();
}

export function getRazorpayClient(): Razorpay {
  return new Razorpay({ key_id: getKeyId(), key_secret: getKeySecret() });
}

export function verifyPaymentSignature(params: {
  orderId: string;
  paymentId: string;
  signature: string;
}): boolean {
  const expected = crypto
    .createHmac("sha256", getKeySecret())
    .update(`${params.orderId}|${params.paymentId}`)
    .digest("hex");

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(params.signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
