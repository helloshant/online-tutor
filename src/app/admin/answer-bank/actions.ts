"use server";

import { revalidatePath } from "next/cache";
import { requireAdminPage } from "@/lib/auth";
import { invalidateCachedAnswer } from "@/lib/orchestratorClient";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Medium } from "@/lib/supabase/types";

// The scope fields needed to evict the matching Redis entry -- the review
// page already has the full row loaded, so these are passed straight
// through rather than looked up again.
export type AnswerBankScope = {
  id: string;
  boardId: string;
  gradeId: string;
  subjectId: string;
  medium: Medium;
  question: string;
};

export async function approveAnswer(id: string) {
  await requireAdminPage("answer_bank");
  const supabase = createAdminClient();
  await supabase.from("answered_questions").update({ validation_status: "admin_approved" }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

export async function rejectAnswer(scope: AnswerBankScope) {
  await requireAdminPage("answer_bank");
  const supabase = createAdminClient();
  await supabase.from("answered_questions").update({ validation_status: "rejected" }).eq("id", scope.id);
  // A rejected answer must stop being served immediately, not whenever its
  // Redis TTL happens to expire.
  await invalidateCachedAnswer(scope);
  revalidatePath("/admin/answer-bank");
}

// Undoes an approve/reject decision back to the implicit-validation default,
// so a mistaken click isn't permanent. No cache eviction needed here -- an
// auto_approved row is servable again, and the next matching question just
// repopulates the cache from the database as usual.
export async function restoreAnswer(id: string) {
  await requireAdminPage("answer_bank");
  const supabase = createAdminClient();
  await supabase.from("answered_questions").update({ validation_status: "auto_approved" }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

export async function deleteAnswer(scope: AnswerBankScope) {
  await requireAdminPage("answer_bank");
  const supabase = createAdminClient();
  await supabase.from("answered_questions").delete().eq("id", scope.id);
  await invalidateCachedAnswer(scope);
  revalidatePath("/admin/answer-bank");
}

// Read-then-write rather than a Postgres array_append/remove RPC -- this is
// an admin-only tool with effectively no concurrent-edit risk, so the extra
// round trip is a fine trade for not needing two more RPCs.
export async function addTag(id: string, formData: FormData) {
  await requireAdminPage("answer_bank");
  const tag = ((formData.get("tag") as string | null) ?? "").trim();
  if (!tag) return;

  const supabase = createAdminClient();
  const { data } = await supabase.from("answered_questions").select("tags").eq("id", id).single();
  const tags = Array.from(new Set([...(data?.tags ?? []), tag]));
  await supabase.from("answered_questions").update({ tags }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

export async function removeTag(id: string, tag: string) {
  await requireAdminPage("answer_bank");
  const supabase = createAdminClient();
  const { data } = await supabase.from("answered_questions").select("tags").eq("id", id).single();
  const tags = (data?.tags ?? []).filter((t: string) => t !== tag);
  await supabase.from("answered_questions").update({ tags }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

// Public bucket created in 0017_answer_bank_image.sql -- see that migration
// for why no storage.objects policy is needed (only this service-role
// client ever writes).
const IMAGE_BUCKET = "answer-bank-images";
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
// Well under Supabase Storage's own limits -- a textbook page photo doesn't
// need to be huge to be legible, and this keeps upload latency reasonable
// on the admin's connection.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// Silently no-ops on an invalid/missing file, same philosophy as addTag
// above (a simple per-row action with no dedicated feedback UI) -- there's
// no useActionState wired up for this row-level form, so there's nowhere to
// surface an error message anyway.
export async function setImage(id: string, formData: FormData) {
  await requireAdminPage("answer_bank");
  const file = formData.get("image") as File | null;
  if (!file || file.size === 0 || file.size > MAX_IMAGE_BYTES || !ALLOWED_IMAGE_TYPES.has(file.type)) {
    return;
  }

  const supabase = createAdminClient();
  // One fixed path per row (upsert: true) rather than a filename derived
  // from the upload -- a re-upload always replaces the same object instead
  // of accumulating orphaned files under this id.
  const { error: uploadError } = await supabase.storage
    .from(IMAGE_BUCKET)
    .upload(id, file, { contentType: file.type, upsert: true });
  if (uploadError) {
    console.error("Answer bank image upload failed:", uploadError);
    return;
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(id);
  await supabase.from("answered_questions").update({ image_url: publicUrl }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

export async function removeImage(id: string) {
  await requireAdminPage("answer_bank");
  const supabase = createAdminClient();
  await supabase.storage.from(IMAGE_BUCKET).remove([id]);
  await supabase.from("answered_questions").update({ image_url: null }).eq("id", id);
  revalidatePath("/admin/answer-bank");
}

// Same Q:/A:/--- block format the orchestrator's exercise generation uses
// (services/orchestrator/src/exerciseParser.ts) -- deliberately duplicated
// rather than shared, same as every other type/parser this web app
// mirrors from the orchestrator, since the two are independently deployed
// packages with no shared code path. "A:" is optional -- a question whose
// entire answer is a diagram/handwritten working (image-only, no text) is
// imported with an empty answer, then the admin attaches the image
// afterward via setImage on that row in the main list.
const QUESTION_PREFIX_PATTERN = /^Q:\s*/i;
// Not anchored to the very start of the remaining text (unlike
// QUESTION_PREFIX_PATTERN) -- it's searched for anywhere via .match() below,
// which is what lets a multi-line question be told apart from a one-line
// question with no answer at all: a lazy quantifier with an *optional*
// "\nA:" suffix would instead just stop at the block's first line break
// (its earliest opportunity to satisfy $ in multiline mode) whenever no
// "A:" line is present, silently truncating anything after it.
const ANSWER_LINE_PATTERN = /\r?\n^A:\s*/im;

function parseImportBlocks(text: string): { question: string; answer: string }[] {
  // Normalize CRLF/CR up front -- pasting from a Windows-originated source
  // (or through some clipboard managers/editors) can leave "\r\n" line
  // endings, and a stray "\r" sitting right before the separator's "\n"
  // stops the split below from matching there at all, silently swallowing
  // every subsequent block into the answer of whatever came before it.
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n-{3,}\n/);
  const rows: { question: string; answer: string }[] = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;
    if (!QUESTION_PREFIX_PATTERN.test(block)) continue;

    const withoutPrefix = block.replace(QUESTION_PREFIX_PATTERN, "");
    const answerMatch = withoutPrefix.match(ANSWER_LINE_PATTERN);

    let question: string;
    let answer: string;
    if (answerMatch && answerMatch.index !== undefined) {
      question = withoutPrefix.slice(0, answerMatch.index).trim();
      answer = withoutPrefix.slice(answerMatch.index + answerMatch[0].length).trim();
    } else {
      question = withoutPrefix.trim();
      answer = "";
    }

    if (!question) continue;
    rows.push({ question, answer });
  }

  return rows;
}

// Same threshold the orchestrator's own dedup checks use (answerBank.ts,
// answerValidation-adjacent) -- below this a full-text match is too weak to
// trust as "the same question," and above it, confident enough to skip
// re-inserting.
const MIN_RANK = 0.1;

export interface BulkImportState {
  error?: string;
  success?: {
    imported: number;
    skippedDuplicates: number;
    totalParsed: number;
    importedWithoutAnswer: number;
  };
}

// Bulk-imported content is admin-curated (a real textbook or exam paper),
// not LLM output -- it skips validateAnswerForStorage entirely (that
// heuristic exists to catch a generated answer hedging or reading like a
// question asked back, neither of which applies to hand-sourced content)
// and is stored admin_approved so it's immediately servable, same trust
// level as manually approving a pending_review entry.
export async function bulkImportAnswers(
  _prevState: BulkImportState,
  formData: FormData
): Promise<BulkImportState> {
  await requireAdminPage("answer_bank");

  const boardId = formData.get("boardId") as string | null;
  const gradeId = formData.get("gradeId") as string | null;
  const subjectId = formData.get("subjectId") as string | null;
  const medium = formData.get("medium") as Medium | null;
  const topicId = (formData.get("topicId") as string | null) || null;
  const tags = ((formData.get("tags") as string | null) ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const text = (formData.get("bulkText") as string | null) ?? "";

  if (!boardId || !gradeId || !subjectId || !medium || !text.trim()) {
    return { error: "Board, grade, subject, medium, and the question text are all required." };
  }

  const rows = parseImportBlocks(text);
  if (rows.length === 0) {
    return {
      error:
        'Could not find any "Q: ..." blocks in that text. Check the format and that entries are ' +
        "separated by a line of three or more dashes (---).",
    };
  }

  const supabase = createAdminClient();

  // Per-row dedup against whatever's already banked for this board/grade/
  // subject/medium (the same RPC the chat pipeline and exercise generation
  // use for their own dedup checks) -- re-pasting the same source a second
  // time (e.g. after fixing a typo elsewhere in the document) would
  // otherwise silently pile up duplicate rows forever, since bulk import
  // has no other write-time safeguard the way LLM-generated content does.
  const toInsert: { question: string; answer: string }[] = [];
  let skippedDuplicates = 0;
  for (const row of rows) {
    const { data, error } = await supabase
      .rpc("search_answer_bank", {
        p_board_id: boardId,
        p_grade_id: gradeId,
        p_subject_id: subjectId,
        p_medium: medium,
        p_query: row.question,
        p_min_rank: MIN_RANK,
      })
      .maybeSingle();

    if (error) {
      // Fail open, same philosophy as every other answer-bank lookup in
      // this app -- a broken dedup check shouldn't block the import, it
      // should just risk an occasional duplicate instead.
      console.error("Bulk import dedup check failed:", error);
    }
    if (data) {
      skippedDuplicates += 1;
      continue;
    }
    toInsert.push(row);
  }

  if (toInsert.length > 0) {
    const { error } = await supabase.from("answered_questions").insert(
      toInsert.map((r) => ({
        board_id: boardId,
        grade_id: gradeId,
        subject_id: subjectId,
        medium,
        topic_id: topicId,
        question: r.question,
        answer: r.answer,
        validation_status: "admin_approved" as const,
        tags,
      }))
    );
    if (error) {
      console.error("Bulk import insert failed:", error);
      return { error: "Something went wrong while saving. Please try again." };
    }
  }

  revalidatePath("/admin/answer-bank");
  return {
    success: {
      imported: toInsert.length,
      skippedDuplicates,
      totalParsed: rows.length,
      importedWithoutAnswer: toInsert.filter((r) => !r.answer).length,
    },
  };
}
