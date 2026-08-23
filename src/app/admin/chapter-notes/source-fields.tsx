import type { ChapterDocumentSourceType } from "@/lib/supabase/types";

// Shared by all three chapter_documents write surfaces (new/edit/bulk
// import) -- collapsed by default since "original, nothing to declare" is
// the intended common case (source_type defaults to that on the server side
// too, see readSourceFields in actions.ts) and the primary form shouldn't
// make every save stop to think about copyright. See
// 0032_chapter_document_provenance.sql and docs/content-authoring-guide.md
// for the policy this exists to make auditable.
const SOURCE_TYPE_OPTIONS: { value: ChapterDocumentSourceType; label: string }[] = [
  { value: "original", label: "Original -- own writing, no external source" },
  { value: "public_domain", label: "Public domain work (e.g. an old poem/story)" },
  { value: "cc_licensed", label: "CC-licensed (Wikipedia, OpenStax, ...)" },
  { value: "ncert_or_diksha", label: "NCERT or DIKSHA/NROER" },
  { value: "other", label: "Other -- explain in the note" },
];

export function SourceFields({
  defaultSourceType = "original",
  defaultSourceUrl,
  defaultSourceNote,
}: {
  defaultSourceType?: ChapterDocumentSourceType;
  defaultSourceUrl?: string | null;
  defaultSourceNote?: string | null;
}) {
  return (
    <details className="rounded-lg border border-border/60 bg-background/50 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-foreground/60 hover:text-foreground">
        Source (copyright provenance) -- see the content authoring guide
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-foreground/50">
          Only fill this in if you drew on something beyond your own understanding of the syllabus
          topic -- never a substitute for actually writing this in your own words. See{" "}
          <code className="rounded bg-brand/10 px-1 py-0.5">docs/content-authoring-guide.md</code>.
        </p>
        <select
          name="sourceType"
          defaultValue={defaultSourceType}
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
        >
          {SOURCE_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          name="sourceUrl"
          defaultValue={defaultSourceUrl ?? ""}
          placeholder="Source URL, if applicable (an NCERT page, a DIKSHA content id, ...)"
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
        />
        <input
          name="sourceNote"
          defaultValue={defaultSourceNote ?? ""}
          placeholder='Note, e.g. "CC-BY-SA, paraphrased and restructured, not reproduced"'
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
        />
      </div>
    </details>
  );
}
