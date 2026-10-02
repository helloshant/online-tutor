import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { markContacted, reopenEnquiry } from "./actions";

const DATE_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
});

// Same status-tab/list-card shape as /admin/callback-requests -- the
// closest existing analog (a queue of items a visitor submitted, that an
// admin works through and closes). This one is organisations asking about
// bulk/partnership plans, not individual students, so the card surfaces
// organization_name/contact_name/email instead of just a name/phone.
export default async function BusinessEnquiriesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireAdminPage("business_enquiries");
  const { status: statusParam } = await searchParams;
  const status = statusParam === "contacted" ? "contacted" : "new";

  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("business_enquiries")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <div>
      <h1 className="text-lg font-semibold">Business enquiries</h1>
      <p className="mt-1 text-sm text-foreground/75">
        Submitted from the public Business Enquiry page -- schools, coaching institutes, and other
        organisations asking about bulk or partnership plans.
      </p>

      <div className="mt-4 flex gap-4 text-sm">
        <Link
          href="/admin/business-enquiries"
          className={`rounded-full px-3 py-1 font-medium ${status === "new" ? "bg-brand text-white" : "border border-border text-foreground/75 hover:text-foreground"}`}
        >
          New
        </Link>
        <Link
          href="/admin/business-enquiries?status=contacted"
          className={`rounded-full px-3 py-1 font-medium ${status === "contacted" ? "bg-brand text-white" : "border border-border text-foreground/75 hover:text-foreground"}`}
        >
          Contacted
        </Link>
      </div>

      <div className="mt-4 space-y-3">
        {(!rows || rows.length === 0) && (
          <p className="text-sm text-foreground/68">
            {status === "new" ? "No new business enquiries." : "No contacted enquiries yet."}
          </p>
        )}
        {(rows ?? []).map((row) => (
          <div key={row.id} className="rounded-xl border border-border bg-surface p-4 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-medium text-foreground">{row.organization_name}</p>
                <p className="mt-0.5 text-foreground/82">
                  {row.contact_name} ·{" "}
                  <a href={`mailto:${row.email}`} className="text-brand hover:underline">
                    {row.email}
                  </a>
                  {row.phone && (
                    <>
                      {" "}
                      ·{" "}
                      <a href={`tel:${row.phone}`} className="text-brand hover:underline">
                        {row.phone}
                      </a>
                    </>
                  )}
                </p>
                {row.approx_students && (
                  <p className="mt-1 text-xs text-foreground/68">Approx. students: {row.approx_students}</p>
                )}
                <p className="mt-1 text-xs text-foreground/68">{DATE_FORMATTER.format(new Date(row.created_at))}</p>
              </div>
              <form action={status === "new" ? markContacted.bind(null, row.id) : reopenEnquiry.bind(null, row.id)}>
                <button type="submit" className="text-xs font-medium text-brand hover:underline">
                  {status === "new" ? "Mark contacted" : "Reopen"}
                </button>
              </form>
            </div>
            {row.message && (
              <p className="mt-2 whitespace-pre-wrap rounded-lg bg-background p-3 text-foreground/88">{row.message}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
