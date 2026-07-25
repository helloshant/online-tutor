import { redirect } from "next/navigation";
import { isStaff, requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { DashboardShell } from "./dashboard-shell";

export default async function DashboardPage() {
  const { user, profile } = await requireUser();
  const supabase = await createClient();

  // Staff (admin/superadmin) never subscribe or pay -- they get every
  // subject in the catalog, unrestricted, straight away.
  if (isStaff(profile?.role)) {
    const { data: subjects } = await supabase.from("subjects").select("id, name, code").order("name");

    return (
      <DashboardShell
        userName={profile?.full_name ?? user.email ?? "Staff"}
        subscriptionId={null}
        boardName="All boards"
        gradeName="All grades"
        medium={null}
        subjects={subjects ?? []}
        isStaffUser
      />
    );
  }

  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("id, status, medium, board_id, grade_id")
    .eq("user_id", user.id)
    .in("status", ["pending_payment", "active"])
    .maybeSingle();

  if (!subscription) redirect("/onboarding");
  if (subscription.status === "pending_payment") redirect("/subscribe");

  const [{ data: board }, { data: grade }, { data: subjectRows }] = await Promise.all([
    supabase.from("boards").select("name").eq("id", subscription.board_id).single(),
    supabase.from("grades").select("name, level").eq("id", subscription.grade_id).single(),
    supabase
      .from("subscription_subjects")
      .select("subjects(id, name, code)")
      .eq("subscription_id", subscription.id),
  ]);

  const subjects = (subjectRows ?? [])
    .map((row) => (row as unknown as { subjects: { id: string; name: string; code: string } | null }).subjects)
    .filter((s): s is { id: string; name: string; code: string } => Boolean(s))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <DashboardShell
      userName={profile?.full_name ?? user.email ?? "Student"}
      subscriptionId={subscription.id}
      boardName={board?.name ?? ""}
      gradeName={grade?.name ?? ""}
      medium={subscription.medium}
      subjects={subjects}
      isStaffUser={false}
    />
  );
}
