import Link from "next/link";
import { notFound } from "next/navigation";
import { isPasswordExpired, PASSWORD_EXPIRY_DAYS, requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  cancelSubscription,
  deleteUser,
  sendPasswordResetEmail,
  setAccountExpired,
  setUserRole,
  updateUserProfile,
} from "../../actions";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { SetPasswordForm } from "./set-password-form";
import type { ProfileRole } from "@/lib/supabase/types";

const ROLE_LABEL: Record<ProfileRole, string> = {
  user: "User",
  admin: "Admin",
  superadmin: "Superadmin",
};

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user: actingUser, profile: actingProfile } = await requireAdminPage("users");
  const { id } = await params;
  const admin = createAdminClient();

  const [{ data: authUser }, { data: profile }, { data: subscriptions }, { data: identityRows }] =
    await Promise.all([
      admin.auth.admin.getUserById(id),
      admin.from("profiles").select("*").eq("id", id).single(),
      admin
        .from("subscriptions")
        .select("*, boards(name), grades(name), subscription_subjects(subjects(name))")
        .eq("user_id", id)
        .order("created_at", { ascending: false }),
      // admin.auth.admin.getUserById() doesn't reliably populate the
      // returned user's `identities` array -- query the real table via RPC
      // instead (see 0014_email_identity_check.sql).
      admin.rpc("get_users_with_email_identity", { p_user_ids: [id] }),
    ]);

  if (!authUser?.user) notFound();

  const isSuperAdminViewer = actingProfile?.role === "superadmin";
  const targetRole: ProfileRole = profile?.role ?? "user";
  // Mirrors deleteUser's own guards (no self-delete; staff accounts need a
  // superadmin) so the button doesn't invite an action that's a no-op.
  const canDeleteTarget = id !== actingUser.id && (targetRole === "user" || isSuperAdminViewer);
  const passwordExpired = isPasswordExpired(profile);
  const hasPasswordIdentity = identityRows?.[0]?.has_email_identity ?? false;

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

        {isSuperAdminViewer ? (
          <div className="flex items-center gap-2">
            {(["user", "admin", "superadmin"] as ProfileRole[]).map((role) => (
              <form
                key={role}
                action={async () => {
                  "use server";
                  await setUserRole(id, role);
                }}
              >
                <button
                  type="submit"
                  disabled={role === targetRole}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                    role === targetRole
                      ? "border-brand bg-brand/10 text-brand"
                      : "border-border hover:bg-brand/5"
                  }`}
                >
                  {ROLE_LABEL[role]}
                </button>
              </form>
            ))}
          </div>
        ) : (
          <span className="rounded-full bg-foreground/10 px-3 py-1 text-sm font-medium text-foreground/70">
            {ROLE_LABEL[targetRole]}
            <span className="ml-2 text-xs text-foreground/40">(only a superadmin can change this)</span>
          </span>
        )}
      </div>

      <details className="mt-4 rounded-xl border border-border bg-surface">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:bg-brand/5">
          Edit profile
        </summary>
        <form
          action={updateUserProfile.bind(null, id)}
          className="grid gap-3 border-t border-border p-4 sm:grid-cols-2"
        >
          <input
            name="fullName"
            defaultValue={profile?.full_name ?? ""}
            placeholder="Full name"
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          />
          <input
            name="email"
            type="email"
            required
            defaultValue={authUser.user.email ?? ""}
            placeholder="Email"
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          />
          <button className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand/90 sm:col-span-2 sm:w-fit">
            Save changes
          </button>
        </form>
      </details>

      <div className="mt-4 rounded-xl border border-border bg-surface p-6">
        <h2 className="text-sm font-semibold">Password</h2>

        {hasPasswordIdentity ? (
          <p className="mt-1 text-sm text-foreground/60">
            {profile?.password_changed_at ? (
              <>Last changed {new Date(profile.password_changed_at).toLocaleDateString()} — </>
            ) : (
              "Last changed: unknown (predates tracking) — "
            )}
            <span className={passwordExpired ? "font-medium text-red-600" : "font-medium text-green-700"}>
              {passwordExpired ? "expired" : "active"}
            </span>
            , same as any native account after {PASSWORD_EXPIRY_DAYS} days.
          </p>
        ) : (
          <p className="mt-1 text-sm text-foreground/60">
            Signed in with Google only — no password with this app yet. Setting one below also
            lets this account sign in with email/password from then on.
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <form action={sendPasswordResetEmail.bind(null, id)}>
            <button className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-brand/5">
              Send password reset email
            </button>
          </form>

          {hasPasswordIdentity && (
            <form action={setAccountExpired.bind(null, id)} className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-sm text-foreground/70">
                <input type="checkbox" name="expired" defaultChecked={passwordExpired} className="h-4 w-4" />
                Account expired
              </label>
              <button className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-brand/5">
                Save
              </button>
            </form>
          )}
        </div>

        <div className="mt-3">
          <SetPasswordForm
            userId={id}
            placeholder={
              hasPasswordIdentity ? "New password (min. 8 characters)" : "Set a password (min. 8 characters)"
            }
            submitLabel={hasPasswordIdentity ? "Set new password" : "Set password"}
          />
        </div>
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
            {targetRole === "admin" || targetRole === "superadmin"
              ? "Staff accounts get full subject access without a subscription."
              : "This user hasn't started onboarding yet."}
          </p>
        )}
      </div>

      {canDeleteTarget && (
        <div className="mt-8 rounded-xl border border-red-200 bg-red-50 p-5">
          <h2 className="text-sm font-semibold text-red-700">Danger zone</h2>
          <p className="mt-1 text-sm text-red-700/80">
            Permanently deletes this account: profile, subscriptions, and chat history. This cannot be
            undone.
          </p>
          <form action={deleteUser.bind(null, id)} className="mt-3">
            <ConfirmSubmitButton
              confirmMessage={`Delete ${authUser.user.email}? This permanently removes their account, subscriptions, and chat history.`}
              className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-100"
            >
              Delete user
            </ConfirmSubmitButton>
          </form>
        </div>
      )}
    </div>
  );
}
