"use server";

import { revalidatePath } from "next/cache";
import { requireAdminPage } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Medium } from "@/lib/supabase/types";

const VALID_MEDIUMS: Medium[] = ["English", "Hindi", "Bengali"];

export async function addBoard(formData: FormData) {
  await requireAdminPage("catalog");
  const name = String(formData.get("name") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  if (!name || !code) return;
  const supabase = await createClient();
  await supabase.from("boards").insert({ name, code });
  revalidatePath("/admin/catalog");
}

export async function addGrade(formData: FormData) {
  await requireAdminPage("catalog");
  const name = String(formData.get("name") ?? "").trim();
  const level = Number(formData.get("level"));
  if (!name || !Number.isFinite(level)) return;
  const supabase = await createClient();
  await supabase.from("grades").insert({ name, level });
  revalidatePath("/admin/catalog");
}

export async function addSubject(formData: FormData) {
  await requireAdminPage("catalog");
  const name = String(formData.get("name") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  if (!name || !code) return;
  const supabase = await createClient();
  await supabase.from("subjects").insert({ name, code });
  revalidatePath("/admin/catalog");
}

export async function addOffering(formData: FormData) {
  await requireAdminPage("catalog");
  const boardId = String(formData.get("boardId") ?? "");
  const gradeId = String(formData.get("gradeId") ?? "");
  const subjectId = String(formData.get("subjectId") ?? "");
  if (!boardId || !gradeId || !subjectId) return;
  const supabase = await createClient();
  await supabase
    .from("board_grade_subjects")
    .insert({ board_id: boardId, grade_id: gradeId, subject_id: subjectId })
    .select()
    .maybeSingle();
  revalidatePath("/admin/catalog");
}

export async function removeOffering(offeringId: string) {
  await requireAdminPage("catalog");
  const supabase = await createClient();
  await supabase.from("board_grade_subjects").delete().eq("id", offeringId);
  revalidatePath("/admin/catalog");
}

export async function addSyllabusTopic(formData: FormData) {
  await requireAdminPage("catalog");
  const boardId = String(formData.get("boardId") ?? "");
  const gradeId = String(formData.get("gradeId") ?? "");
  const subjectId = String(formData.get("subjectId") ?? "");
  const medium = String(formData.get("medium") ?? "") as Medium;
  const chapter = String(formData.get("chapter") ?? "").trim();
  const topic = String(formData.get("topic") ?? "").trim();
  const sortOrder = Number(formData.get("sortOrder") ?? 0) || 0;
  if (!boardId || !gradeId || !subjectId || !VALID_MEDIUMS.includes(medium) || !chapter || !topic) return;
  const supabase = await createClient();
  await supabase.from("syllabus_topics").insert({
    board_id: boardId,
    grade_id: gradeId,
    subject_id: subjectId,
    medium,
    chapter,
    topic,
    sort_order: sortOrder,
  });
  revalidatePath("/admin/catalog");
}

// Matches a leading list marker: "1.", "1)", "(i)", "(iii)", "a)", or a bare
// bullet (-, *, •). The alphanumeric branch is ASCII-only by construction,
// so it can never accidentally eat the start of a real Bengali/Hindi word --
// those scripts have no code points in [a-zA-Z0-9], only actual Latin-letter
// or digit list markers match.
const LIST_MARKER_PATTERN = /^(\(?[a-zA-Z0-9]{1,4}[).:]|[-*•])\s*/;
// Official syllabus documents commonly punctuate a chapter heading with a
// trailing colon ("Real Numbers :") -- that's structural, not part of the
// chapter's name.
const TRAILING_COLON_PATTERN = /\s*[:：]\s*$/;

function cleanLine(line: string): string {
  return line.trim().replace(LIST_MARKER_PATTERN, "").replace(TRAILING_COLON_PATTERN, "").trim();
}

// Parses a pasted syllabus document into chapter/topic rows: an un-indented
// line starts a new chapter, and each indented line under it becomes one
// topic under that chapter. Leading list markers ("1.", "(ii)", "-", "•", ...)
// and a chapter heading's trailing colon are stripped automatically, so
// admins can paste close to verbatim from the official source -- numbered
// chapters, lettered/romanette sub-items and all -- instead of manually
// repeating the chapter name on every line or hand-editing every marker out
// first.
function parseBulkSyllabus(text: string): { chapter: string; topic: string }[] {
  const rows: { chapter: string; topic: string }[] = [];
  let currentChapter = "";

  for (const rawLine of text.split("\n")) {
    if (!rawLine.trim()) continue;
    const isIndented = /^[ \t]/.test(rawLine);
    const cleaned = cleanLine(rawLine);
    if (!cleaned) continue;

    if (!isIndented) {
      currentChapter = cleaned;
      continue;
    }
    if (!currentChapter) continue;
    rows.push({ chapter: currentChapter, topic: cleaned });
  }

  return rows;
}

export async function bulkAddSyllabusTopics(formData: FormData) {
  await requireAdminPage("catalog");
  const boardId = String(formData.get("boardId") ?? "");
  const gradeId = String(formData.get("gradeId") ?? "");
  const subjectId = String(formData.get("subjectId") ?? "");
  const medium = String(formData.get("medium") ?? "") as Medium;
  const bulkText = String(formData.get("bulkText") ?? "");
  if (!boardId || !gradeId || !subjectId || !VALID_MEDIUMS.includes(medium)) return;

  const parsed = parseBulkSyllabus(bulkText);
  if (parsed.length === 0) return;

  const supabase = await createClient();

  // Append after whatever's already there, so pasting more chapters into a
  // syllabus that's already partly entered doesn't reorder or clobber
  // existing rows.
  const { data: last } = await supabase
    .from("syllabus_topics")
    .select("sort_order")
    .eq("board_id", boardId)
    .eq("grade_id", gradeId)
    .eq("subject_id", subjectId)
    .eq("medium", medium)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  let nextSortOrder = (last?.sort_order ?? 0) + 1;

  const rows = parsed.map(({ chapter, topic }) => ({
    board_id: boardId,
    grade_id: gradeId,
    subject_id: subjectId,
    medium,
    chapter,
    topic,
    sort_order: nextSortOrder++,
  }));

  // Upsert with duplicates ignored -- re-pasting a syllabus (e.g. after
  // adding a few more chapters lower in the document) shouldn't error or
  // duplicate the chapters/topics already stored.
  await supabase
    .from("syllabus_topics")
    .upsert(rows, { onConflict: "board_id,grade_id,subject_id,medium,chapter,topic", ignoreDuplicates: true });

  revalidatePath("/admin/catalog");
}

export async function updateSyllabusTopic(topicId: string, formData: FormData) {
  await requireAdminPage("catalog");
  const chapter = String(formData.get("chapter") ?? "").trim();
  const topic = String(formData.get("topic") ?? "").trim();
  const sortOrder = Number(formData.get("sortOrder") ?? 0) || 0;
  if (!chapter || !topic) return;
  const supabase = await createClient();
  await supabase
    .from("syllabus_topics")
    .update({ chapter, topic, sort_order: sortOrder })
    .eq("id", topicId);
  revalidatePath("/admin/catalog");
}

export async function removeSyllabusTopic(topicId: string) {
  await requireAdminPage("catalog");
  const supabase = await createClient();
  await supabase.from("syllabus_topics").delete().eq("id", topicId);
  revalidatePath("/admin/catalog");
}
