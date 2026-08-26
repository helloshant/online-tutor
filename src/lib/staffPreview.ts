import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Medium } from "@/lib/supabase/types";

const VALID_MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];

export type StaffPreviewScope = { boardId: string; gradeId: string; medium: Medium };

// Validates a staff member's requested "preview as" board/grade/medium for
// one specific subject, so they can see exactly what a student under that
// combination experiences (syllabus scoping, RAG grounding, the answer
// bank) instead of only ever getting the unrestricted "ask anything" mode
// staff chat has always been. Reused by /api/chat and the answer-bank
// Practice endpoints (via studentScope.ts) so every subject-scoped route a
// staff preview touches applies the same check.
//
// Deliberately re-checked here rather than trusted from the client on
// every call: the same board_grade_subjects offering check onboarding
// itself applies to a real student's selection (see confirmSelection in
// src/app/onboarding/actions.ts), so staff can never preview a
// board/grade/subject combination no actual student could ever reach.
// Returns null on anything missing/invalid/unoffered rather than throwing
// -- callers treat that exactly like "no preview requested" and fall back
// to their own default (unrestricted staff mode, or no scope at all).
export async function resolveStaffPreviewScope(
  supabase: SupabaseClient<Database>,
  subjectId: string,
  raw: { boardId?: unknown; gradeId?: unknown; medium?: unknown }
): Promise<StaffPreviewScope | null> {
  const boardId = typeof raw.boardId === "string" ? raw.boardId : "";
  const gradeId = typeof raw.gradeId === "string" ? raw.gradeId : "";
  const medium = typeof raw.medium === "string" ? (raw.medium as Medium) : null;
  if (!boardId || !gradeId || !medium || !VALID_MEDIUMS.includes(medium)) return null;

  const { data: offering } = await supabase
    .from("board_grade_subjects")
    .select("subject_id")
    .eq("board_id", boardId)
    .eq("grade_id", gradeId)
    .eq("subject_id", subjectId)
    .maybeSingle();
  if (!offering) return null;

  return { boardId, gradeId, medium };
}
