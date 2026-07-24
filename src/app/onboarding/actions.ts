"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { amountForSubjects } from "@/lib/pricing";
import type { Medium } from "@/lib/supabase/types";

export interface OnboardingState {
  error?: string;
}

const MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];

export async function confirmSelection(
  _prevState: OnboardingState,
  formData: FormData
): Promise<OnboardingState> {
  const { user } = await requireUser();

  const boardId = String(formData.get("boardId") ?? "");
  const gradeId = String(formData.get("gradeId") ?? "");
  const medium = String(formData.get("medium") ?? "") as Medium;
  const subjectIds = formData.getAll("subjectIds").map(String).filter(Boolean);

  if (!boardId || !gradeId) {
    return { error: "Select a board and grade." };
  }
  if (!MEDIUMS.includes(medium)) {
    return { error: "Select a medium of instruction." };
  }
  if (subjectIds.length === 0) {
    return { error: "Select at least one subject." };
  }

  const supabase = await createClient();

  // Server-side guard: don't let a tampered request create a subscription
  // for a board/grade/subject combination we don't actually offer.
  const { data: validOfferings, error: offeringsError } = await supabase
    .from("board_grade_subjects")
    .select("subject_id")
    .eq("board_id", boardId)
    .eq("grade_id", gradeId)
    .in("subject_id", subjectIds);

  if (offeringsError) {
    return { error: "Could not validate subject selection. Please try again." };
  }
  const validSubjectIds = new Set((validOfferings ?? []).map((o) => o.subject_id));
  const chosenSubjectIds = subjectIds.filter((id) => validSubjectIds.has(id));

  if (chosenSubjectIds.length === 0) {
    return { error: "None of the selected subjects are offered for this board and grade." };
  }

  const { data: existing } = await supabase
    .from("subscriptions")
    .select("id, status")
    .eq("user_id", user.id)
    .in("status", ["pending_payment", "active"])
    .maybeSingle();

  if (existing?.status === "active") {
    redirect("/dashboard");
  }

  let subscriptionId = existing?.id;

  if (!subscriptionId) {
    const { data: created, error: insertError } = await supabase
      .from("subscriptions")
      .insert({
        user_id: user.id,
        board_id: boardId,
        grade_id: gradeId,
        medium,
        status: "pending_payment",
        amount_paise: amountForSubjects(chosenSubjectIds.length),
      })
      .select("id")
      .single();

    if (insertError || !created) {
      return { error: "Could not start your subscription. Please try again." };
    }
    subscriptionId = created.id;
  } else {
    // Resuming an incomplete onboarding: update the selection in place.
    await supabase
      .from("subscriptions")
      .update({
        board_id: boardId,
        grade_id: gradeId,
        medium,
        amount_paise: amountForSubjects(chosenSubjectIds.length),
      })
      .eq("id", subscriptionId);
    await supabase.from("subscription_subjects").delete().eq("subscription_id", subscriptionId);
  }

  const { error: subjectsError } = await supabase.from("subscription_subjects").insert(
    chosenSubjectIds.map((subjectId) => ({
      subscription_id: subscriptionId,
      subject_id: subjectId,
    }))
  );

  if (subjectsError) {
    return { error: "Could not save your subject selection. Please try again." };
  }

  redirect("/subscribe");
}
