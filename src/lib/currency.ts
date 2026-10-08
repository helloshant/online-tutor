// Display-only USD -> INR conversion for the admin observability pages.
// chat_events.cost_usd is stored in USD (each call's own per-model pricing
// table is quoted in USD), but every other price in this app is quoted in
// INR, so admin cost figures are converted here for display. This is a
// separate copy of the same rate services/observability/src/walletPricing.ts
// uses for the actual wallet-deduction math -- billing math stays owned by
// that service; this one only ever feeds a label on a page.
const USD_TO_INR_RATE = Number(process.env.USD_TO_INR_RATE) || 96; // as of 2026-10

const INR_FORMATTER = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export function formatInrFromUsd(costUsd: number): string {
  return INR_FORMATTER.format(costUsd * USD_TO_INR_RATE);
}
