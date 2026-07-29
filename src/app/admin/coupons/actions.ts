"use server";

import { revalidatePath } from "next/cache";
import crypto from "node:crypto";
import { requireAdminPage } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

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

const MAX_BATCH = 100;

export async function generateCouponCodes(formData: FormData) {
  const session = await requireAdminPage("coupons");
  const countRaw = Number(formData.get("count"));
  const count = Number.isFinite(countRaw) ? Math.min(MAX_BATCH, Math.max(1, Math.trunc(countRaw))) : 1;

  const supabase = await createClient();
  const rows = Array.from({ length: count }, () => ({
    code: generateCode(),
    created_by: session.user.id,
  }));
  await supabase.from("coupon_codes").insert(rows);

  revalidatePath("/admin/coupons");
}

// Only for a code that's never been redeemed -- once used, a code is kept
// as a permanent record of which student it granted access to, same as the
// answer bank never hard-deletes a rejected entry.
export async function revokeCouponCode(id: string) {
  await requireAdminPage("coupons");
  const supabase = await createClient();
  await supabase.from("coupon_codes").delete().eq("id", id).is("used_by", null);
  revalidatePath("/admin/coupons");
}
