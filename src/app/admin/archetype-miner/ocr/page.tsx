import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { SubmitOcrForm } from "./submit-ocr-form";

export default async function ArchetypeOcrPage() {
  await requireAdminPage("archetype_miner");

  return (
    <div>
      <Link href="/admin/archetype-miner" className="text-sm text-brand hover:underline">
        ← Archetype Miner
      </Link>

      <h1 className="mt-4 text-xl font-semibold">OCR a scanned paper or book</h1>
      <p className="mt-1 max-w-3xl text-sm text-foreground/60">
        A standalone utility, separate from the pipeline itself -- extracts text from an image or PDF using Google
        Document AI, chosen specifically for its strong Devanagari/Hindi OCR support. Built for the case where
        neither the PDF path (Anthropic&apos;s native reading) nor the DOCX path (plain text extraction) can produce
        usable text -- most concretely, a scanned paper whose <code>.docx</code> conversion mangled its own
        Devanagari content beyond recovery. A large PDF (e.g. a whole scanned book) is automatically split into
        page-range pieces under the hood, so it works the same way as a short paper, just with more pages. Review
        the output here, then either paste it into the raw-text field on the{" "}
        <Link href="/admin/archetype-miner" className="text-brand hover:underline">
          submit-run form
        </Link>{" "}
        (a paper&apos;s worth of exam questions) or, for a whole book, use &quot;Split into chapters&quot; below to
        produce a file ready for the{" "}
        <Link href="/admin/chapter-notes" className="text-brand hover:underline">
          Chapter Notes
        </Link>{" "}
        page&apos;s own bulk import -- nothing here talks to either of those directly.
      </p>

      <div className="mt-6">
        <SubmitOcrForm />
      </div>
    </div>
  );
}
