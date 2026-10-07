import Link from "next/link";

// Static legal page, same shape as /terms and /privacy. Content adapted
// (not copied verbatim) from a sibling portal's own Refund & Cancellation
// Policy -- two things were changed to match how THIS product actually
// works, confirmed directly against the code before writing this:
//   1. Cancellation today is support-handled only (admin/actions.ts's own
//      cancelSubscription) -- there is no self-service "cancel" button
//      anywhere in /account or the dashboard, so the source text's "or
//      through your account dashboard" line was dropped rather than
//      claim a path that doesn't exist.
//   2. Subscriptions are activated by a single CCAvenue payment with no
//      automatic recurring/monthly re-charge anywhere in this codebase
//      (confirmed: no cron job, no renewal logic) -- so "effective from
//      the next billing cycle" doesn't describe anything real here. Kept
//      the same underlying meaning (cancelling doesn't refund time
//      already paid for) without the auto-renewal framing the source
//      text assumed.
export const metadata = {
  title: "Refund & Cancellation Policy — SyllabusMate",
};

export default function RefundPolicyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link href="/" className="text-sm font-semibold text-brand">
        SyllabusMate
      </Link>

      <h1 className="mt-6 text-2xl font-semibold sm:text-3xl">Refund &amp; Cancellation Policy</h1>
      <p className="mt-2 text-sm text-foreground/75">
        Read this policy carefully to understand how SyllabusMate handles refunds and service
        cancellations.
      </p>

      <div className="mt-8 space-y-8 text-sm leading-relaxed text-foreground/82">
        <section>
          <h2 className="text-base font-semibold text-foreground">1. Cancellation Policy</h2>
          <p className="mt-2">You may request cancellation of your subscription at any time. Please note the following:</p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>Cancellation requests should be submitted by contacting support.</li>
            <li>Cancelling stops access once processed; it does not refund any part of a period you&apos;ve already paid for.</li>
            <li>Partial refunds for the remainder of an already-paid period are generally not provided unless explicitly approved.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">2. Refund Policy</h2>
          <p className="mt-2">SyllabusMate is committed to fair service practices. Refunds will be provided under the following conditions:</p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>Refunds are applicable only for overpayments or double charges.</li>
            <li>No refund will be provided for services already rendered or consumed (e.g. tutoring sessions, exercises, or practice papers already generated for you).</li>
            <li>Refund requests must be submitted within 30 days of the payment date.</li>
            <li>Refunds, if approved, will be processed using the original payment method via CCAvenue.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">3. Service Suspension</h2>
          <p className="mt-2">
            If a service issue occurs due to a technical fault on our side, temporary suspension of your
            subscription may be applied until the issue is resolved. Refunds or service credits may be
            issued at SyllabusMate&apos;s discretion.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">4. No Refund Circumstances</h2>
          <p className="mt-2">Refunds will not be provided under the following circumstances:</p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>Service disruption due to scheduled maintenance or unavoidable technical issues.</li>
            <li>Cancellation requested after your subscribed period has already been used.</li>
            <li>Non-usage of purchased services.</li>
            <li>
              Violation of our{" "}
              <Link href="/terms" className="text-brand hover:underline">
                Terms &amp; Conditions
              </Link>
              .
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">5. Contact for Refunds &amp; Cancellations</h2>
          <p className="mt-2">
            For any queries or requests related to refunds or cancellations, please reach out to:
            <br />
            SyllabusMate Support
            <br />
            Address: Sapthagiri Sannidhi, Block C, Next Laxminaryana Temple Marathahalli, Bengaluru, 560037
          </p>
        </section>
      </div>

      <Link href="/" className="mt-10 inline-block text-sm text-brand hover:underline">
        ← Back to home
      </Link>
    </div>
  );
}
