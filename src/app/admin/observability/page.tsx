import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

type UserUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  unpriced: number;
  queries: number;
};

export default async function ObservabilityPage() {
  const admin = createAdminClient();

  // JS-side aggregation (same pattern as /admin, which builds its
  // user/subscription maps in JS) -- fine at this scale; if the event
  // volume grows large enough for this to matter, move to a Postgres
  // aggregate view instead of paginating raw rows here.
  const [
    { data: authUsers },
    { data: profiles },
    { data: llmEvents },
    { count: databaseHitCount },
    { count: cacheHitCount },
    { count: rejectedCount },
  ] = await Promise.all([
    admin.auth.admin.listUsers({ perPage: 1000 }),
    admin.from("profiles").select("*"),
    admin
      .from("chat_events")
      .select("user_id, prompt_tokens, completion_tokens, total_tokens, cost_usd")
      .eq("source", "llm")
      .limit(10000),
    admin.from("chat_events").select("*", { count: "exact", head: true }).eq("source", "database"),
    admin.from("chat_events").select("*", { count: "exact", head: true }).eq("source", "cache"),
    admin.from("chat_events").select("*", { count: "exact", head: true }).eq("source", "rejected"),
  ]);

  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));
  const userById = new Map((authUsers?.users ?? []).map((u) => [u.id, u]));

  const usageByUser = new Map<string, UserUsage>();
  for (const ev of llmEvents ?? []) {
    const existing = usageByUser.get(ev.user_id) ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      unpriced: 0,
      queries: 0,
    };
    existing.promptTokens += ev.prompt_tokens ?? 0;
    existing.completionTokens += ev.completion_tokens ?? 0;
    existing.totalTokens += ev.total_tokens ?? 0;
    existing.queries += 1;
    if (ev.cost_usd != null) {
      existing.costUsd += ev.cost_usd;
    } else {
      existing.unpriced += 1;
    }
    usageByUser.set(ev.user_id, existing);
  }

  const totals = Array.from(usageByUser.values()).reduce(
    (acc, u) => ({
      totalTokens: acc.totalTokens + u.totalTokens,
      costUsd: acc.costUsd + u.costUsd,
      queries: acc.queries + u.queries,
      unpriced: acc.unpriced + u.unpriced,
    }),
    { totalTokens: 0, costUsd: 0, queries: 0, unpriced: 0 }
  );

  const rows = Array.from(usageByUser.entries())
    .map(([userId, usage]) => {
      const profile = profileById.get(userId);
      const user = userById.get(userId);
      return {
        userId,
        name: profile?.full_name ?? "—",
        email: user?.email ?? "(no email)",
        role: profile?.role ?? "user",
        ...usage,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);

  return (
    <div>
      <h1 className="text-xl font-semibold">Observability</h1>
      <p className="mt-1 text-sm text-foreground/60">
        Token usage, LLM cost, and pipeline hit counts across every question asked.
      </p>

      <section className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          label="Total LLM cost"
          value={USD_FORMATTER.format(totals.costUsd)}
          sub={totals.unpriced > 0 ? `${totals.unpriced} unpriced call(s)` : undefined}
        />
        <StatCard
          label="Total tokens"
          value={totals.totalTokens.toLocaleString()}
          sub={`${totals.queries} LLM calls`}
        />
        <StatCard
          label="Database hits"
          value={(databaseHitCount ?? 0).toLocaleString()}
          sub="served without an LLM call"
        />
        <StatCard
          label="Cache hits"
          value={(cacheHitCount ?? 0).toLocaleString()}
          sub={`${rejectedCount ?? 0} off-syllabus rejections`}
        />
      </section>

      <section className="mt-8 rounded-xl border border-border bg-surface">
        <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">LLM usage by user</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-border text-xs uppercase text-foreground/50">
              <tr>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Queries</th>
                <th className="px-4 py-3">Prompt tokens</th>
                <th className="px-4 py-3">Completion tokens</th>
                <th className="px-4 py-3">Total tokens</th>
                <th className="px-4 py-3">Cost</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.userId} className="border-b border-border last:border-0 hover:bg-brand/5">
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.name}</div>
                    <div className="text-xs text-foreground/50">{row.email}</div>
                  </td>
                  <td className="px-4 py-3">{row.role}</td>
                  <td className="px-4 py-3">{row.queries}</td>
                  <td className="px-4 py-3">{row.promptTokens.toLocaleString()}</td>
                  <td className="px-4 py-3">{row.completionTokens.toLocaleString()}</td>
                  <td className="px-4 py-3">{row.totalTokens.toLocaleString()}</td>
                  <td className="px-4 py-3">
                    {USD_FORMATTER.format(row.costUsd)}
                    {row.unpriced > 0 && (
                      <span className="ml-1 text-xs text-foreground/40">(+{row.unpriced} unpriced)</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/admin/observability/${row.userId}`} className="text-brand hover:underline">
                      View queries
                    </Link>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-foreground/50">
                    No LLM usage recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-xs uppercase tracking-wide text-foreground/50">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {sub && <p className="mt-1 text-xs text-foreground/40">{sub}</p>}
    </div>
  );
}
