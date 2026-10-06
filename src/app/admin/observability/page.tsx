import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
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

// "Grounded" here means /v1/chat's chapter-notes RAG actually found and
// used something for this question -- reused covers cache/database/
// chapter_notes hits (previously-approved or curated content, no fresh LLM
// call at all), ungrounded is a plain LLM generation with nothing to ground
// it in. Answers directly to "where should ingestion effort go next": a
// subject with a high ungrounded share is one where students are mostly
// getting the model's own general knowledge instead of anything tied to
// this app's actual syllabus content.
type SubjectRollup = {
  name: string;
  total: number;
  reused: number;
  grounded: number;
  ungrounded: number;
  rejected: number;
};

export default async function ObservabilityPage() {
  await requireAdminPage("observability");
  const admin = createAdminClient();

  // JS-side aggregation (same pattern as /admin, which builds its
  // user/subscription maps in JS) -- fine at this scale; if the event
  // volume grows large enough for this to matter, move to a Postgres
  // aggregate view instead of paginating raw rows here.
  const [
    { data: authUsers },
    { data: profiles },
    { data: subjects },
    { data: llmEvents },
    { count: databaseHitCount },
    { count: cacheHitCount },
    { count: rejectedCount },
    { count: chapterNotesHitCount },
    { data: subjectEvents },
    { data: wallets },
  ] = await Promise.all([
    admin.auth.admin.listUsers({ perPage: 1000 }),
    admin.from("profiles").select("*"),
    admin.from("subjects").select("id, name"),
    admin
      .from("chat_events")
      .select("user_id, prompt_tokens, completion_tokens, total_tokens, cost_usd")
      .eq("source", "llm")
      .limit(10000),
    admin.from("chat_events").select("*", { count: "exact", head: true }).eq("source", "database"),
    admin.from("chat_events").select("*", { count: "exact", head: true }).eq("source", "cache"),
    admin.from("chat_events").select("*", { count: "exact", head: true }).eq("source", "rejected"),
    // Topic summaries served straight from admin-authored chapter notes --
    // see services/orchestrator/src/server.ts's /v1/topic-summary handler.
    // No LLM call and not really a "database hit" in the cache/answer-bank
    // sense either, so it gets its own count rather than being folded into
    // databaseHitCount.
    admin.from("chat_events").select("*", { count: "exact", head: true }).eq("source", "chapter_notes"),
    // Every event regardless of source, for the per-subject grounding
    // rollup below -- a separate, wider query from llmEvents above (that
    // one's scoped to source='llm' for the cost/token table; this one needs
    // every source to compute a reused/grounded/ungrounded/rejected split).
    admin.from("chat_events").select("subject_id, source, grounded").limit(20000),
    // For the "Wallet balances" section below -- every student's current
    // prepaid balance (see supabase/migrations/0055_student_wallets.sql),
    // the thing that actually decides whether the tutor will answer for
    // them now, replacing the old monthly-quota-vs-usage report.
    admin.from("student_wallets").select("user_id, balance_tokens, llm_provider"),
  ]);

  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));
  const userById = new Map((authUsers?.users ?? []).map((u) => [u.id, u]));
  const subjectNameById = new Map((subjects ?? []).map((s) => [s.id, s.name]));

  const rollupBySubject = new Map<string, SubjectRollup>();
  for (const ev of subjectEvents ?? []) {
    const bucket = rollupBySubject.get(ev.subject_id) ?? {
      name: subjectNameById.get(ev.subject_id) ?? "—",
      total: 0,
      reused: 0,
      grounded: 0,
      ungrounded: 0,
      rejected: 0,
    };
    bucket.total += 1;
    if (ev.source === "cache" || ev.source === "database" || ev.source === "chapter_notes") {
      bucket.reused += 1;
    } else if (ev.source === "llm") {
      if (ev.grounded) bucket.grounded += 1;
      else bucket.ungrounded += 1;
    } else if (ev.source === "rejected") {
      bucket.rejected += 1;
    }
    rollupBySubject.set(ev.subject_id, bucket);
  }
  const subjectRollupRows = Array.from(rollupBySubject.values()).sort((a, b) => b.total - a.total);

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

  // Every student (role='user') with a wallet row -- staff is excluded
  // entirely (unmetered, no wallet at all, see /api/chat/route.ts).
  // Exhausted/low balances float to the top, since those are what an
  // admin actually needs to act on; everyone else sorts by balance
  // ascending behind them.
  const walletRows = (wallets ?? [])
    .filter((w) => (profileById.get(w.user_id)?.role ?? "user") === "user")
    .map((w) => {
      const profile = profileById.get(w.user_id);
      const user = userById.get(w.user_id);
      return {
        userId: w.user_id,
        name: profile?.full_name ?? "—",
        email: user?.email ?? "(no email)",
        balance: w.balance_tokens,
        provider: w.llm_provider,
        exhausted: w.balance_tokens <= 0,
      };
    })
    .sort((a, b) => a.balance - b.balance);

  const exhaustedCount = walletRows.filter((r) => r.exhausted).length;

  return (
    <div>
      <h1 className="text-xl font-semibold">Observability</h1>
      <p className="mt-1 text-sm text-foreground/75">
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
          sub={`${(chapterNotesHitCount ?? 0).toLocaleString()} more from chapter notes`}
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
            <thead className="border-b border-border text-xs uppercase text-foreground/68">
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
                    <div className="text-xs text-foreground/68">{row.email}</div>
                  </td>
                  <td className="px-4 py-3">{row.role}</td>
                  <td className="px-4 py-3">{row.queries}</td>
                  <td className="px-4 py-3">{row.promptTokens.toLocaleString()}</td>
                  <td className="px-4 py-3">{row.completionTokens.toLocaleString()}</td>
                  <td className="px-4 py-3">{row.totalTokens.toLocaleString()}</td>
                  <td className="px-4 py-3">
                    {USD_FORMATTER.format(row.costUsd)}
                    {row.unpriced > 0 && (
                      <span className="ml-1 text-xs text-foreground/65">(+{row.unpriced} unpriced)</span>
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
                  <td colSpan={8} className="px-4 py-8 text-center text-foreground/68">
                    No LLM usage recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8 rounded-xl border border-border bg-surface">
        <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">Wallet balances</h2>
        <p className="px-4 pt-3 text-xs text-foreground/68">
          Every student&apos;s current prepaid token balance (see supabase/migrations/
          0055_student_wallets.sql) -- the thing that actually gates every LLM-spending request now. Open
          a student&apos;s page to grant tokens.
          {exhaustedCount > 0 && (
            <span className="ml-1 font-medium text-red-600">{exhaustedCount} out of tokens.</span>
          )}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-left text-sm">
            <thead className="border-b border-border text-xs uppercase text-foreground/68">
              <tr>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Balance</th>
                <th className="px-4 py-3">Model</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {walletRows.map((row) => (
                <tr key={row.userId} className="border-b border-border last:border-0 hover:bg-brand/5">
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.name}</div>
                    <div className="text-xs text-foreground/68">{row.email}</div>
                  </td>
                  <td className="px-4 py-3">{row.balance.toLocaleString()}</td>
                  <td className="px-4 py-3 capitalize">{row.provider}</td>
                  <td className="px-4 py-3">
                    {row.exhausted ? (
                      <span className="font-medium text-red-600">Out of tokens</span>
                    ) : (
                      <span className="text-foreground/75">OK</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/admin/users/${row.userId}`} className="text-brand hover:underline">
                      Grant tokens
                    </Link>
                  </td>
                </tr>
              ))}
              {walletRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-foreground/68">
                    No students yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8 rounded-xl border border-border bg-surface">
        <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">Grounding by subject</h2>
        <p className="px-4 pt-3 text-xs text-foreground/68">
          Where students are actually getting an answer tied to this app&apos;s own ingested chapter
          content (&ldquo;Grounded&rdquo;) versus the model&apos;s own general knowledge
          (&ldquo;Ungrounded&rdquo;) -- the signal for which subjects need more chapter notes
          ingested. &ldquo;Reused&rdquo; is a cache/database/chapter-notes hit: no fresh LLM call at
          all, already trusted content being served again.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-left text-sm">
            <thead className="border-b border-border text-xs uppercase text-foreground/68">
              <tr>
                <th className="px-4 py-3">Subject</th>
                <th className="px-4 py-3">Questions</th>
                <th className="px-4 py-3">Reused</th>
                <th className="px-4 py-3">Grounded (RAG)</th>
                <th className="px-4 py-3">Ungrounded (LLM only)</th>
                <th className="px-4 py-3">Off-syllabus</th>
              </tr>
            </thead>
            <tbody>
              {subjectRollupRows.map((row) => {
                const pct = (n: number) => (row.total > 0 ? `${Math.round((n / row.total) * 100)}%` : "—");
                return (
                  <tr key={row.name} className="border-b border-border last:border-0 hover:bg-brand/5">
                    <td className="px-4 py-3 font-medium">{row.name}</td>
                    <td className="px-4 py-3">{row.total.toLocaleString()}</td>
                    <td className="px-4 py-3">
                      {row.reused.toLocaleString()} <span className="text-xs text-foreground/65">({pct(row.reused)})</span>
                    </td>
                    <td className="px-4 py-3">
                      {row.grounded.toLocaleString()} <span className="text-xs text-foreground/65">({pct(row.grounded)})</span>
                    </td>
                    <td className="px-4 py-3">
                      {row.ungrounded.toLocaleString()}{" "}
                      <span className="text-xs text-foreground/65">({pct(row.ungrounded)})</span>
                    </td>
                    <td className="px-4 py-3">{row.rejected.toLocaleString()}</td>
                  </tr>
                );
              })}
              {subjectRollupRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-foreground/68">
                    No questions recorded yet.
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
      <p className="text-xs uppercase tracking-wide text-foreground/68">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {sub && <p className="mt-1 text-xs text-foreground/65">{sub}</p>}
    </div>
  );
}
