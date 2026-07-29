import crypto from "node:crypto";
import { getSupabaseClient } from "./supabaseClient.js";

// Crockford-style alphabet: no 0/O, 1/I/L, or U, so a code read aloud or
// handwritten from a screenshot is never ambiguous about which character it
// is. 12 characters from a 32-symbol alphabet is 60 bits of entropy --
// collisions against the table's unique constraint are astronomically
// unlikely at any realistic volume, so there's no retry-on-conflict loop
// here (a colliding row would simply fail its own insert, not the batch).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 12;
const GROUP_SIZE = 4;

function generateCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    raw += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += GROUP_SIZE) {
    groups.push(raw.slice(i, i + GROUP_SIZE));
  }
  return groups.join("-");
}

export async function generateCoupons(count: number, createdBy: string): Promise<string[]> {
  const supabase = getSupabaseClient();
  const codes = Array.from({ length: count }, generateCode);
  const { error } = await supabase.from("coupon_codes").insert(codes.map((code) => ({ code, created_by: createdBy })));
  if (error) throw new Error(`Failed to insert coupon codes: ${error.message}`);
  return codes;
}

// Only for a code that's never been redeemed -- once used, a code is kept
// as a permanent record of which student it granted access to, same as the
// answer bank never hard-deletes a rejected entry.
export async function revokeCoupon(id: string): Promise<void> {
  const supabase = getSupabaseClient();
  await supabase.from("coupon_codes").delete().eq("id", id).is("used_by", null);
}

export async function redeemCoupon(params: {
  code: string;
  userId: string;
  subscriptionId: string;
}): Promise<{ error?: string }> {
  const supabase = getSupabaseClient();
  const code = params.code.trim().toUpperCase();

  // Re-verified here rather than trusted from the caller -- the web app
  // already checked this subscription belongs to the requesting user before
  // calling this service, but this service is the actual trust boundary for
  // "did this subscription get activated," so it re-derives that itself
  // rather than taking the web app's word for it.
  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("id, user_id, status")
    .eq("id", params.subscriptionId)
    .maybeSingle();

  if (!subscription || subscription.user_id !== params.userId || subscription.status !== "pending_payment") {
    return { error: "No pending subscription to apply this code to." };
  }

  const { data: coupon } = await supabase.from("coupon_codes").select("id, used_by").eq("code", code).maybeSingle();
  if (!coupon) {
    return { error: "That coupon code isn't valid." };
  }
  if (coupon.used_by) {
    return { error: "That coupon code has already been used." };
  }

  // Atomic claim: the `is("used_by", null)` guard means two simultaneous
  // redemption attempts for the same code can't both succeed -- whichever
  // request loses the race gets zero rows back here and reports "already
  // used".
  const { data: claimed } = await supabase
    .from("coupon_codes")
    .update({ used_by: params.userId, used_at: new Date().toISOString(), subscription_id: subscription.id })
    .eq("id", coupon.id)
    .is("used_by", null)
    .select("id")
    .maybeSingle();

  if (!claimed) {
    return { error: "That coupon code has already been used." };
  }

  const { error: activateError } = await supabase
    .from("subscriptions")
    .update({ status: "active", activated_at: new Date().toISOString() })
    .eq("id", subscription.id)
    .eq("status", "pending_payment");

  if (activateError) {
    return { error: "Could not activate your subscription. Please contact support." };
  }

  return {};
}
