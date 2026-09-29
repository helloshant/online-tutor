import Link from "next/link";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reason?: string }>;
}) {
  const { next, reason } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-sm">
        <Link href="/" className="text-sm font-semibold text-brand">
          SyllabusMate
        </Link>
        <h1 className="mt-4 text-2xl font-semibold">Welcome back</h1>
        <p className="mt-1 text-sm text-foreground/75">
          Log in to continue your Q&amp;A with your subjects.
        </p>

        {/* Only one device can be signed into an account at a time (see
            src/lib/singleSession.ts) -- this is where that lands someone
            signed out of an older session, whether caught instantly (an
            open tab kicked live) or on their next action (a tab that was
            closed/idle and only found out on reopening). Not an error --
            plain, non-alarming framing, since it's expected behavior, not
            something that went wrong. */}
        {reason === "signed_in_elsewhere" && (
          <p className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
            You&apos;ve been signed out because this account was used to sign in on another device. Only one device
            can be signed in at a time.
          </p>
        )}

        <LoginForm next={next} />

        <p className="mt-6 text-center text-sm text-foreground/75">
          New here?{" "}
          <Link href="/signup" className="font-medium text-brand hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
