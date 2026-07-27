import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { NewPasswordForm } from "@/components/new-password-form";
import { resetPassword } from "./actions";

export default async function ResetPasswordPage() {
  const session = await getCurrentUser();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-sm">
        <Link href="/" className="text-sm font-semibold text-brand">
          TutorOps
        </Link>
        <h1 className="mt-4 text-2xl font-semibold">Set a new password</h1>

        {session ? (
          <>
            <p className="mt-1 text-sm text-foreground/60">Choose a new password for your account.</p>
            <NewPasswordForm action={resetPassword} />
          </>
        ) : (
          <p className="mt-4 text-sm text-foreground/60">
            This reset link is invalid or has expired.{" "}
            <Link href="/forgot-password" className="font-medium text-brand hover:underline">
              Request a new one
            </Link>
            .
          </p>
        )}
      </div>
    </div>
  );
}
