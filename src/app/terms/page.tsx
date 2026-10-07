import Link from "next/link";

// Static legal page -- no data fetching, no auth gate (readable by anyone,
// logged in or not, same as /login and /signup). Content supplied directly
// by the business, not drafted here -- only the service name ("Webmate" in
// the source text) was swapped for the product's own name (SyllabusMate)
// to match the rest of the app; the registered company name and address in
// section 12 are left exactly as given (the phone number has been dropped
// at the business's request -- support now runs through /contact's
// callback-request form instead).
export const metadata = {
  title: "Terms & Conditions — SyllabusMate",
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link href="/" className="text-sm font-semibold text-brand">
        SyllabusMate
      </Link>

      <h1 className="mt-6 text-2xl font-semibold sm:text-3xl">Terms &amp; Conditions</h1>
      <p className="mt-2 text-sm text-foreground/75">
        Please read these Terms &amp; Conditions carefully before using SyllabusMate services.
      </p>

      <div className="mt-8 space-y-8 text-sm leading-relaxed text-foreground/82">
        <section>
          <h2 className="text-base font-semibold text-foreground">1. Definitions</h2>
          <p className="mt-2">
            In these Terms, &ldquo;SyllabusMate&rdquo;, &ldquo;we&rdquo;, &ldquo;our&rdquo;, or &ldquo;us&rdquo;
            refers to the service provider. The terms &ldquo;customer&rdquo;, &ldquo;subscriber&rdquo;, or
            &ldquo;you&rdquo; refer to the individual or entity using our services. &ldquo;Services&rdquo;
            refers to internet access, applications, and any related offerings provided by SyllabusMate.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">2. Use of Services</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>Services must only be used for lawful purposes.</li>
            <li>You may not engage in hacking, spamming, phishing, malware distribution, or unlawful activities.</li>
            <li>You may not transmit or store offensive, abusive, or defamatory content.</li>
            <li>Unauthorized sharing or resale of services is strictly prohibited.</li>
            <li>Misuse of services may result in suspension or termination without refund.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">3. Website &amp; Content Usage</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>Content is for general information only and may change without notice.</li>
            <li>We make no warranties regarding accuracy, timeliness, or completeness.</li>
            <li>Use of information is at your own risk.</li>
            <li>Unauthorized use may lead to legal claims and/or criminal action.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">4. Service Availability &amp; Limitations</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>Service availability may be affected by maintenance, technical issues, or factors beyond our control.</li>
            <li>100% uptime is not guaranteed.</li>
            <li>Network speeds may vary depending on technical and geographical factors.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">5. Payments, Billing &amp; Refunds</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>Subscription fees are payable in advance based on your chosen plan.</li>
            <li>Payments must be made through authorized methods.</li>
            <li>All payments are non-refundable.</li>
            <li>Failure to pay may result in suspension or termination of services.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">6. Intellectual Property</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>All website materials are owned by or licensed to SyllabusMate.</li>
            <li>Reproduction or redistribution without written consent is prohibited.</li>
            <li>Third-party trademarks are acknowledged where applicable.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">7. Third-Party Links</h2>
          <p className="mt-2">
            Our website may include links to external websites for convenience. We do not endorse or take
            responsibility for the content of such sites.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">8. Privacy &amp; Data Protection</h2>
          <p className="mt-2">
            We respect your privacy. Personal data will be managed as per our Privacy Policy. Certain data
            may be retained or disclosed in compliance with legal obligations.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">9. Limitation of Liability</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>We are not liable for data loss, revenue loss, or service interruptions.</li>
            <li>We are not responsible for misuse of your connection by third parties.</li>
            <li>We are not liable for indirect, incidental, or consequential damages.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">10. Governing Law &amp; Jurisdiction</h2>
          <p className="mt-2">
            These Terms are governed by the laws of India. Any disputes will fall under the jurisdiction of
            courts in Bengaluru, India.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">11. Amendments</h2>
          <p className="mt-2">
            SyllabusMate reserves the right to amend these Terms at any time. Continued use of our services
            after changes implies acceptance of the updated Terms.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">12. Contact Us</h2>
          <p className="mt-2">
            Odantapuri Financial Services Pvt. Ltd.
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
