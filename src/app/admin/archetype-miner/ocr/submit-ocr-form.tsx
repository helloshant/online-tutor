"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { runOcrAction, segmentBookAction, type OcrState, type SegmentBookState } from "./actions";

const initialOcrState: OcrState = {};
const initialSegmentState: SegmentBookState = {};

export function SubmitOcrForm() {
  const [ocrState, ocrFormAction, ocrPending] = useActionState(runOcrAction, initialOcrState);
  const [segmentState, segmentFormAction, segmentPending] = useActionState(segmentBookAction, initialSegmentState);
  const [copied, setCopied] = useState(false);

  // The extracted-text box is editable (not just a read-only dump) so an
  // admin can fix an OCR misread before it's used for anything further --
  // matters more than it used to now that "further" can mean the chapter
  // splitter below, which matches chapter headings VERBATIM against
  // whatever is in this box at the moment it's clicked, so a corrected
  // heading here directly improves its odds of a clean match.
  const [text, setText] = useState("");
  // "Adjusting state when a prop changes" (react.dev), not
  // useState-inside-useEffect -- a fresh OCR run should replace whatever's
  // in the box even if the admin had started editing the previous run's
  // text, the same way a topic-id change resets pattern-picker's own
  // local state elsewhere in this app.
  const [lastOcrText, setLastOcrText] = useState<string | undefined>(undefined);
  if (ocrState.result && ocrState.result.text !== lastOcrText) {
    setLastOcrText(ocrState.result.text);
    setText(ocrState.result.text);
  }

  async function handleCopy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail (permissions, non-HTTPS context, etc.) --
      // the text is still right there selected in the textarea either way,
      // so this just isn't worth surfacing as an error of its own.
    }
  }

  function handleDownloadChunks() {
    if (!segmentState.result) return;
    const json = JSON.stringify({ chunks: segmentState.result.chunks }, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "book-chapters.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <form action={ocrFormAction} encType="multipart/form-data" className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Image(s) or PDF to OCR -- select several at once for a batch (e.g. a .docx&apos;s own embedded image
          fragments, extracted by hand, or a whole scanned book as one large PDF). Each file&apos;s text is labeled
          with its filename and kept in the order you selected them. Up to 75MB per file, 200 files max -- a large PDF
          is automatically split into page-range pieces under the hood, so one big book scan works the same as many
          small page images.
          <input
            type="file"
            name="ocrFile"
            multiple
            accept="application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png,image/webp,.webp,image/bmp,.bmp,image/tiff,.tiff,.tif,image/gif,.gif"
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground file:mr-2 file:rounded-md file:border-0 file:bg-brand/10 file:px-2 file:py-1 file:text-xs file:font-medium file:text-brand"
          />
        </label>
        <button
          disabled={ocrPending}
          className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
        >
          {ocrPending ? "Running OCR…" : "Run OCR"}
        </button>
        <p className="text-xs text-foreground/40">
          A batch of many files (or a large book PDF split into several page ranges) can take a while -- the button
          stays on &quot;Running OCR…&quot; the whole time, there is no separate progress indicator.
        </p>
      </form>

      {ocrState?.error && <p className="text-sm text-red-600">{ocrState.error}</p>}

      {ocrState?.result && (
        <div className="space-y-3">
          {ocrState.result.text && (
            <div className="rounded-xl border border-border bg-surface p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Extracted text</h2>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="rounded-lg border border-border px-3 py-1 text-xs font-medium text-foreground/70 hover:bg-brand/5"
                >
                  {copied ? "Copied!" : "Copy to clipboard"}
                </button>
              </div>
              <p className="mt-1 text-xs text-foreground/50">
                Review (and edit, if needed) before using it -- OCR isn&apos;t perfect, especially on a poor-quality
                scan. For a single paper, paste it into the raw-text field on the{" "}
                <Link href="/admin/archetype-miner" className="text-brand hover:underline">
                  submit-run form
                </Link>
                . For a whole book, use &quot;Split into chapters&quot; below instead.
              </p>
              <textarea
                rows={16}
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="mt-2 w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-xs"
              />
            </div>
          )}

          <div className="rounded-xl border border-border bg-surface">
            <h3 className="border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wide text-foreground/50">
              Per-file results ({ocrState.result.fileResults.filter((f) => f.ok).length}/{ocrState.result.fileResults.length}{" "}
              succeeded)
            </h3>
            <div className="divide-y divide-border">
              {ocrState.result.fileResults.map((f) => (
                <div key={f.fileName} className="flex items-center gap-2 px-4 py-2 text-sm">
                  <span className={f.ok ? "text-green-600" : "text-red-600"}>{f.ok ? "✓" : "✗"}</span>
                  <span className="font-mono text-xs">{f.fileName}</span>
                  {f.note && <span className="text-xs text-foreground/50">— {f.note}</span>}
                </div>
              ))}
            </div>
          </div>

          {text.trim() && (
            <div className="rounded-xl border border-border bg-surface p-4">
              <h2 className="text-sm font-semibold">Split into chapters</h2>
              <p className="mt-1 text-xs text-foreground/50">
                For a whole scanned book: finds each real chapter&apos;s starting point in the text above and splits
                it into one chunk per chapter, in the exact JSON shape the Chapter Notes admin page&apos;s own{" "}
                <Link href="/admin/chapter-notes" className="text-brand hover:underline">
                  Import chunks
                </Link>{" "}
                upload already expects -- download the file below, then upload it there (pick the book&apos;s
                board/grade/subject/medium and title on that page; this step never talks to the database itself).
                Uses whatever text is currently in the box above, so review/fix it first.
              </p>
              <form
                action={(formData) => {
                  formData.set("text", text);
                  segmentFormAction(formData);
                }}
                className="mt-2"
              >
                <button
                  disabled={segmentPending}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-brand/5 disabled:opacity-60"
                >
                  {segmentPending ? "Splitting…" : "Split into chapters"}
                </button>
              </form>

              {segmentState?.error && <p className="mt-2 text-sm text-red-600">{segmentState.error}</p>}

              {segmentState?.result && (
                <div className="mt-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-green-600">
                      Found {segmentState.result.chunks.length} chapter{segmentState.result.chunks.length === 1 ? "" : "s"}.
                    </p>
                    <button
                      type="button"
                      onClick={handleDownloadChunks}
                      className="rounded-lg bg-brand px-3 py-1 text-xs font-medium text-white hover:bg-brand-dark"
                    >
                      Download book-chapters.json
                    </button>
                  </div>
                  {segmentState.result.unresolved.length > 0 && (
                    <div className="space-y-1 text-xs text-amber-600">
                      <p>
                        Couldn&apos;t place {segmentState.result.unresolved.length} proposed chapter
                        {segmentState.result.unresolved.length === 1 ? "" : "s"} in the text -- they&apos;re not in
                        the download; that content stayed folded into whichever chapter surrounds it. The excerpt
                        shown is exactly what was searched for (verbatim, case-insensitive) and not found -- compare
                        it against the extracted text above to see why.
                      </p>
                      <ul className="space-y-0.5 pl-4">
                        {segmentState.result.unresolved.map((u, i) => (
                          <li key={i}>
                            <span className="font-medium">{u.chapterTitle}</span> -- searched for:{" "}
                            <span className="rounded bg-amber-500/10 px-1 py-0.5 font-mono">{u.heading}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <ol className="space-y-1 text-xs text-foreground/60">
                    {segmentState.result.chunks.map((c) => (
                      <li key={c.chapter_number}>
                        {c.chapter_number}. {c.chapter_title}{" "}
                        <span className="text-foreground/40">({c.text.length.toLocaleString()} characters)</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
