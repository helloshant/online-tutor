import Link from "next/link";
import { isPasswordExpired, requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createUser } from "./actions";
import type { ProfileRole } from "@/lib/supabase/types";

const ROLES: ProfileRole[] = ["user", "admin", "superadmin"];

export default async function AdminUsersPage() {
  const { profile: viewerProfile } = await requireAdminPage("users");
  const isSuperAdminViewer = viewerProfile?.role === "superadmin";
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
      // password_changed_at alone can't tell "no password" apart from "has
      // one but predates the tracking migration" -- both are null. Whether
      // an "email" identity is actually linked is the real signal (see the
      // same reasoning on the user detail page).
      passwordStatus: !u.identities?.some((i) => i.provider === "email")
        ? ("google" as const)
        : isPasswordExpired(profile ?? null)
          ? ("expired" as const)
          : ("active" as const),
    };
  });

  return (
    <div>
      <h1 className="text-xl font-semibold">Users</h1>
      <p className="mt-1 text-sm text-foreground/60">
        Every signed-up user, their selections, and subscription status.
      </p>

      <details className="mt-6 rounded-xl border border-border bg-surface">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:bg-brand/5">
          Add a new user
        </summary>
        <form action={createUser} className="grid gap-3 border-t border-border p-4 sm:grid-cols-2">
          <input
            name="fullName"
            placeholder="Full name"
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          />
          <input
            name="email"
            type="email"
            required
            placeholder="Email"
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          />
          <input
            name="password"
            type="password"
            required
            minLength={8}
            placeholder="Password (min. 8 characters)"
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          />
          {isSuperAdminViewer ? (
            <select
              name="role"
              defaultValue="user"
              className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          ) : (
            <input type="hidden" name="role" value="user" />
          )}
          <button className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand/90 sm:col-span-2 sm:w-fit">
            Create user
          </button>
        </form>
      </details>

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
              <th className="px-4 py-3">Password</th>
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
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      row.passwordStatus === "expired"
                        ? "bg-red-100 text-red-700"
                        : row.passwordStatus === "google"
                          ? "bg-foreground/10 text-foreground/60"
                          : "bg-green-100 text-green-700"
                    }`}
                  >
                    {row.passwordStatus === "google" ? "Google only" : row.passwordStatus}
                  </span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-foreground/50">
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
