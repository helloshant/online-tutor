"use client";

import { useRef, useState } from "react";

// Sibling of src/app/subscribe/ccavenue-checkout.tsx's CCAvenueCheckout for
// a wallet recharge instead of a subscription payment -- same hidden-form-
// submit pattern (CCAvenue's classic integration is a full-page redirect
// to their hosted checkout, not an in-page modal), pointed at the new
// /api/wallet/recharge/initiate route instead.
export function RechargeCheckout() {
  const formRef = useRef<HTMLFormElement>(null);
  const encRequestRef = useRef<HTMLInputElement>(null);
  const accessCodeRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startPayment() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/wallet/recharge/initiate", {
        method: "POST",
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
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <div>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <button
        type="button"
        onClick={startPayment}
        disabled={loading}
        className="w-full rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
      >
        {loading ? "Redirecting to secure checkout…" : "Recharge ₹500 for 200,000 tokens"}
      </button>
      <p className="mt-3 text-center text-xs text-foreground/68">
        Payments are handled securely by CCAvenue. Your card/UPI details never touch our servers.
      </p>

      <form ref={formRef} method="post" className="hidden">
        <input ref={encRequestRef} type="hidden" name="encRequest" />
        <input ref={accessCodeRef} type="hidden" name="access_code" />
      </form>
    </div>
  );
}
