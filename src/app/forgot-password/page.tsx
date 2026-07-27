import Link from "next/link";
import { ForgotPasswordForm } from "./forgot-password-form";

export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-sm">
        <Link href="/" className="text-sm font-semibold text-brand">
          TutorOps
        </Link>
        <h1 className="mt-4 text-2xl font-semibold">Reset your password</h1>
        <p className="mt-1 text-sm text-foreground/60">
          Enter the email on your account and we&apos;ll send you a link to set a new password.
        </p>

        <ForgotPasswordForm />

        <p className="mt-6 text-center text-sm text-foreground/60">
          <Link href="/login" className="font-medium text-brand hover:underline">
            Back to log in
          </Link>
        </p>
      </div>
    </div>
  );
}
