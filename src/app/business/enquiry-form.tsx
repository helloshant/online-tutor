"use client";

import Link from "next/link";
import { useActionState } from "react";
import { submitBusinessEnquiry, type BusinessEnquiryState } from "./actions";

const initialState: BusinessEnquiryState = {};

export function EnquiryForm() {
  const [state, formAction, pending] = useActionState(submitBusinessEnquiry, initialState);

  if (state?.success) {
    return (
      <div className="mt-6 space-y-4">
        <p className="rounded-xl border border-border bg-surface p-4 text-sm text-foreground/82">
          Thanks — we&apos;ve got your enquiry and someone from our team will get back to you shortly.
        </p>
        <Link href="/" className="inline-block text-sm font-medium text-brand hover:underline">
          ← Back to home
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="mt-6 space-y-4">
      <div>
        <label htmlFor="organizationName" className="block text-sm font-medium">
          Organisation name
        </label>
        <input
          id="organizationName"
          name="organizationName"
          type="text"
          required
          autoComplete="organization"
          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
        />
      </div>
      <div>
        <label htmlFor="contactName" className="block text-sm font-medium">
          Your name
        </label>
        <input
          id="contactName"
          name="contactName"
          type="text"
          required
          autoComplete="name"
          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
        />
      </div>
      <div>
        <label htmlFor="email" className="block text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
        />
      </div>
      <div>
        <label htmlFor="phone" className="block text-sm font-medium">
          Phone <span className="font-normal text-foreground/65">(optional)</span>
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          autoComplete="tel"
          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
        />
      </div>
      <div>
        <label htmlFor="approxStudents" className="block text-sm font-medium">
          Approx. number of students <span className="font-normal text-foreground/65">(optional)</span>
        </label>
        <input
          id="approxStudents"
          name="approxStudents"
          type="text"
          placeholder="e.g. 200-300"
          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
        />
      </div>
      <div>
        <label htmlFor="message" className="block text-sm font-medium">
          Tell us about your requirement <span className="font-normal text-foreground/65">(optional)</span>
        </label>
        <textarea
          id="message"
          name="message"
          rows={4}
          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
        />
      </div>

      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
      >
        {pending ? "Submitting…" : "Submit Enquiry"}
      </button>
    </form>
  );
}
