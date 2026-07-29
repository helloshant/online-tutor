import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TutorOps — Your Board, Your Syllabus, Your Tutor",
  description:
    "A chatops tutoring platform that keeps every answer inside your board's syllabus, in the language you choose.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
