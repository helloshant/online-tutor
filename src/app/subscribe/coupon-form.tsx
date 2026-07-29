"use client";

import { useActionState } from "react";
import { redeemCoupon, type RedeemCouponState } from "./actions";

const initialState: RedeemCouponState = {};

export function CouponForm() {
  const [state, formAction, pending] = useActionState(redeemCoupon, initialState);

  // A discount code is single-use per subscription (services/payment
  // rejects a second one), so once one lands successfully there's nothing
  // useful left to submit here -- disable rather than let a retry surface a
  // confusing "already applied" error.
  const applied = Boolean(state?.discountMessage);

  return (
    <form action={formAction} className="mt-6 border-t border-border pt-4">
      <label htmlFor="coupon-code" className="block text-xs font-medium text-foreground/60">
        Have a discount code?
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id="coupon-code"
          name="code"
          placeholder="e.g. AB12-CD34-EF56"
          disabled={pending || applied}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm uppercase outline-none focus:ring-2 focus:ring-brand disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={pending || applied}
          className="shrink-0 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-brand/5 disabled:opacity-60"
        >
          {pending ? "Applying…" : "Apply"}
        </button>
      </div>
      {state?.error && <p className="mt-1.5 text-xs text-red-600">{state.error}</p>}
      {state?.discountMessage && <p className="mt-1.5 text-xs text-green-700">{state.discountMessage}</p>}
    </form>
  );
}
