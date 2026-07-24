import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { cancelSubscription, setUserRole } from "../../actions";

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const admin = createAdminClient();

  const [{ data: authUser }, { data: profile }, { data: subscriptions }] = await Promise.all([
    admin.auth.admin.getUserById(id),
    admin.from("profiles").select("*").eq("id", id).single(),
    admin
      .from("subscriptions")
      .select("*, boards(name), grades(name), subscription_subjects(subjects(name))")
      .eq("user_id", id)
      .order("created_at", { ascending: false }),
  ]);

  if (!authUser?.user) notFound();

  return (
    <div>
      <Link href="/admin" className="text-sm text-brand hover:underline">
        ← All users
      </Link>

      <div className="mt-4 flex items-start justify-between rounded-xl border border-border bg-surface p-6">
        <div>
          <h1 className="text-xl font-semibold">{profile?.full_name ?? "Unnamed user"}</h1>
          <p className="mt-1 text-sm text-foreground/60">{authUser.user.email}</p>
          <p className="mt-1 text-xs text-foreground/40">
            Joined {new Date(authUser.user.created_at).toLocaleDateString()}
          </p>
        </div>

        <form
          action={async () => {
            "use server";
            const nextRole = profile?.role === "admin" ? "user" : "admin";
            await setUserRole(id, nextRole);
          }}
        >
          <button
            type="submit"
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-brand/5"
          >
            {profile?.role === "admin" ? "Revoke admin" : "Make admin"}
          </button>
        </form>
      </div>

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-foreground/50">
        Subscriptions
      </h2>

      <div className="mt-3 space-y-3">
        {(subscriptions ?? []).map((sub) => {
          const subjects = (
            (sub as unknown as { subscription_subjects?: { subjects: { name: string } | null }[] })
              .subscription_subjects ?? []
          )
            .map((s) => s.subjects?.name)
            .filter(Boolean);
          const board = (sub as unknown as { boards?: { name: string } | null }).boards?.name;
          const grade = (sub as unknown as { grades?: { name: string } | null }).grades?.name;

          return (
            <div key={sub.id} className="rounded-xl border border-border bg-surface p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      sub.status === "active"
                        ? "bg-green-100 text-green-700"
                        : sub.status === "pending_payment"
                          ? "bg-yellow-100 text-yellow-700"
                          : "bg-foreground/10 text-foreground/60"
                    }`}
                  >
                    {sub.status}
                  </span>
                  <span className="text-sm text-foreground/60">
                    {new Date(sub.created_at).toLocaleDateString()}
                  </span>
                </div>
                {sub.status === "active" && (
                  <form
                    action={async () => {
                      "use server";
                      await cancelSubscription(sub.id, id);
                    }}
                  >
                    <button
                      type="submit"
                      className="rounded-lg border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      Cancel subscription
                    </button>
                  </form>
                )}
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-foreground/50">Board</dt>
                  <dd className="font-medium">{board ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-foreground/50">Grade</dt>
                  <dd className="font-medium">{grade ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-foreground/50">Medium</dt>
                  <dd className="font-medium">{sub.medium}</dd>
                </div>
                <div>
                  <dt className="text-foreground/50">Amount</dt>
                  <dd className="font-medium">
                    {sub.amount_paise ? `₹${(sub.amount_paise / 100).toFixed(0)}/mo` : "—"}
                  </dd>
                </div>
                <div className="col-span-2 sm:col-span-4">
                  <dt className="text-foreground/50">Subjects</dt>
                  <dd className="font-medium">{subjects.length ? subjects.join(", ") : "—"}</dd>
                </div>
              </dl>
            </div>
          );
        })}

        {(subscriptions ?? []).length === 0 && (
          <p className="rounded-xl border border-border bg-surface p-5 text-sm text-foreground/50">
            This user hasn&apos;t started onboarding yet.
          </p>
        )}
      </div>
    </div>
  );
}
