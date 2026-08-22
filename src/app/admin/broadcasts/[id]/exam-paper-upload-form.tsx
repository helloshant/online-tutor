import { uploadExamPaper } from "../actions";

// Plain server-action form -- no client-side state needed for a multi-file
// upload with no live preview, so this doesn't need "use client" the way
// ExamQuestionForm/QuestionForm do for their own reset-on-success behavior.
export function ExamPaperUploadForm({ broadcastId }: { broadcastId: string }) {
  return (
    <form action={uploadExamPaper.bind(null, broadcastId)} className="flex flex-wrap items-center gap-2">
      <input
        type="file"
        name="files"
        multiple
        accept="image/jpeg,image/png,image/webp,application/pdf"
        required
        className="text-xs"
      />
      <button className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-dark">
        Upload
      </button>
      <p className="w-full text-xs text-foreground/50">
        One or more pages, as images or a PDF (up to 15MB each).
      </p>
    </form>
  );
}
