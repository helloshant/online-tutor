"use client";

import Script from "next/script";
import { useRouter } from "next/navigation";
import { useState } from "react";

declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => {
      open: () => void;
    };
  }
}

export function RazorpayCheckout() {
  const router = useRouter();
  const [scriptReady, setScriptReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startPayment() {
    setError(null);
    setLoading(true);
    try {
      const orderRes = await fetch("/api/razorpay/create-order", { method: "POST" });
      const order = await orderRes.json();

      if (!orderRes.ok) {
        throw new Error(order.error ?? "Could not start payment");
      }

      if (!scriptReady || typeof window.Razorpay === "undefined") {
        throw new Error("Payment SDK hasn't loaded yet. Please try again in a moment.");
      }

      const razorpay = new window.Razorpay({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        order_id: order.orderId,
        name: "TutorOps",
        description: "Subject subscription",
        theme: { color: "#4f46e5" },
        handler: async (response: {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) => {
          const verifyRes = await fetch("/api/razorpay/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(response),
          });
          if (!verifyRes.ok) {
            const body = await verifyRes.json().catch(() => ({}));
            setError(body.error ?? "Payment verification failed. Please contact support.");
            return;
          }
          router.push("/dashboard");
          router.refresh();
        },
        modal: {
          ondismiss: () => setLoading(false),
        },
      });
      razorpay.open();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-6">
      <Script
        src="https://checkout.razorpay.com/v1/checkout.js"
        onReady={() => setScriptReady(true)}
        onLoad={() => setScriptReady(true)}
      />

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <button
        type="button"
        onClick={startPayment}
        disabled={loading}
        className="w-full rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
      >
        {loading ? "Opening secure checkout…" : "Pay with Razorpay"}
      </button>
      <p className="mt-3 text-center text-xs text-foreground/50">
        Payments are handled securely by Razorpay. Your card/UPI details never touch our servers.
      </p>
    </div>
  );
}
