"use client";

import { useActionState, useRef, useState } from "react";
import { redeemWalletCoupon, type RedeemWalletCouponState } from "./actions";

const initialState: RedeemWalletCouponState = {};

// Sibling of src/app/subscribe/coupon-form.tsx for a wallet recharge --
// see redeemWalletCoupon in ./actions.ts. Three outcomes: a 100%-off code
// credits the wallet immediately (nothing left to do here); a partial
// discount leaves a real, already-discounted pending wallet_topups row
// that still needs payment, so this renders a second "Pay ₹N" step inline
// rather than making the student re-enter the code anywhere; an invalid/
// used/expired code just shows an error and lets them retry.
export function CouponForm() {
  const [state, formAction, pending] = useActionState(redeemWalletCoupon, initialState);
  const formRef = useRef<HTMLFormElement>(null);
  const encRequestRef = useRef<HTMLInputElement>(null);
  const accessCodeRef = useRef<HTMLInputElement>(null);
  const [payLoading, setPayLoading] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  async function payForDiscountedTopup(topupId: string) {
    setPayError(null);
    setPayLoading(true);
    try {
      const res = await fetch("/api/wallet/recharge/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topupId }),
      });
      const body = await res.json();

      if (!res.ok) {
        throw new Error(body.error ?? "Could not start payment");
      }
      if (!formRef.current || !encRequestRef.current || !accessCodeRef.current) {
        throw new Error("Something went wrong. Please try again.");
      }

      formRef.current.action = body.actionUrl;
      encRequestRef.current.value = body.encRequest;
      accessCodeRef.current.value = body.accessCode;
      formRef.current.submit();
    } catch (err) {
      setPayError(err instanceof Error ? err.message : "Something went wrong");
      setPayLoading(false);
    }
  }

  if (state?.activatedMessage) {
    return (
      <p className="mt-6 border-t border-border pt-4 text-xs text-green-700">
        {state.activatedMessage}
      </p>
    );
  }

  if (state?.pendingTopup) {
    return (
      <div className="mt-6 border-t border-border pt-4">
        <p className="text-xs text-green-700">
          Coupon applied! Pay ₹{(state.pendingTopup.amountPaise / 100).toFixed(0)} to get your
          200,000 tokens.
        </p>
        {payError && <p className="mt-1.5 text-xs text-red-600">{payError}</p>}
        <button
          type="button"
          onClick={() => payForDiscountedTopup(state.pendingTopup!.id)}
          disabled={payLoading}
          className="mt-2 w-full rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
        >
          {payLoading
            ? "Redirecting to secure checkout…"
            : `Pay ₹${(state.pendingTopup.amountPaise / 100).toFixed(0)}`}
        </button>

        <form ref={formRef} method="post" className="hidden">
          <input ref={encRequestRef} type="hidden" name="encRequest" />
          <input ref={accessCodeRef} type="hidden" name="access_code" />
        </form>
      </div>
    );
  }

  return (
    <form action={formAction} className="mt-6 border-t border-border pt-4">
      <label htmlFor="wallet-coupon-code" className="block text-xs font-medium text-foreground/75">
        Have a discount code?
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id="wallet-coupon-code"
          name="code"
          placeholder="e.g. AB12-CD34-EF56"
          disabled={pending}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm uppercase outline-none focus:ring-2 focus:ring-brand disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-brand/5 disabled:opacity-60"
        >
          {pending ? "Applying…" : "Apply"}
        </button>
      </div>
      {state?.error && <p className="mt-1.5 text-xs text-red-600">{state.error}</p>}
    </form>
  );
}
