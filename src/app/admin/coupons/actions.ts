"use server";

import { revalidatePath } from "next/cache";
import { requireAdminPage } from "@/lib/auth";
import { generateCoupons, revokeCoupon } from "@/lib/paymentClient";

const MAX_BATCH = 100;

// Code generation itself (alphabet, length, the actual insert) lives in
// services/payment now -- this only enforces the batch-size cap and passes
// through the requesting admin's id, matching the "authenticate/authorize
// here, do the actual privileged write in the service" split used
// throughout src/app/subscribe/actions.ts too.
export async function generateCouponCodes(formData: FormData) {
  const session = await requireAdminPage("coupons");
  const countRaw = Number(formData.get("count"));
  const count = Number.isFinite(countRaw) ? Math.min(MAX_BATCH, Math.max(1, Math.trunc(countRaw))) : 1;

  // The date input only gives a calendar date ("YYYY-MM-DD"), not a time --
  // treated as end-of-day UTC so a code stays valid through the entire day
  // an admin picked, rather than expiring at midnight at the start of it.
  const expiresAtRaw = formData.get("expiresAt");
  const expiresAt = typeof expiresAtRaw === "string" && expiresAtRaw ? `${expiresAtRaw}T23:59:59.999Z` : null;

  await generateCoupons(count, session.user.id, expiresAt);

  revalidatePath("/admin/coupons");
}

export async function revokeCouponCode(id: string) {
  await requireAdminPage("coupons");
  await revokeCoupon(id);
  revalidatePath("/admin/coupons");
}
