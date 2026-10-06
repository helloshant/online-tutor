import { redirect } from "next/navigation";
import { isStaff, requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { OnboardingWizard } from "./onboarding-wizard";

export default async function OnboardingPage() {
  const { user, profile } = await requireUser("/onboarding");
  // Staff (admin/superadmin) never subscribe or pay -- they get unrestricted
  // subject access straight from the dashboard.
  if (isStaff(profile?.role)) redirect("/dashboard");

  const supabase = await createClient();

  // Board/grade/subject selection is saved "active" the instant it's
  // submitted (see onboarding/actions.ts) -- there's no more incomplete/
  // unpaid state to resume, so a row existing at all means onboarding is
  // already done.
  const { data: existing } = await supabase
    .from("subscriptions")
    .select("id, status, board_id, grade_id, medium")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  if (existing) redirect("/dashboard");

  const [{ data: boards }, { data: grades }, { data: subjects }, { data: mappings }] =
    await Promise.all([
      supabase.from("boards").select("*").order("name"),
      supabase.from("grades").select("*").order("level"),
      supabase.from("subjects").select("*").order("name"),
      supabase.from("board_grade_subjects").select("*"),
    ]);

  // ICSE isn't offered yet (see the home page's own "Currently we are not
  // offering to ICSE board" copy) -- its boards/mappings rows exist for
  // internal content work, but it must never be a selectable option for a
  // new signup.
  const offeredBoards = (boards ?? []).filter((b) => b.name !== "ICSE");

  return (
    <OnboardingWizard
      boards={offeredBoards}
      grades={grades ?? []}
      subjects={subjects ?? []}
      mappings={mappings ?? []}
    />
  );
}
