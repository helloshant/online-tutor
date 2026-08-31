"use server";

import mammoth from "mammoth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdminPage } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { submitPipelineRun, mineArchetypeFamilies, type ArchetypeMinerLlmProvider } from "@/lib/archetypeMinerClient";
import type { EducationContext, EducationStage, CurriculumSourceType } from "@/lib/archetypeMinerTypes";

const EDUCATION_STAGES: EducationStage[] = ["secondary", "senior_secondary", "undergraduate"];
const CURRICULUM_SOURCE_TYPES: CurriculumSourceType[] = ["school_board", "university_program"];
const PAPER_TYPES = ["board_exam", "sample_paper", "compartment"] as const;
const EXTRACTION_METHODS = ["native_text", "ocr"] as const;
// Same cap the exam-answer-sheet upload uses (see
// api/broadcasts/[id]/exam/submit/route.ts) -- comfortably under both
// Anthropic's own PDF limits and, base64-encoded, this service's JSON body
// limit (see services/archetype-miner/src/server.ts). Per file -- a
// multi-file submission's aggregate size is bounded by next.config.ts's
// own serverActions.bodySizeLimit instead (the framework rejects an
// over-limit request before this action ever runs, so there's no useful
// aggregate check to add here on top of that).
const MAX_FILE_BYTES = 15 * 1024 * 1024;
// A generous but real ceiling on how many files one submission can carry --
// not because more is unsafe, but a batch this size is more usefully split
// into a few submissions than fully unbounded.
const MAX_FILES = 20;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type PaperFileContent = { pdf_base64: string; raw_text?: undefined } | { raw_text: string; pdf_base64?: undefined };

// Processes ONE uploaded paper file into either a base64 PDF or extracted
// DOCX text -- shared by every file in a multi-file submission, so each
// file's own name can appear in whichever error it produces (a batch
// submission with an error and no indication of WHICH file caused it would
// be a bad time for whoever has to go find it among a dozen).
async function extractPaperFileContent(
  file: File,
  llmProvider: ArchetypeMinerLlmProvider | undefined
): Promise<{ ok: true; content: PaperFileContent } | { ok: false; error: string }> {
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, error: `"${file.name}" is too large (max ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))}MB).` };
  }
  const isDocx = file.type === DOCX_MIME || file.name.toLowerCase().endsWith(".docx");

  if (file.type === "application/pdf") {
    if (llmProvider === "azure-openai") {
      return {
        ok: false,
        error:
          `"${file.name}" is a PDF, which requires the Anthropic provider -- Azure OpenAI has no native PDF ` +
          'reading. Switch "LLM provider for this run" to Anthropic, upload DOCX files instead, or paste extracted text.',
      };
    }
    // Stage 0 reads the PDF's pages directly (Anthropic's native document
    // understanding, see anthropicProvider.ts) rather than working from a
    // pre-extracted text layer -- this also covers scanned/photographed
    // past-year papers with no real text layer at all, which a plain
    // text-extraction step would otherwise return empty or garbled.
    try {
      const pdf_base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
      return { ok: true, content: { pdf_base64 } };
    } catch (err) {
      console.error(`Failed to read uploaded PDF "${file.name}":`, err);
      return { ok: false, error: `Could not read "${file.name}". Please try again or try a different file.` };
    }
  }

  if (isDocx) {
    // A .docx is always digitally-native text (a real XML document, never
    // a scanned page image), so it doesn't carry the "this is secretly a
    // scan with no text layer at all" failure mode that got the answer-
    // bank's own PDF-via-unpdf path removed (see README). It CAN still
    // come out unreadable a different way, though: a .docx produced by
    // converting a PDF/scan through a tool that used a custom or embedded
    // font can preserve the WRONG underlying character codes even though
    // the file displays correctly in Word (font substitution hides the
    // mismatch visually; mammoth reads the real, wrong codes). Real-world
    // case that surfaced this: a CBSE paper's extracted text came back as
    // 25k+ characters, non-empty, that passed straight through to Stage 0
    // as unreadable garbage (long runs of U+FFFD plus scrambled ASCII/
    // Devanagari) -- Stage 0 correctly declined to fabricate questions
    // from it, but that only shows up as an unexplained "zero questions
    // segmented" after a full run, not a clear error at upload time.
    try {
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(await file.arrayBuffer()) });
      if (!value.trim()) {
        return {
          ok: false,
          error: `Could not find any text in "${file.name}". Is it empty, or a scanned image pasted into Word?`,
        };
      }
      const replacementCharCount = (value.match(/�/g) ?? []).length;
      if (replacementCharCount > 20) {
        return {
          ok: false,
          error:
            `"${file.name}"'s extracted text looks corrupted (${replacementCharCount} unreadable character(s) found) ` +
            "-- likely produced from a PDF/scan with a custom or embedded font that didn't convert to real Unicode " +
            'text. If you have the original PDF, upload that instead and set "LLM provider for this run" to ' +
            "Anthropic -- it reads a PDF's pages directly rather than trusting a text layer that can be broken the " +
            "same way.",
        };
      }
      return { ok: true, content: { raw_text: value } };
    } catch (err) {
      console.error(`Failed to extract text from uploaded DOCX "${file.name}":`, err);
      return { ok: false, error: `Could not read "${file.name}". Please try again or try a different file.` };
    }
  }

  return { ok: false, error: `"${file.name}" must be a PDF or DOCX file.` };
}

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

