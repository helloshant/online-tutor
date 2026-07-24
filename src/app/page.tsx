import Link from "next/link";

const FEATURES = [
  {
    title: "Board & grade aware",
    body: "CBSE, ICSE, West Bengal Board and more — each with its own grade-specific syllabus.",
  },
  {
    title: "Subject-scoped Q&A",
    body: "Pick a subject on the left, and every answer stays inside that subject and your syllabus.",
  },
  {
    title: "Answers in your language",
    body: "English, Hindi, or Bengali — chosen once at subscription, honoured in every reply.",
  },
  {
    title: "Simple, transparent pricing",
    body: "Pay per subject with Razorpay. Add or drop subjects whenever your plan changes.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <header className="flex items-center justify-between px-6 py-5 sm:px-10">
        <span className="text-lg font-semibold text-brand">TutorOps</span>
        <nav className="flex items-center gap-4 text-sm font-medium">
          <Link href="/login" className="text-foreground/70 hover:text-foreground">
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

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center px-6 py-16 text-center sm:py-24">
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
          A tutor that knows exactly what you&apos;re supposed to be studying.
        </h1>
        <p className="mt-5 max-w-xl text-lg text-foreground/60">
          Pick your board, grade, subjects, and language. TutorOps keeps every answer inside your
          syllabus — nothing more, nothing off-topic.
        </p>
        <div className="mt-8 flex gap-3">
          <Link
            href="/signup"
            className="rounded-lg bg-brand px-6 py-3 text-sm font-semibold text-white transition hover:bg-brand-dark"
          >
            Start learning
          </Link>
          <Link
            href="/login"
            className="rounded-lg border border-border px-6 py-3 text-sm font-semibold transition hover:bg-brand/5"
          >
            I already have an account
          </Link>
        </div>

        <div className="mt-20 grid w-full grid-cols-1 gap-4 text-left sm:grid-cols-2">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border border-border bg-surface p-5">
              <h3 className="font-semibold">{f.title}</h3>
              <p className="mt-1 text-sm text-foreground/60">{f.body}</p>
            </div>
          ))}
        </div>
      </main>

      <footer className="border-t border-border px-6 py-6 text-center text-xs text-foreground/40">
        TutorOps — built for students, by subject, by syllabus.
      </footer>
    </div>
  );
}
