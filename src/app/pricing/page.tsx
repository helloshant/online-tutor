import Link from "next/link";

// Public marketing page, same self-contained header/footer shape as the
// home page (src/app/page.tsx) -- this app has no shared site chrome
// component, every top-level public page builds its own. Describes the
// prepaid token wallet that actually gates usage now (see
// supabase/migrations/0055_student_wallets.sql and src/lib/walletTopup.ts
// for the real ₹500/200,000-token numbers this page quotes), not the old
// per-subject subscription fee -- board/grade/subject setup is free and
// instant (src/app/onboarding/actions.ts no longer charges anything).
export const metadata = {
  title: "Pricing — SyllabusMate",
  description:
    "Free to set up. Pay only for what you use with a prepaid token wallet -- ₹500 for 200,000 tokens.",
};

const FAQS = [
  {
    q: "What are tokens?",
    a: "Tokens are the currency your wallet holds -- every question you ask or practice set you generate spends some, based on how much work it takes to answer. A ₹500 recharge adds 200,000 of them to your balance.",
  },
  {
    q: "Is there a monthly fee?",
    a: "No. There's no subscription and nothing auto-renews. You top up your wallet when you want to, and it's only ever spent when you actually ask a question.",
  },
  {
    q: "What happens when my balance runs out?",
    a: "The tutor pauses until you recharge -- nothing is lost, and recharging brings it straight back.",
  },
  {
    q: "Do unused tokens expire?",
    a: "No. Whatever is left in your wallet stays there until you use it.",
  },
  {
    q: "Can I add or change subjects later?",
    a: "Yes, anytime from your dashboard, at no extra cost -- setup itself is always free.",
  },
  {
    q: "Do I have to pay extra to use Claude?",
    a: "No separate fee -- switching to Claude from your account page just means the same wallet balance is spent a bit faster on each question, since it costs more to run. You can switch back to Gemini anytime, just as freely.",
  },
];

export default function PricingPage() {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <header className="flex items-center justify-between px-6 py-5 sm:px-10">
        <Link href="/" className="text-lg font-semibold text-brand">
          SyllabusMate
        </Link>
        <nav className="flex items-center gap-4 text-sm font-medium">
          <Link href="/login" className="text-foreground/82 hover:text-foreground">
            Log in
          </Link>
          <Link
            href="/signup"
            className="rounded-lg bg-brand px-4 py-2 text-white transition hover:bg-brand-dark"
          >
            Get started
          </Link>
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center px-6 py-16 text-center sm:py-20">
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
          Free to set up. Pay only for what you use.
        </h1>
        <p className="mt-5 max-w-xl text-lg text-foreground/75">
          Choose your board, grade, and subjects at no cost. A prepaid token wallet covers every
          question you ask -- top up whenever you like, in one simple block.
        </p>

        <div className="mt-12 grid w-full gap-6 sm:grid-cols-2">
          <div className="rounded-2xl border border-border bg-surface p-6 text-left">
            <p className="text-sm font-semibold text-brand">Setup</p>
            <p className="mt-2 text-3xl font-semibold">Free</p>
            <p className="mt-1 text-sm text-foreground/68">forever, no card required</p>
            <ul className="mt-5 space-y-2.5 text-sm text-foreground/82">
              <li>Pick your board, grade, medium, and subjects instantly</li>
              <li>Change or add subjects anytime at no extra cost</li>
              <li>Nothing to pay until you actually start asking questions</li>
            </ul>
          </div>

          <div className="rounded-2xl border border-brand bg-surface p-6 text-left shadow-sm">
            <p className="text-sm font-semibold text-brand">Token wallet</p>
            <p className="mt-2 text-3xl font-semibold">
              ₹500 <span className="text-base font-normal text-foreground/68">= 200,000 tokens</span>
            </p>
            <p className="mt-1 text-sm text-foreground/68">prepaid, recharge anytime from your account</p>
            <ul className="mt-5 space-y-2.5 text-sm text-foreground/82">
              <li>Tokens are spent only when you ask a question or request practice</li>
              <li>No monthly fee, no auto-renewal -- recharge only when you need to</li>
              <li>Unused tokens never expire</li>
            </ul>
          </div>
        </div>

        <div className="mt-8 w-full rounded-2xl border border-border bg-surface p-6 text-left">
          <p className="text-sm font-semibold">Choice of AI model</p>
          <p className="mt-2 text-sm text-foreground/75">
            Gemini is the default, included in your wallet balance at the standard rate. Prefer
            Anthropic&apos;s Claude? Switch anytime from your account page -- there&apos;s no separate
            charge, it simply spends your same wallet balance a little faster since it costs more to
            run. Switch back to Gemini just as freely, whenever you like.
          </p>
        </div>

        <div className="mt-8 flex gap-3">
          <Link
            href="/signup"
            className="rounded-lg bg-brand px-6 py-3 text-sm font-semibold text-white transition hover:bg-brand-dark"
          >
            Get started free
          </Link>
          <Link
            href="/login"
            className="rounded-lg border border-border px-6 py-3 text-sm font-semibold transition hover:bg-brand/5"
          >
            I already have an account
          </Link>
        </div>

        <div className="mt-20 w-full text-left">
          <h2 className="text-xl font-semibold">Frequently asked</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {FAQS.map((item) => (
              <div key={item.q} className="rounded-xl border border-border bg-surface p-5">
                <h3 className="font-semibold">{item.q}</h3>
                <p className="mt-1.5 text-sm text-foreground/75">{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </main>

      <footer className="border-t border-border px-6 py-6 text-center text-xs text-foreground/65">
        <p>SyllabusMate — built for students, by subject, by syllabus.</p>
        <p className="mt-2 flex items-center justify-center gap-3">
          <Link href="/terms" className="hover:underline">
            Terms &amp; Conditions
          </Link>
          <span aria-hidden="true">·</span>
          <Link href="/privacy" className="hover:underline">
            Privacy Policy
          </Link>
          <span aria-hidden="true">·</span>
          <Link href="/refund-policy" className="hover:underline">
            Refund &amp; Cancellation
          </Link>
          <span aria-hidden="true">·</span>
          <Link href="/contact" className="hover:underline">
            Contact Us
          </Link>
          <span aria-hidden="true">·</span>
          <Link href="/business" className="hover:underline">
            Business Enquiry
          </Link>
        </p>
      </footer>
    </div>
  );
}
