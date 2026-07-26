import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export default async function AdminUsersPage() {
  await requireAdminPage("users");
  const admin = createAdminClient();

  const [{ data: authUsers }, { data: profiles }, { data: subscriptions }] = await Promise.all([
    admin.auth.admin.listUsers({ perPage: 1000 }),
    admin.from("profiles").select("*"),
    admin
      .from("subscriptions")
      .select("*, boards(name), grades(name), subscription_subjects(subjects(name))")
      .order("created_at", { ascending: false }),
  ]);

  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));
  const latestSubscriptionByUser = new Map<string, NonNullable<typeof subscriptions>[number]>();
  for (const sub of subscriptions ?? []) {
    if (!latestSubscriptionByUser.has(sub.user_id)) {
      latestSubscriptionByUser.set(sub.user_id, sub);
    }
  }

  const rows = (authUsers?.users ?? []).map((u) => {
    const profile = profileById.get(u.id);
    const sub = latestSubscriptionByUser.get(u.id);
    const subjects = ((sub as unknown as { subscription_subjects?: { subjects: { name: string } | null }[] })
      ?.subscription_subjects ?? [])
      .map((s) => s.subjects?.name)
      .filter(Boolean);

    return {
      id: u.id,
      email: u.email ?? "(no email)",
      fullName: profile?.full_name ?? "—",
      role: profile?.role ?? "user",
      board: (sub as unknown as { boards?: { name: string } | null })?.boards?.name,
      grade: (sub as unknown as { grades?: { name: string } | null })?.grades?.name,
      medium: sub?.medium,
      status: sub?.status,
      subjects,
    };
  });

  return (
    <div>
      <h1 className="text-xl font-semibold">Users</h1>
      <p className="mt-1 text-sm text-foreground/60">
        Every signed-up user, their selections, and subscription status.
      </p>

      <div className="mt-6 overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="border-b border-border text-xs uppercase text-foreground/50">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Board</th>
              <th className="px-4 py-3">Grade</th>
              <th className="px-4 py-3">Medium</th>
              <th className="px-4 py-3">Subjects</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-border last:border-0 hover:bg-brand/5">
                <td className="px-4 py-3">
                  <Link href={`/admin/users/${row.id}`} className="font-medium text-brand hover:underline">
                    {row.fullName}
                  </Link>
                </td>
                <td className="px-4 py-3 text-foreground/70">{row.email}</td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      row.role === "superadmin"
                        ? "bg-purple-600 text-white"
                        : row.role === "admin"
                          ? "bg-brand text-white"
                          : "bg-foreground/10 text-foreground/70"
                    }`}
                  >
                    {row.role}
                  </span>
                </td>
                <td className="px-4 py-3">{row.board ?? "—"}</td>
                <td className="px-4 py-3">{row.grade ?? "—"}</td>
                <td className="px-4 py-3">{row.medium ?? "—"}</td>
                <td className="px-4 py-3">{row.subjects.length ? row.subjects.join(", ") : "—"}</td>
                <td className="px-4 py-3">
                  {row.role === "admin" || row.role === "superadmin" ? (
                    <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">
                      Staff access
                    </span>
                  ) : row.status ? (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        row.status === "active"
                          ? "bg-green-100 text-green-700"
                          : row.status === "pending_payment"
                            ? "bg-yellow-100 text-yellow-700"
                            : "bg-foreground/10 text-foreground/60"
                      }`}
                    >
                      {row.status}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-foreground/50">
                  No users yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
