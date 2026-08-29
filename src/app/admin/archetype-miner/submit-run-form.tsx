"use client";

import { useActionState } from "react";
import { submitRunAction, type SubmitRunState } from "./actions";
import type { ArchetypeMinerLlmProvider } from "@/lib/archetypeMinerClient";

const initialState: SubmitRunState = {};

// Client component wrapping submitRunAction via useActionState -- same
// convention every other file-upload form in this app follows (see
// answer-bank/bulk-import-form.tsx), so a failure (bad input, or
// submitPipelineRun failing because the archetype-miner service rejected
// or couldn't reach the request) renders as real text on the form instead
// of Next's generic, message-free crash screen that a plain
// <form action={serverAction}> falls back to when the action throws.
export function SubmitRunForm({ llmProvider }: { llmProvider: ArchetypeMinerLlmProvider | null }) {
  const [state, formAction, pending] = useActionState(submitRunAction, initialState);
  // Native PDF input only exists on the Anthropic path (see
  // anthropicProvider.ts) -- the service rejects a PDF outright when it's
  // running on Azure OpenAI (azureOpenAIProvider.ts), so disable it here
  // rather than let an admin discover that by submitting and reading a
  // form error. llmProvider is null when the health check itself couldn't
  // reach the service -- default to allowing the upload rather than
  // guessing, same as before this check existed.
  const pdfDisabled = llmProvider === "azure-openai";

  return (
    <form action={formAction} encType="multipart/form-data" className="space-y-4 border-t border-border p-4">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/50">Education context</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-foreground/60">
            Education stage
            <select
              name="educationStage"
              required
              className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            >
              <option value="secondary">Secondary</option>
              <option value="senior_secondary">Senior secondary</option>
              <option value="undergraduate">Undergraduate</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground/60">
            Grade / year (e.g. &quot;10&quot;, &quot;UG-2&quot;)
            <input name="gradeOrYear" required className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground/60">
            Curriculum source type
            <select
              name="curriculumSourceType"
              required
              className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            >
              <option value="school_board">School board</option>
              <option value="university_program">University program</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground/60">
            Curriculum source name (e.g. &quot;CBSE&quot;, &quot;Anna University B.Tech CSE&quot;)
            <input
              name="curriculumSourceName"
              required
              className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground/60">
            Country / region (optional)
            <input name="countryOrRegion" className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground/60">
            Subject / course
            <input name="subjectOrCourse" required className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground/60">
            Program / stream (optional)
            <input name="programOrStream" className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-foreground/60">
            <input type="checkbox" name="taxonomySupplied" className="h-4 w-4" />A curriculum taxonomy is available for
            this source
          </label>
        </div>
        <label className="mt-3 flex flex-col gap-1 text-xs text-foreground/60">
          Curriculum taxonomy text (optional — leave blank to use a saved taxonomy for this curriculum source, if one
          exists; see &quot;Curriculum taxonomies&quot; above)
          <textarea
            name="curriculumTaxonomyText"
            rows={3}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          />
        </label>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/50">Input</h3>
        <label className="mt-2 flex flex-col gap-1 text-xs text-foreground/60">
          Input kind
          <select
            name="inputKind"
            required
            className="w-fit rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="raw_papers">Raw paper text (Stage 0 segments it)</option>
            <option value="pre_segmented">Already-segmented questions (JSON)</option>
          </select>
        </label>

        <p className="mt-3 text-xs text-foreground/40">
          Fill in ONE of the two sections below, matching your chosen input kind.
        </p>

        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <input
            name="paperSubject"
            placeholder="Paper subject (defaults to subject/course above)"
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          />
          <input
            name="paperYear"
            type="number"
            placeholder="Paper year, e.g. 2023"
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          />
          <input
            name="paperBoard"
            placeholder="Paper board/institution name (defaults to curriculum source name)"
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          />
          <input
            name="paperClass"
            placeholder="Paper class/level label (defaults to grade/year above)"
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          />
          <input
            name="paperSetCode"
            placeholder="Set code (optional)"
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          />
          <input
            name="paperSourceUrl"
            placeholder="Source URL (optional)"
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          />
          <select
            name="paperType"
            defaultValue="board_exam"
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="board_exam">Board exam</option>
            <option value="sample_paper">Sample paper</option>
            <option value="compartment">Compartment</option>
          </select>
          <select
            name="extractionMethod"
            defaultValue="native_text"
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="native_text">Native text</option>
            <option value="ocr">OCR</option>
          </select>
        </div>
        <textarea
          name="rawText"
          rows={8}
          placeholder="Paste the raw extracted paper text here (for input kind: raw paper text)"
          className="mt-2 w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-xs"
        />
        <label className="mt-2 flex flex-col gap-1 text-xs text-foreground/60">
          {pdfDisabled ? (
            <>
              PDF upload isn&apos;t available — this service is currently running on Azure OpenAI, which has no
              equivalent to Anthropic&apos;s native PDF reading. Extract the text yourself and paste it above instead.
            </>
          ) : (
            <>
              Or upload the paper as a PDF instead of pasting text above (input kind: raw paper text) — Stage 0 reads
              it directly, including scanned/photographed papers with no text layer at all. Up to 15MB.
            </>
          )}
          <input
            type="file"
            name="paperPdf"
            accept="application/pdf"
            disabled={pdfDisabled}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground file:mr-2 file:rounded-md file:border-0 file:bg-brand/10 file:px-2 file:py-1 file:text-xs file:font-medium file:text-brand disabled:cursor-not-allowed disabled:opacity-50"
          />
        </label>

        <textarea
          name="preSegmentedJson"
          rows={8}
          placeholder='Or paste a JSON array of already-segmented questions here (for input kind: already-segmented). Each object needs at least question_id, raw_text, cleaned_text.'
          className="mt-3 w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-xs"
        />
      </div>

      <button
        disabled={pending}
        className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
      >
        {pending ? "Submitting…" : "Submit run"}
      </button>
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
    </form>
  );
}
