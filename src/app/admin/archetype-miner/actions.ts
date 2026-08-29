"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { submitPipelineRun, mineArchetypeFamilies } from "@/lib/archetypeMinerClient";
import type { EducationContext, EducationStage, CurriculumSourceType } from "@/lib/archetypeMinerTypes";

const EDUCATION_STAGES: EducationStage[] = ["secondary", "senior_secondary", "undergraduate"];
const CURRICULUM_SOURCE_TYPES: CurriculumSourceType[] = ["school_board", "university_program"];
const PAPER_TYPES = ["board_exam", "sample_paper", "compartment"] as const;
const EXTRACTION_METHODS = ["native_text", "ocr"] as const;
// Same cap the exam-answer-sheet upload uses (see
// api/broadcasts/[id]/exam/submit/route.ts) -- comfortably under both
// Anthropic's own PDF limits and, base64-encoded, this service's 25mb JSON
// body limit (see services/archetype-miner/src/server.ts).
const MAX_PDF_BYTES = 15 * 1024 * 1024;

function readEducationContext(formData: FormData): EducationContext | null {
  const educationStage = formData.get("educationStage") as string | null;
  const gradeOrYear = ((formData.get("gradeOrYear") as string | null) ?? "").trim();
  const curriculumSourceType = formData.get("curriculumSourceType") as string | null;
  const curriculumSourceName = ((formData.get("curriculumSourceName") as string | null) ?? "").trim();
  const countryOrRegion = ((formData.get("countryOrRegion") as string | null) ?? "").trim() || null;
  const subjectOrCourse = ((formData.get("subjectOrCourse") as string | null) ?? "").trim();
  const programOrStream = ((formData.get("programOrStream") as string | null) ?? "").trim() || null;
  const taxonomySupplied = formData.get("taxonomySupplied") === "on";

  if (
    !EDUCATION_STAGES.includes(educationStage as EducationStage) ||
    !gradeOrYear ||
    !CURRICULUM_SOURCE_TYPES.includes(curriculumSourceType as CurriculumSourceType) ||
    !curriculumSourceName ||
    !subjectOrCourse
  ) {
    return null;
  }

  return {
    education_stage: educationStage as EducationStage,
    grade_or_year: gradeOrYear,
    curriculum_source: {
      type: curriculumSourceType as CurriculumSourceType,
      name: curriculumSourceName,
      country_or_region: countryOrRegion,
      // What the admin checked here is just this SUBMISSION's own claim --
      // pipelineRunner.ts resolves the real, authoritative value itself
      // (an explicit curriculumTaxonomyText below, or a stored document for
      // this exact curriculum_source) and stamps that corrected value onto
      // every record the run produces, so this box being right or wrong
      // never actually matters to Stage 1's own prompt branch.
      taxonomy_supplied: taxonomySupplied,
    },
    subject_or_course: subjectOrCourse,
    program_or_stream: programOrStream,
  };
}

// Submits a new pipeline run and redirects straight to its detail page --
// the run itself then executes in the background inside the
// archetype-miner service (see pipelineRunner.ts), this action only ever
// waits for the POST that creates the run row, never the run itself.
export async function submitRunAction(formData: FormData): Promise<void> {
  const session = await requireAdminPage("archetype_miner");

  const educationContext = readEducationContext(formData);
  if (!educationContext) {
    throw new Error("All education-context fields (stage, grade/year, curriculum source, subject/course) are required.");
  }

  const inputKind = formData.get("inputKind") as string | null;
  const curriculumTaxonomyText = ((formData.get("curriculumTaxonomyText") as string | null) ?? "").trim() || undefined;

  let runId: string;

  if (inputKind === "pre_segmented") {
    const raw = ((formData.get("preSegmentedJson") as string | null) ?? "").trim();
    if (!raw) throw new Error("Paste at least one pre-segmented question as JSON.");
    let questions: unknown;
    try {
      questions = JSON.parse(raw);
    } catch {
      throw new Error("Pre-segmented questions must be valid JSON (an array of SegmentedQuestion-shaped objects).");
    }
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error("Pre-segmented questions must be a non-empty JSON array.");
    }
    const result = await submitPipelineRun({
      educationContext,
      curriculumTaxonomyText,
      createdBy: session.user.id,
      inputKind: "pre_segmented",
      questions,
    });
    runId = result.runId;
  } else {
    const rawText = ((formData.get("rawText") as string | null) ?? "").trim();
    const pdfFile = formData.get("paperPdf");
    const hasPdf = pdfFile instanceof File && pdfFile.size > 0;

    if (rawText && hasPdf) {
      throw new Error("Paste the paper's raw text OR upload a PDF, not both.");
    }
    if (!rawText && !hasPdf) {
      throw new Error("Paste the paper's raw text, or upload it as a PDF.");
    }

    let pdfBase64: string | undefined;
    if (hasPdf) {
      const file = pdfFile as File;
      if (file.type !== "application/pdf") {
        throw new Error("The paper upload must be a PDF file.");
      }
      if (file.size > MAX_PDF_BYTES) {
        throw new Error(`That PDF is too large (max ${Math.floor(MAX_PDF_BYTES / (1024 * 1024))}MB).`);
      }
      // Stage 0 reads the PDF's pages directly (Anthropic's native document
      // understanding, see anthropicProvider.ts) rather than working from a
      // pre-extracted text layer -- this also covers scanned/photographed
      // past-year papers with no real text layer at all, which a plain
      // text-extraction step would otherwise return empty or garbled.
      pdfBase64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    }

    const subject = ((formData.get("paperSubject") as string | null) ?? "").trim() || educationContext.subject_or_course;
    const year = Number(formData.get("paperYear"));
    const board = ((formData.get("paperBoard") as string | null) ?? "").trim() || educationContext.curriculum_source.name;
    const paperClass = ((formData.get("paperClass") as string | null) ?? "").trim() || educationContext.grade_or_year;
    const setCode = ((formData.get("paperSetCode") as string | null) ?? "").trim() || null;
    const sourceUrl = ((formData.get("paperSourceUrl") as string | null) ?? "").trim();
    const paperType = formData.get("paperType") as string | null;
    const extractionMethod = formData.get("extractionMethod") as string | null;

    if (!Number.isFinite(year) || year <= 0) throw new Error("Paper year must be a valid number.");
    if (!PAPER_TYPES.includes(paperType as (typeof PAPER_TYPES)[number])) throw new Error("Invalid paper type.");
    if (!EXTRACTION_METHODS.includes(extractionMethod as (typeof EXTRACTION_METHODS)[number])) {
      throw new Error("Invalid extraction method.");
    }

    const result = await submitPipelineRun({
      educationContext,
      curriculumTaxonomyText,
      createdBy: session.user.id,
      inputKind: "raw_papers",
      papers: [
        {
          paper: {
            subject,
            year,
            board,
            class: paperClass,
            set_code: setCode,
            paper_type: paperType as (typeof PAPER_TYPES)[number],
            source_url: sourceUrl,
            extraction_method: extractionMethod as (typeof EXTRACTION_METHODS)[number],
          },
          ...(pdfBase64 ? { pdf_base64: pdfBase64 } : { raw_text: rawText }),
        },
      ],
    });
    runId = result.runId;
  }

  revalidatePath("/admin/archetype-miner");
  redirect(`/admin/archetype-miner/${runId}`);
}

