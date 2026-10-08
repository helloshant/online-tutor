"use client";

import { useRef, useState } from "react";
import {
  BASE_RECHARGE_AMOUNT_PAISE,
  MAX_RECHARGE_AMOUNT_PAISE,
  MIN_RECHARGE_AMOUNT_PAISE,
  isValidRechargeAmountPaise,
  tokensForAmountPaise,
} from "@/lib/walletPricing";

// Preset quick-pick amounts shown as buttons, plus a free-text "Custom"
// option for anything else (e.g. ₹5,000) -- all proportional at the same
// rate as the reference block (see tokensForAmountPaise), so picking a
// bigger amount just buys more tokens at the same per-rupee rate, never
// a different deal.
const PRESET_AMOUNTS_PAISE = [BASE_RECHARGE_AMOUNT_PAISE, 299_900, 499_900]; // ₹1,099 / ₹2,999 / ₹4,999

const MIN_RUPEES = MIN_RECHARGE_AMOUNT_PAISE / 100;
const MAX_RUPEES = MAX_RECHARGE_AMOUNT_PAISE / 100;

// Sibling of src/app/subscribe/ccavenue-checkout.tsx's CCAvenueCheckout for
// a wallet recharge instead of a subscription payment -- same hidden-form-
// submit pattern (CCAvenue's classic integration is a full-page redirect
// to their hosted checkout, not an in-page modal), pointed at the new
// /api/wallet/recharge/initiate route instead. The chosen amount (preset
// or custom) is sent as amountPaise -- display/preview only here, the
// server independently bounds-checks it (src/app/api/wallet/recharge/
// initiate/route.ts) and the payment service re-derives tokens from it
// before ever charging anything (services/payment/src/
// ccavenuePayment.ts), so nothing here is actually trusted.
export function RechargeCheckout() {
  const formRef = useRef<HTMLFormElement>(null);
  const encRequestRef = useRef<HTMLInputElement>(null);
  const accessCodeRef = useRef<HTMLInputElement>(null);
  const [selectedPaise, setSelectedPaise] = useState<number>(PRESET_AMOUNTS_PAISE[0]);
  const [customMode, setCustomMode] = useState(false);
  const [customRupees, setCustomRupees] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountPaise = customMode ? Math.round(Number(customRupees || 0) * 100) : selectedPaise;
  const amountValid = customMode ? isValidRechargeAmountPaise(amountPaise) : true;
  const tokens = tokensForAmountPaise(amountPaise);

  async function startPayment() {
    if (!amountValid) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/wallet/recharge/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountPaise }),
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
      <div className="flex flex-wrap gap-2">
        {PRESET_AMOUNTS_PAISE.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => {
              setCustomMode(false);
              setSelectedPaise(p);
            }}
            disabled={loading}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:opacity-60 ${
              !customMode && selectedPaise === p
                ? "border-brand bg-brand/5 text-brand"
                : "border-border text-foreground/75 hover:bg-brand/5"
            }`}
          >
            ₹{(p / 100).toLocaleString()}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCustomMode(true)}
          disabled={loading}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:opacity-60 ${
            customMode
              ? "border-brand bg-brand/5 text-brand"
              : "border-border text-foreground/75 hover:bg-brand/5"
          }`}
        >
          Custom amount
        </button>
      </div>

      {customMode && (
        <div className="mt-3">
          <label htmlFor="custom-recharge-rupees" className="sr-only">
            Custom amount in rupees
          </label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-foreground/68">₹</span>
            <input
              id="custom-recharge-rupees"
              type="number"
              inputMode="numeric"
              min={MIN_RUPEES}
              max={MAX_RUPEES}
              step={1}
              value={customRupees}
              onChange={(e) => setCustomRupees(e.target.value)}
              disabled={loading}
              placeholder={`${MIN_RUPEES}–${MAX_RUPEES}`}
              className="w-32 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-brand disabled:opacity-60"
            />
          </div>
          {customRupees && !amountValid && (
            <p className="mt-1.5 text-xs text-red-600">
              Enter an amount between ₹{MIN_RUPEES.toLocaleString()} and ₹{MAX_RUPEES.toLocaleString()}.
            </p>
          )}
        </div>
      )}

      <p className="mt-3 text-sm text-foreground/75">
        {amountValid ? (
          <>
            ₹{(amountPaise / 100).toLocaleString()} gets you{" "}
            <span className="font-medium text-foreground">{tokens.toLocaleString()} tokens</span>.
          </>
        ) : (
          "Choose an amount to see how many tokens it buys."
        )}
      </p>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <button
        type="button"
        onClick={startPayment}
        disabled={loading || !amountValid}
        className="mt-3 w-full rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
      >
        {loading ? "Redirecting to secure checkout…" : `Recharge ₹${(amountPaise / 100).toLocaleString()}`}
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
