"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";
import { runOcrAction, type OcrState } from "./actions";

const initialState: OcrState = {};

export function SubmitOcrForm() {
  const [state, formAction, pending] = useActionState(runOcrAction, initialState);
  const [copied, setCopied] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  async function handleCopy() {
    const value = textRef.current?.value ?? "";
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail (permissions, non-HTTPS context, etc.) --
      // the text is still right there selected in the textarea either way,
      // so this just isn't worth surfacing as an error of its own.
    }
  }

  return (
    <div className="space-y-4">
      <form action={formAction} encType="multipart/form-data" className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Image(s) or PDF to OCR -- select several at once for a batch (e.g. a .docx&apos;s own embedded image
          fragments, extracted by hand). Each file&apos;s text is labeled with its filename and kept in the order you
          selected them. Up to 20MB per file, 200 files max.
          <input
            type="file"
            name="ocrFile"
            multiple
            accept="application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png,image/webp,.webp,image/bmp,.bmp,image/tiff,.tiff,.tif,image/gif,.gif"
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground file:mr-2 file:rounded-md file:border-0 file:bg-brand/10 file:px-2 file:py-1 file:text-xs file:font-medium file:text-brand"
          />
        </label>
        <button
          disabled={pending}
          className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
        >
          {pending ? "Running OCR…" : "Run OCR"}
        </button>
        <p className="text-xs text-foreground/40">
          A batch of many files can take a while (several files are processed at once, but each still has to make a
          real request) -- the button stays on &quot;Running OCR…&quot; the whole time, there is no separate progress
          indicator.
        </p>
      </form>

      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}

      {state?.result && (
        <div className="space-y-3">
          {state.result.text && (
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
                Review this before using it -- OCR isn&apos;t perfect, especially on a poor-quality scan. Paste it into
                the raw-text field on the{" "}
                <Link href="/admin/archetype-miner" className="text-brand hover:underline">
                  submit-run form
                </Link>{" "}
                once you&apos;re satisfied with it.
              </p>
              <textarea
                ref={textRef}
                readOnly
                rows={16}
                defaultValue={state.result.text}
                className="mt-2 w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-xs"
              />
            </div>
          )}

          <div className="rounded-xl border border-border bg-surface">
            <h3 className="border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wide text-foreground/50">
              Per-file results ({state.result.fileResults.filter((f) => f.ok).length}/{state.result.fileResults.length}{" "}
              succeeded)
            </h3>
            <div className="divide-y divide-border">
              {state.result.fileResults.map((f) => (
                <div key={f.fileName} className="flex items-center gap-2 px-4 py-2 text-sm">
                  <span className={f.ok ? "text-green-600" : "text-red-600"}>{f.ok ? "✓" : "✗"}</span>
                  <span className="font-mono text-xs">{f.fileName}</span>
                  {f.note && <span className="text-xs text-foreground/50">— {f.note}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
