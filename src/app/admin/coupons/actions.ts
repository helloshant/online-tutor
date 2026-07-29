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

  await generateCoupons(count, session.user.id);

  revalidatePath("/admin/coupons");
}

export async function revokeCouponCode(id: string) {
  await requireAdminPage("coupons");
  await revokeCoupon(id);
  revalidatePath("/admin/coupons");
}
