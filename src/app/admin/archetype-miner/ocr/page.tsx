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

      <h1 className="mt-4 text-xl font-semibold">OCR a scanned paper</h1>
      <p className="mt-1 max-w-3xl text-sm text-foreground/60">
        A standalone utility, separate from the pipeline itself -- extracts text from an image or PDF using Google
        Document AI, chosen specifically for its strong Devanagari/Hindi OCR support. Built for the case where
        neither the PDF path (Anthropic&apos;s native reading) nor the DOCX path (plain text extraction) can produce
        usable text -- most concretely, a scanned paper whose <code>.docx</code> conversion mangled its own
        Devanagari content beyond recovery. Review the output here, then paste it into the raw-text field on the{" "}
        <Link href="/admin/archetype-miner" className="text-brand hover:underline">
          submit-run form
        </Link>{" "}
        yourself -- nothing here talks to the mining pipeline directly.
      </p>

      <div className="mt-6">
        <SubmitOcrForm />
      </div>
    </div>
  );
}
