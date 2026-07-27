import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { NewPasswordForm } from "@/components/new-password-form";
import { resetPassword } from "../reset-password/actions";

// Reached only via the password-expiry gate (requireFreshPassword() in
// lib/auth.ts) -- uses requireUser() directly, not requireFreshPassword(),
// since gating this page on password freshness would redirect it to itself.
export default async function ChangePasswordPage() {
  await requireUser();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-sm">
        <Link href="/" className="text-sm font-semibold text-brand">
          TutorOps
        </Link>
        <h1 className="mt-4 text-2xl font-semibold">Time to update your password</h1>
        <p className="mt-1 text-sm text-foreground/60">
          For your account&apos;s security, passwords need to be refreshed periodically. Set a new
          one to continue.
        </p>

        <NewPasswordForm action={resetPassword} />
      </div>
    </div>
  );
}
