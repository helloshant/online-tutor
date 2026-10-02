import Link from "next/link";
import { EnquiryForm } from "./enquiry-form";

// Static shell around the one interactive piece, EnquiryForm -- same
// "server page, client form" split as /contact. This page is for an
// organisation (school, coaching institute) asking about bulk/partnership
// plans, which is why it leads with a short pitch instead of a support
// phone number: that's /contact's job, for an individual student/parent.
export const metadata = {
  title: "Business Enquiry — SyllabusMate",
};

const POINTS = [
  "Board & grade aware syllabus coverage across CBSE and West Bengal Board",
  "Answers and practice stay scoped to exactly what your students are examined on",
  "Available in English, Sanskrit, and Bengali",
];

export default function BusinessPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="grid w-full max-w-3xl overflow-hidden rounded-2xl border border-border bg-surface shadow-sm sm:grid-cols-2">
        <div className="flex flex-col justify-between bg-background p-8">
          <div>
            <Link href="/" className="text-sm font-semibold text-brand">
              SyllabusMate
            </Link>
            <h1 className="mt-6 text-xl font-semibold">Bring SyllabusMate to your students</h1>
            <p className="mt-2 text-sm text-foreground/75">
              For schools, coaching institutes, and other organisations looking to offer syllabus-scoped
              AI tutoring at scale.
            </p>
            <ul className="mt-6 space-y-3">
              {POINTS.map((point) => (
                <li key={point} className="flex gap-2.5 text-sm text-foreground/82">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </div>

          <p className="mt-8 text-xs text-foreground/65">
            Odantapuri Financial Services Pvt. Ltd.
            <br />
            Sapthagiri Sannidhi, Block C, Next Laxminaryana Temple Marathahalli, Bengaluru, 560037
          </p>
        </div>

        <div className="p-8">
          <h2 className="text-sm font-semibold">Tell us about your organisation</h2>
          <EnquiryForm />
        </div>
      </div>
    </div>
  );
}
