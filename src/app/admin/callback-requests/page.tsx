import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { markContacted, reopenRequest } from "./actions";

const DATE_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
});

// Same status-tab/list-card shape as /admin/feedback -- the closest
// existing analog (a queue of items a visitor submitted, that an admin
// works through and closes). Unlike feedback, a submitter here is often
// not even signed in yet (see callback_requests' own migration comment),
// so there's no user_id to resolve a name/email from -- the name/phone
// they typed in IS the record.
export default async function CallbackRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireAdminPage("callback_requests");
  const { status: statusParam } = await searchParams;
  const status = statusParam === "contacted" ? "contacted" : "new";

  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("callback_requests")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <div>
      <h1 className="text-lg font-semibold">Callback requests</h1>
      <p className="mt-1 text-sm text-foreground/75">
        Submitted from the public Contact page -- a visitor leaves their name and phone number, often
        before they&apos;ve even signed up, for support to call them back.
      </p>

      <div className="mt-4 flex gap-4 text-sm">
        <Link
          href="/admin/callback-requests"
          className={`rounded-full px-3 py-1 font-medium ${status === "new" ? "bg-brand text-white" : "border border-border text-foreground/75 hover:text-foreground"}`}
        >
          New
        </Link>
        <Link
          href="/admin/callback-requests?status=contacted"
          className={`rounded-full px-3 py-1 font-medium ${status === "contacted" ? "bg-brand text-white" : "border border-border text-foreground/75 hover:text-foreground"}`}
        >
          Contacted
        </Link>
      </div>

      <div className="mt-4 space-y-3">
        {(!rows || rows.length === 0) && (
          <p className="text-sm text-foreground/68">
            {status === "new" ? "No new callback requests." : "No contacted requests yet."}
          </p>
        )}
        {(rows ?? []).map((row) => (
          <div key={row.id} className="rounded-xl border border-border bg-surface p-4 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-medium text-foreground">{row.name}</p>
                <p className="mt-0.5 text-foreground/82">
                  <a href={`tel:${row.phone}`} className="text-brand hover:underline">
                    {row.phone}
                  </a>
                </p>
                <p className="mt-1 text-xs text-foreground/68">{DATE_FORMATTER.format(new Date(row.created_at))}</p>
              </div>
              <form action={status === "new" ? markContacted.bind(null, row.id) : reopenRequest.bind(null, row.id)}>
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
