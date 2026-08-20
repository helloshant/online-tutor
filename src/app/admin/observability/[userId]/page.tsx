import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ChatEventSource } from "@/lib/supabase/types";

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const SOURCE_STYLES: Record<ChatEventSource, string> = {
  llm: "bg-purple-100 text-purple-700",
  cache: "bg-green-100 text-green-700",
  database: "bg-blue-100 text-blue-700",
  rejected: "bg-red-100 text-red-700",
  chapter_notes: "bg-amber-100 text-amber-700",
};

export default async function UserObservabilityPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  await requireAdminPage("observability");
  const { userId } = await params;
  const admin = createAdminClient();

  const [{ data: authUser }, { data: profile }, { data: events }] = await Promise.all([
    admin.auth.admin.getUserById(userId),
    admin.from("profiles").select("*").eq("id", userId).maybeSingle(),
    admin
      .from("chat_events")
      .select("*, subjects(name)")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(300),
  ]);

  return (
    <div>
      <Link href="/admin/observability" className="text-sm text-brand hover:underline">
        &larr; Back to observability
      </Link>
      <h1 className="mt-2 text-xl font-semibold">{profile?.full_name ?? "—"}</h1>
      <p className="text-sm text-foreground/60">{authUser?.user?.email ?? "(no email)"}</p>
      <p className="mt-1 text-xs text-foreground/40">Most recent 300 queries.</p>

      <div className="mt-6 overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="border-b border-border text-xs uppercase text-foreground/50">
            <tr>
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Subject</th>
              <th className="px-4 py-3">Question</th>
              <th className="px-4 py-3">Model</th>
              <th className="px-4 py-3">Tokens</th>
              <th className="px-4 py-3">Cost</th>
              <th className="px-4 py-3">Latency</th>
            </tr>
          </thead>
          <tbody>
            {(events ?? []).map((ev) => {
              const subject = (ev as unknown as { subjects: { name: string } | null }).subjects;
              return (
                <tr key={ev.id} className="border-b border-border align-top last:border-0">
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-foreground/60">
                    {new Date(ev.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${SOURCE_STYLES[ev.source]}`}
                    >
                      {ev.source}
                    </span>
                  </td>
                  <td className="px-4 py-3">{subject?.name ?? "—"}</td>
                  <td className="max-w-xs px-4 py-3">{ev.question}</td>
                  <td className="px-4 py-3 text-xs">{ev.model ?? "—"}</td>
                  <td className="px-4 py-3">
                    {ev.total_tokens != null ? ev.total_tokens.toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-3">
                    {ev.cost_usd != null ? USD_FORMATTER.format(ev.cost_usd) : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-foreground/50">
                    {ev.latency_ms != null ? `${ev.latency_ms} ms` : "—"}
                  </td>
                </tr>
              );
            })}
            {(events ?? []).length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-foreground/50">
                  No queries recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
