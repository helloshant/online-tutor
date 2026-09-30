import Link from "next/link";
import { CallbackForm } from "./callback-form";

// Static shell (this component itself needs no data or auth) around the
// one interactive piece, CallbackForm -- same "server page, client form"
// split as /signup. The "24/7 · Toll-free" caption on the reference
// design this was modeled on was deliberately dropped: the number given,
// +91-9593930068, is an ordinary 10-digit mobile number, not a toll-free
// (1800-series) one, so claiming "toll-free" would be actively false, and
// nothing in this app establishes round-the-clock support hours either.
export const metadata = {
  title: "Contact Us — SyllabusMate",
};

export default function ContactPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-sm">
        <Link href="/" className="text-sm font-semibold text-brand">
          SyllabusMate
        </Link>

        <div className="mt-6 flex flex-col items-center text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-50">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-7 w-7 text-green-600"
              aria-hidden="true"
            >
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.36 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.34 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
          </div>

          <h1 className="mt-4 text-xl font-semibold">Phone Support</h1>
          <p className="mt-2 text-sm text-foreground/75">
            Speak directly with our team for questions about your subscription, billing, or anything
            else.
          </p>

          <a href="tel:+919593930068" className="mt-4 text-lg font-semibold text-brand hover:underline">
            +91 95939 30068
          </a>
        </div>

        <div className="mt-8 border-t border-border pt-6">
          <h2 className="text-sm font-semibold">Prefer we call you?</h2>
          <CallbackForm />
        </div>

        <p className="mt-8 text-center text-xs text-foreground/65">
          Odantapuri Financial Services Pvt. Ltd.
          <br />
          Sapthagiri Sannidhi, Block C, Next Laxminaryana Temple Marathahalli, Bengaluru, 560037
        </p>
      </div>
    </div>
  );
}