// Resolving a review-queue item is plain CRUD (set status/resolution/
// resolved_by/resolved_at) -- done directly against Supabase with the
// ordinary session client, same as updateUserUsageLimit does for
// student_usage_limits: archetype_review_queue's own "admin can resolve"
// RLS policy is the real enforcement here, not just this page's
// requireAdminPage check, so this can't be bypassed by calling the action
// directly even if that check ever had a bug.
export async function resolveReviewItemAction(runId: string, itemId: string, formData: FormData): Promise<void> {
  const session = await requireAdminPage("archetype_miner");
  const resolution = ((formData.get("resolution") as string | null) ?? "").trim();
  if (!resolution) throw new Error("A resolution note is required.");

  const supabase = await createClient();
  await supabase
    .from("archetype_review_queue")
    .update({
      status: "resolved",
      resolution,
      resolved_by: session.user.id,
      resolved_at: new Date().toISOString(),
    })
    .eq("queue_item_id", itemId);

  revalidatePath(`/admin/archetype-miner/${runId}`);
}

// Triggers Stage 4 (cross-level family mining) for one subject_or_course --
// see stage4FamilyMiner.ts for why this always requires an explicit
// subject rather than running over the whole catalogue unprompted.
export async function mineFamiliesAction(formData: FormData): Promise<void> {
  await requireAdminPage("archetype_miner");
  const subjectOrCourse = ((formData.get("subjectOrCourse") as string | null) ?? "").trim();
  if (!subjectOrCourse) throw new Error("subjectOrCourse is required.");

  await mineArchetypeFamilies(subjectOrCourse);
  revalidatePath("/admin/archetype-miner/families");
}

// Curriculum taxonomy documents are plain admin CRUD against Supabase
// directly -- same posture as chapter_documents (see
// supabase/migrations/0039_archetype_miner_admin_and_families.sql's own
// comment). archetype-miner's pipelineRunner reads this table
// (service-role) to resolve a run's taxonomy automatically; it never
// writes to it.
export async function saveTaxonomyAction(formData: FormData): Promise<void> {
  const session = await requireAdminPage("archetype_miner");

  const curriculumSourceType = formData.get("curriculumSourceType") as string | null;
  const curriculumSourceName = ((formData.get("curriculumSourceName") as string | null) ?? "").trim();
  const countryOrRegion = ((formData.get("countryOrRegion") as string | null) ?? "").trim() || null;
  const taxonomyText = ((formData.get("taxonomyText") as string | null) ?? "").trim();

  if (
    !CURRICULUM_SOURCE_TYPES.includes(curriculumSourceType as CurriculumSourceType) ||
    !curriculumSourceName ||
    !taxonomyText
  ) {
    throw new Error("Curriculum source type, name, and taxonomy text are all required.");
  }

  const admin = createAdminClient();
  const { error } = await admin.from("archetype_curriculum_taxonomies").upsert(
    {
      curriculum_source_type: curriculumSourceType as CurriculumSourceType,
      curriculum_source_name: curriculumSourceName,
      country_or_region: countryOrRegion,
      taxonomy_text: taxonomyText,
      updated_by: session.user.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "curriculum_source_type,curriculum_source_name,country_or_region_key" }
  );
  if (error) throw new Error(error.message);

  revalidatePath("/admin/archetype-miner/taxonomies");
}

export async function deleteTaxonomyAction(id: string): Promise<void> {
  await requireAdminPage("archetype_miner");
  const supabase = await createClient();
  await supabase.from("archetype_curriculum_taxonomies").delete().eq("id", id);
  revalidatePath("/admin/archetype-miner/taxonomies");
}