// Shared by submitRunAction and mineFamiliesAction -- "default" (the
// select's own default option, see submit-run-form.tsx and
// families/page.tsx) means "omit llm_provider, let the service fall back
// to its own LLM_PROVIDER" rather than sending an actual value.
function readLlmProvider(formData: FormData): ArchetypeMinerLlmProvider | undefined {
  const raw = formData.get("llmProvider");
  return raw === "anthropic" || raw === "azure-openai" ? raw : undefined;
}

export type SubmitRunState = { error?: string };

// Submits a new pipeline run and redirects straight to its detail page --
// the run itself then executes in the background inside the
// archetype-miner service (see pipelineRunner.ts), this action only ever
// waits for the POST that creates the run row, never the run itself.
//
// useActionState-shaped (returns { error } instead of throwing) so a bad
// upload/validation failure or a submitPipelineRun failure (the
// archetype-miner service unreachable, rejecting an oversized PDF, etc.)
// shows up as real text on the form -- SubmitRunForm.tsx is the client
// component that renders it. Before this, every failure path here threw,
// and this page had no error boundary of its own, so any of them (not
// just the new PDF path) surfaced as Next's generic, message-free crash
// screen instead of something an admin could act on.
export async function submitRunAction(_prevState: SubmitRunState, formData: FormData): Promise<SubmitRunState> {
  const session = await requireAdminPage("archetype_miner");

  const educationContext = readEducationContext(formData);
  if (!educationContext) {
    return { error: "All education-context fields (stage, grade/year, curriculum source, subject/course) are required." };
  }

  const inputKind = formData.get("inputKind") as string | null;
  const curriculumTaxonomyText = ((formData.get("curriculumTaxonomyText") as string | null) ?? "").trim() || undefined;
  const llmProvider = readLlmProvider(formData);

  let runId: string;

  if (inputKind === "pre_segmented") {
    const raw = ((formData.get("preSegmentedJson") as string | null) ?? "").trim();
    if (!raw) return { error: "Paste at least one pre-segmented question as JSON." };
    let questions: unknown;
    try {
      questions = JSON.parse(raw);
    } catch {
      return { error: "Pre-segmented questions must be valid JSON (an array of SegmentedQuestion-shaped objects)." };
    }
    if (!Array.isArray(questions) || questions.length === 0) {
      return { error: "Pre-segmented questions must be a non-empty JSON array." };
    }
    try {
      const result = await submitPipelineRun({
        educationContext,
        curriculumTaxonomyText,
        createdBy: session.user.id,
        llmProvider,
        inputKind: "pre_segmented",
        questions,
      });
      runId = result.runId;
    } catch (err) {
      console.error("Failed to submit pre-segmented pipeline run:", err);
      return { error: err instanceof Error ? err.message : "Failed to submit this run. Please try again." };
    }
  } else {
    const rawText = ((formData.get("rawText") as string | null) ?? "").trim();
    const paperFiles = formData.getAll("paperFile").filter((f): f is File => f instanceof File && f.size > 0);
    const hasFiles = paperFiles.length > 0;

    if (rawText && hasFiles) {
      return { error: "Paste the paper's raw text OR upload file(s), not both." };
    }
    if (!rawText && !hasFiles) {
      return { error: "Paste the paper's raw text, or upload one or more PDF/DOCX files." };
    }
    if (hasFiles && paperFiles.length > MAX_FILES) {
      return { error: `Select at most ${MAX_FILES} files in one submission.` };
    }

    // Every file in the batch becomes its own paper entry, sharing the ONE
    // set of paper-metadata fields below (subject/year/board/set code/...)
    // -- there's no per-file metadata in this form. If the selected files
    // are actually from different years or set codes, submit them as
    // separate runs instead of one batch, so each gets its own correct
    // metadata rather than all of them sharing whichever single value was
    // typed in once.
    const fileContents: PaperFileContent[] = [];
    for (const file of paperFiles) {
      const processed = await extractPaperFileContent(file, llmProvider);
      if (!processed.ok) return { error: processed.error };
      fileContents.push(processed.content);
    }

    const subject = ((formData.get("paperSubject") as string | null) ?? "").trim() || educationContext.subject_or_course;
    const year = Number(formData.get("paperYear"));
    const board = ((formData.get("paperBoard") as string | null) ?? "").trim() || educationContext.curriculum_source.name;
    const paperClass = ((formData.get("paperClass") as string | null) ?? "").trim() || educationContext.grade_or_year;
    const setCode = ((formData.get("paperSetCode") as string | null) ?? "").trim() || null;
    const sourceUrl = ((formData.get("paperSourceUrl") as string | null) ?? "").trim();
    const paperType = formData.get("paperType") as string | null;
    const extractionMethod = formData.get("extractionMethod") as string | null;

    if (!Number.isFinite(year) || year <= 0) return { error: "Paper year must be a valid number." };
    if (!PAPER_TYPES.includes(paperType as (typeof PAPER_TYPES)[number])) return { error: "Invalid paper type." };
    if (!EXTRACTION_METHODS.includes(extractionMethod as (typeof EXTRACTION_METHODS)[number])) {
      return { error: "Invalid extraction method." };
    }

    const sharedPaperMeta = {
      subject,
      year,
      board,
      class: paperClass,
      set_code: setCode,
      paper_type: paperType as (typeof PAPER_TYPES)[number],
      source_url: sourceUrl,
      extraction_method: extractionMethod as (typeof EXTRACTION_METHODS)[number],
    };

    try {
      const result = await submitPipelineRun({
        educationContext,
        curriculumTaxonomyText,
        createdBy: session.user.id,
        llmProvider,
        inputKind: "raw_papers",
        papers: hasFiles
          ? fileContents.map((content) => ({ paper: sharedPaperMeta, ...content }))
          : [{ paper: sharedPaperMeta, raw_text: rawText }],
      });
      runId = result.runId;
    } catch (err) {
      console.error("Failed to submit raw_papers pipeline run:", err);
      return { error: err instanceof Error ? err.message : "Failed to submit this run. Please try again." };
    }
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

  await mineArchetypeFamilies(subjectOrCourse, readLlmProvider(formData));
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
