import Link from "next/link";

// Static legal page, same shape as /terms -- no data fetching, no auth
// gate. Content adapted (not copied verbatim) from a sibling portal's own
// Privacy Policy to actually describe what THIS product collects and does
// (an AI tutoring platform for school students, not a generic internet/
// connectivity service) -- see each section's own comment for what
// changed and why. Company name, phone, and address in Contact Us are
// kept exactly as given.
export const metadata = {
  title: "Privacy Policy — SyllabusMate",
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link href="/" className="text-sm font-semibold text-brand">
        SyllabusMate
      </Link>

      <h1 className="mt-6 text-2xl font-semibold sm:text-3xl">Privacy Policy</h1>
      <p className="mt-2 text-sm text-foreground/75">
        Please read this Privacy Policy carefully to understand how SyllabusMate collects, uses, and
        protects your information.
      </p>

      <div className="mt-8 space-y-8 text-sm leading-relaxed text-foreground/82">
        <section>
          <h2 className="text-base font-semibold text-foreground">1. Information We Collect</h2>
          <p className="mt-2">We may collect the following types of information:</p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>
              <span className="font-medium text-foreground">Account information:</span> your name, email
              address, and password (stored securely, never in plain text); if you sign in with Google,
              the name and email your Google account provides.
            </li>
            <li>
              <span className="font-medium text-foreground">Learning information:</span> the board, grade,
              subjects, and language you select; the questions you ask and the tutor&apos;s replies;
              exercises, practice papers, and topic summaries generated for you; and any images you upload
              alongside a question.
            </li>
            <li>
              <span className="font-medium text-foreground">Payment information:</span> your subscription
              plan and billing email are shared with our payment processor, CCAvenue, to process payments
              -- we do not ourselves store your card, UPI, or bank account details.
            </li>
            <li>
              <span className="font-medium text-foreground">Session information:</span> basic technical
              information needed to keep you signed in and to limit an account to one active device at a
              time.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">2. How We Use Your Information</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>Provide and personalize your tutoring -- keeping every answer inside your own board, grade, subject, and syllabus</li>
            <li>Process subscription payments and manage your account, including your free-trial and subscription usage allowance</li>
            <li>Generate and improve exercises, practice papers, and topic summaries</li>
            <li>Communicate service updates or issues affecting your account</li>
            <li>Comply with legal obligations</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">3. Sharing of Information</h2>
          <p className="mt-2">We do not sell or rent your personal information. We may share information in the following cases:</p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>
              <span className="font-medium text-foreground">Service providers:</span> our database/hosting
              provider, our payment processor (CCAvenue), and the AI model provider that powers tutor
              replies -- each receives only what it needs to do its part (e.g. your question and syllabus
              context to generate a reply), not your full account details.
            </li>
            <li>
              <span className="font-medium text-foreground">Legal requirements:</span> to comply with laws,
              regulations, or legal processes.
            </li>
            <li>
              <span className="font-medium text-foreground">Business transfers:</span> in case of a merger,
              acquisition, or sale of assets.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">4. Data Security</h2>
          <p className="mt-2">
            We implement technical and organizational measures to protect your information. However, no
            method of transmission or storage is 100% secure.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">5. Your Rights</h2>
          <p className="mt-2">You may have the right to:</p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>Access and obtain a copy of your personal information</li>
            <li>Correct inaccurate or incomplete data</li>
            <li>Request deletion of your personal information and account</li>
            <li>Opt out of promotional communications</li>
          </ul>
          <p className="mt-2">To exercise these rights, contact us on our support number below.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">6. Retention of Information</h2>
          <p className="mt-2">
            We retain your personal and learning information for as long as your account is active, so
            your chat history and past exercises remain available to you, and as otherwise necessary to
            provide our services and comply with legal obligations. Billing and usage data may be retained
            for accounting and analytics purposes.
          </p>
        </section>

        {/* Adapted, not copied, from the source text's generic "not
            intended for under 13" clause -- SyllabusMate is a school
            tutoring platform whose actual student users include children
            under 13 (CBSE/WBBSE grades taught here start well below that
            age), so that clause would misstate who the product is for.
            Flagged directly to the user as a deliberate content change. */}
        <section>
          <h2 className="text-base font-semibold text-foreground">7. Children&apos;s Privacy</h2>
          <p className="mt-2">
            SyllabusMate is a tutoring platform designed for school students, including children under 13,
            used under the guidance of a parent, guardian, or school. We collect only the information
            needed to provide tutoring within that student&apos;s own board, grade, subject, and syllabus. A
            parent or guardian may contact us at any time to access, correct, or request deletion of their
            child&apos;s information.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">8. Changes to This Privacy Policy</h2>
          <p className="mt-2">
            We may update this Privacy Policy from time to time. Continued use of our services after
            changes are posted indicates acceptance of the updated Policy.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">9. Contact Us</h2>
          <p className="mt-2">
            For any questions regarding this Privacy Policy, contact:
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
