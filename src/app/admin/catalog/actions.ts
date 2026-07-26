"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function addBoard(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  if (!name || !code) return;
  const supabase = await createClient();
  await supabase.from("boards").insert({ name, code });
  revalidatePath("/admin/catalog");
}

export async function addGrade(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const level = Number(formData.get("level"));
  if (!name || !Number.isFinite(level)) return;
  const supabase = await createClient();
  await supabase.from("grades").insert({ name, level });
  revalidatePath("/admin/catalog");
}

export async function addSubject(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  if (!name || !code) return;
  const supabase = await createClient();
  await supabase.from("subjects").insert({ name, code });
  revalidatePath("/admin/catalog");
}

export async function addOffering(formData: FormData) {
  await requireAdmin();
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
  await requireAdmin();
  const supabase = await createClient();
  await supabase.from("board_grade_subjects").delete().eq("id", offeringId);
  revalidatePath("/admin/catalog");
}

export async function addSyllabusTopic(formData: FormData) {
  await requireAdmin();
  const boardId = String(formData.get("boardId") ?? "");
  const gradeId = String(formData.get("gradeId") ?? "");
  const subjectId = String(formData.get("subjectId") ?? "");
  const chapter = String(formData.get("chapter") ?? "").trim();
  const topic = String(formData.get("topic") ?? "").trim();
  const sortOrder = Number(formData.get("sortOrder") ?? 0) || 0;
  if (!boardId || !gradeId || !subjectId || !chapter || !topic) return;
  const supabase = await createClient();
  await supabase.from("syllabus_topics").insert({
    board_id: boardId,
    grade_id: gradeId,
    subject_id: subjectId,
    chapter,
    topic,
    sort_order: sortOrder,
  });
  revalidatePath("/admin/catalog");
}

export async function updateSyllabusTopic(topicId: string, formData: FormData) {
  await requireAdmin();
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
  await requireAdmin();
  const supabase = await createClient();
  await supabase.from("syllabus_topics").delete().eq("id", topicId);
  revalidatePath("/admin/catalog");
}
