import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { OnboardingWizard } from "./onboarding-wizard";

export default async function OnboardingPage() {
  const { user } = await requireUser();
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("subscriptions")
    .select("id, status, board_id, grade_id, medium")
    .eq("user_id", user.id)
    .in("status", ["pending_payment", "active"])
    .maybeSingle();

  if (existing?.status === "active") redirect("/dashboard");

  const [{ data: boards }, { data: grades }, { data: subjects }, { data: mappings }, { data: existingSubjects }] =
    await Promise.all([
      supabase.from("boards").select("*").order("name"),
      supabase.from("grades").select("*").order("level"),
      supabase.from("subjects").select("*").order("name"),
      supabase.from("board_grade_subjects").select("*"),
      existing
        ? supabase.from("subscription_subjects").select("subject_id").eq("subscription_id", existing.id)
        : Promise.resolve({ data: [] as { subject_id: string }[] }),
    ]);

  return (
    <OnboardingWizard
      boards={boards ?? []}
      grades={grades ?? []}
      subjects={subjects ?? []}
      mappings={mappings ?? []}
      initial={
        existing
          ? {
              boardId: existing.board_id,
              gradeId: existing.grade_id,
              medium: existing.medium,
              subjectIds: (existingSubjects ?? []).map((s) => s.subject_id),
            }
          : undefined
      }
    />
  );
}
