import Link from "next/link";
import { SignupForm } from "./signup-form";

export default function SignupPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-sm">
        <Link href="/" className="text-sm font-semibold text-brand">
          TutorOps
        </Link>
        <h1 className="mt-4 text-2xl font-semibold">Create your account</h1>
        <p className="mt-1 text-sm text-foreground/60">
          Next you&apos;ll pick your board, grade, subjects, and language.
        </p>

        <SignupForm />

        <p className="mt-6 text-center text-sm text-foreground/60">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-brand hover:underline">
            Log in
          </Link>
        </p>
      </div>
    </div>
  );
}
