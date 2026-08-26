import { redirect } from "next/navigation";
import { isStaff, requireFreshPassword } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { DashboardShell } from "./dashboard-shell";
import type { Medium } from "@/lib/supabase/types";

const VALID_MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];

export default async function DashboardPage({
  searchParams,
}: {
  // Staff-only: which board/grade/medium to preview as (see
  // staff-preview-picker.tsx). Ignored entirely for a real student, whose
  // board/grade/medium always comes from their subscription.
  searchParams: Promise<{ board?: string; grade?: string; medium?: string }>;
}) {
  const { user, profile } = await requireFreshPassword();
  const supabase = await createClient();

  // Staff (admin/superadmin) never subscribe or pay -- they get every
  // subject in the catalog, unrestricted, straight away. They can also
  // optionally preview one specific board/grade/medium (via the picker in
  // dashboard-shell.tsx) to see exactly what a student under that
  // combination experiences -- full syllabus scoping, RAG grounding, the
  // answer bank -- instead of only ever getting the unrestricted mode.
  if (isStaff(profile?.role)) {
    const { board: boardParam, grade: gradeParam, medium: mediumParam } = await searchParams;
    const requestedMedium = VALID_MEDIUMS.includes(mediumParam as Medium) ? (mediumParam as Medium) : null;

    const [{ data: allBoards }, { data: allGrades }] = await Promise.all([
      supabase.from("boards").select("id, name").order("name"),
      supabase.from("grades").select("id, name").order("level"),
    ]);

    let previewBoardId: string | null = null;
    let previewGradeId: string | null = null;
    let previewMedium: Medium | null = null;
    let boardName = "All boards";
    let gradeName = "All grades";
    let subjects: { id: string; name: string; code: string }[] = [];

    if (boardParam && gradeParam && requestedMedium) {
      const [{ data: board }, { data: grade }, { data: offeringRows }] = await Promise.all([
        supabase.from("boards").select("name").eq("id", boardParam).maybeSingle(),
        supabase.from("grades").select("name").eq("id", gradeParam).maybeSingle(),
        // Same board_grade_subjects offering onboarding itself scopes a real
        // student's subject picker to -- a staff preview can never offer a
        // subject no actual student under that board/grade could reach.
        supabase
          .from("board_grade_subjects")
          .select("subjects(id, name, code)")
          .eq("board_id", boardParam)
          .eq("grade_id", gradeParam),
      ]);

      const offeredSubjects = ((offeringRows ?? []) as unknown as { subjects: { id: string; name: string; code: string } | null }[])
        .map((o) => o.subjects)
        .filter((s): s is { id: string; name: string; code: string } => Boolean(s))
        .sort((a, b) => a.name.localeCompare(b.name));

      // Only actually enters preview mode once board, grade, and at least
      // one offered subject all check out -- an unknown board/grade id, or
      // one that legitimately offers nothing, falls straight through to the
      // unrestricted default below rather than rendering a broken preview.
      if (board && grade && offeredSubjects.length > 0) {
        previewBoardId = boardParam;
        previewGradeId = gradeParam;
        previewMedium = requestedMedium;
        boardName = board.name;
        gradeName = grade.name;
        subjects = offeredSubjects;
      }
    }

    if (!previewBoardId) {
      const { data: allSubjects } = await supabase.from("subjects").select("id, name, code").order("name");
      subjects = allSubjects ?? [];
    }

    return (
      <DashboardShell
        userName={profile?.full_name ?? user.email ?? "Staff"}
        subscriptionId={null}
        boardId={previewBoardId}
        gradeId={previewGradeId}
        boardName={boardName}
        gradeName={gradeName}
        medium={previewMedium}
        subjects={subjects}
        isStaffUser
        allBoards={allBoards ?? []}
        allGrades={allGrades ?? []}
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
      boardId={subscription.board_id}
      gradeId={subscription.grade_id}
      boardName={board?.name ?? ""}
      gradeName={grade?.name ?? ""}
      medium={subscription.medium}
      subjects={subjects}
      isStaffUser={false}
    />
  );
}
