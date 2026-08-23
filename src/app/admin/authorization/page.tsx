import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AdminPageKey } from "@/lib/supabase/types";
import { PermissionToggle } from "./permission-toggle";

const PAGES: { key: AdminPageKey; label: string; description: string }[] = [
  { key: "users", label: "Users", description: "View all users, cancel subscriptions." },
  { key: "catalog", label: "Catalog", description: "Manage boards, grades, subjects, syllabus." },
  { key: "answer_bank", label: "Answer bank", description: "Review, approve, reject cached answers." },
  { key: "observability", label: "Observability", description: "View LLM cost/token usage and DB hit stats." },
  { key: "coupons", label: "Coupons", description: "Generate and revoke free-access coupon codes." },
  {
    key: "chapter_notes",
    label: "Chapter notes",
    description: "Author detailed chapter summaries for semantic (RAG) retrieval in chat.",
  },
  {
    key: "topic_summaries",
    label: "Topic summaries",
    description: "Review, approve, reject LLM-generated topic summaries before they're reused.",
  },
  {
    key: "broadcasts",
    label: "Broadcasts",
    description: "Send announcements, promotions, feedback requests, tests, and exams to students.",
  },
  {
    key: "feedback",
    label: "Feedback",
    description: "Review student 👍/👎 on chat replies, topic summaries, and exercises.",
  },
];

export default async function AuthorizationPage() {
  await requireSuperAdmin();
  const admin = createAdminClient();

  const [{ data: authUsers }, { data: profiles }, { data: permissions }] = await Promise.all([
    admin.auth.admin.listUsers({ perPage: 1000 }),
    admin.from("profiles").select("*").in("role", ["admin", "superadmin"]),
    admin.from("admin_page_permissions").select("*"),
  ]);

  const userById = new Map((authUsers?.users ?? []).map((u) => [u.id, u]));
  const permsByUser = new Map<string, Set<AdminPageKey>>();
  for (const p of permissions ?? []) {
    const set = permsByUser.get(p.user_id) ?? new Set<AdminPageKey>();
    set.add(p.page);
    permsByUser.set(p.user_id, set);
  }

  const staff = (profiles ?? [])
    .map((profile) => ({ profile, email: userById.get(profile.id)?.email ?? "(no email)" }))
    .sort((a, b) => {
      if (a.profile.role !== b.profile.role) return a.profile.role === "superadmin" ? -1 : 1;
      return a.email.localeCompare(b.email);
    });

  return (
    <div>
      <h1 className="text-xl font-semibold">Authorization</h1>
      <p className="mt-1 max-w-2xl text-sm text-foreground/60">
        Control which admin pages each admin can access. Superadmins always have full access to
        every page and can&apos;t be restricted here — only a superadmin can grant or revoke another
        admin&apos;s page permissions, and role changes themselves still happen from{" "}
        <Link href="/admin" className="text-brand hover:underline">
          Users
        </Link>
        .
      </p>

      <div className="mt-6 overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full min-w-[700px] text-left text-sm">
          <thead className="border-b border-border text-xs uppercase text-foreground/50">
            <tr>
              <th className="px-4 py-3">Admin</th>
              {PAGES.map((p) => (
                <th key={p.key} className="px-4 py-3 text-center" title={p.description}>
                  {p.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {staff.map(({ profile, email }) => {
              const isSuperadmin = profile.role === "superadmin";
              const granted = permsByUser.get(profile.id) ?? new Set<AdminPageKey>();
              return (
                <tr key={profile.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{profile.full_name ?? "—"}</div>
                    <div className="text-xs text-foreground/50">{email}</div>
                    {isSuperadmin && (
                      <span className="mt-1 inline-block rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">
                        superadmin — full access
                      </span>
                    )}
                  </td>
                  {PAGES.map((p) => (
                    <td key={p.key} className="px-4 py-3 text-center">
                      {isSuperadmin ? (
                        <input
                          type="checkbox"
                          checked
                          disabled
                          className="h-4 w-4 rounded border-border accent-brand opacity-50"
                          aria-label={`${p.label} (always granted for superadmins)`}
                        />
                      ) : (
                        <PermissionToggle userId={profile.id} page={p.key} granted={granted.has(p.key)} />
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
            {staff.length === 0 && (
              <tr>
                <td colSpan={PAGES.length + 1} className="px-4 py-8 text-center text-foreground/50">
                  No admins yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
