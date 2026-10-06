"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Medium } from "@/lib/supabase/types";

export interface OnboardingState {
  error?: string;
}

const MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];

export async function confirmSelection(
  _prevState: OnboardingState,
  formData: FormData
): Promise<OnboardingState> {
  const { user } = await requireUser("/onboarding");

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

  // Board/grade/subject selection is free and instant -- there's no more
  // payment step to gate this on, so a subscription row is always "active"
  // from here on. Still matched against BOTH legacy states ("active" or a
  // pending_payment row from before this shipped, never since) rather than
  // "active" alone: subscriptions_one_live_per_user is a unique index on
  // user_id covering both statuses, so inserting a fresh row for a student
  // who still has an old pending_payment one sitting around would violate
  // it outright instead of just leaving a harmless duplicate -- confirmed
  // live, there was exactly one such row. Always written back as "active"
  // regardless of which state it's coming from.
  const { data: existing } = await supabase
    .from("subscriptions")
    .select("id, status")
    .eq("user_id", user.id)
    .in("status", ["active", "pending_payment"])
    .maybeSingle();

  let subscriptionId = existing?.id;

  if (!subscriptionId) {
    const { data: created, error: insertError } = await supabase
      .from("subscriptions")
      .insert({
        user_id: user.id,
        board_id: boardId,
        grade_id: gradeId,
        medium,
        status: "active",
      })
      .select("id")
      .single();

    if (insertError || !created) {
      return { error: "Could not save your selection. Please try again." };
    }
    subscriptionId = created.id;
  } else {
    // Resuming an incomplete (or, for a legacy row, still-pending)
    // onboarding, or changing an existing selection: update in place.
    await supabase
      .from("subscriptions")
      .update({
        board_id: boardId,
        grade_id: gradeId,
        medium,
        status: "active",
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

  redirect("/dashboard");
}
