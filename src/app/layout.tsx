import type { Metadata } from "next";
import "./globals.css";
import { getCurrentUser } from "@/lib/auth";
import { SingleSessionGuard } from "@/components/single-session-guard";

export const metadata: Metadata = {
  title: "TutorOps — Your Board, Your Syllabus, Your Tutor",
  description:
    "A chatops tutoring platform that keeps every answer inside your board's syllabus, in the language you choose.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // getCurrentUser() never redirects on its own (unlike requireUser()), so
  // this is safe to call unconditionally on every page this root layout
  // wraps, including public ones (login, signup, forgot-password) where it
  // just resolves to null. Mounted here, once, rather than per-route-tree
  // (dashboard/admin/account/onboarding/subscribe each have their own,
  // separate layout or none at all) so every signed-in page gets the
  // instant-kick guard uniformly -- see that component's own comment on
  // what it actually does. current_session_id is still null for any
  // account that hasn't signed in since 0050_single_device_session.sql
  // shipped, so this also naturally does nothing for those until their
  // next real sign-in establishes one.
  const session = await getCurrentUser();

  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {session?.profile?.current_session_id && (
          <SingleSessionGuard userId={session.user.id} mySessionId={session.profile.current_session_id} />
        )}
        {children}
      </body>
    </html>
  );
}
