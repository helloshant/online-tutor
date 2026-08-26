import { MathText } from "@/components/math-text";
import { DiagramText } from "@/components/diagram-text";

// buildTutorSystemPrompt's rule 5 asks the model to wrap each distinct step
// of a multi-step solution as [STEP: <concept/rule this step applies>]...
// [/STEP], only for a problem that genuinely takes multiple steps -- a
// short factual answer has no step markers at all and falls straight
// through to DiagramText unchanged below. This finds those blocks and
// renders each one as its own visually distinct card labeled with the
// concept it's teaching, not just the raw arithmetic -- the point being
// that a student stuck on one step can see *which idea* it's using at a
// glance, not just reread the whole answer looking for it.
//
// Deliberately a step above DiagramText in the rendering stack (parses
// [STEP] blocks first, then hands each block's own text -- and any
// non-step text before/after them -- to DiagramText, which finds any
// [DIAGRAM] block before deferring the rest to CitationText, which in turn
// delegates non-citation text to MathText): each layer owns exactly one
// concern, so a step's content still gets full diagram/LaTeX/citation
// rendering for free, with nothing duplicated here.
const STEP_PATTERN = /\[STEP:\s*([^\]]+)\]\s*([\s\S]*?)\s*\[\/STEP\]/g;

type Segment = { kind: "text"; content: string } | { kind: "step"; title: string; content: string; number: number };

function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  let stepNumber = 0;

  for (const match of text.matchAll(STEP_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ kind: "text", content: text.slice(lastIndex, index) });
    }
    stepNumber += 1;
    segments.push({ kind: "step", title: match[1].trim(), content: match[2].trim(), number: stepNumber });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ kind: "text", content: text.slice(lastIndex) });
  }

  return segments;
}

export function WorkedSteps({ text }: { text: string }) {
  const segments = parseSegments(text);
  const hasSteps = segments.some((s) => s.kind === "step");

  // No step markers at all -- the overwhelmingly common case for a short
  // factual answer -- renders exactly as it always has, via DiagramText.
  if (!hasSteps) {
    return <DiagramText text={text} />;
  }

  return (
    <div className="space-y-2">
      {segments.map((segment, i) =>
        segment.kind === "text" ? (
          // Leading/trailing prose (a brief intro, the closing summary/
          // final answer) -- only rendered when non-blank, since a model
          // that opens straight into [STEP: ...] leaves nothing here.
          segment.content.trim() && (
            <p key={i} className="whitespace-pre-wrap">
              <DiagramText text={segment.content} />
            </p>
          )
        ) : (
          <div key={i} className="rounded-lg border border-border bg-background/60 p-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-brand">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand/10 text-[10px]">
                {segment.number}
              </span>
              {/* MathText, not the full DiagramText/CitationText stack --
                  a step title is a short concept label (e.g. "Isolate
                  \( h^2 \)"), never expected to carry a citation or a
                  diagram of its own, but it does routinely carry inline
                  LaTeX (observed in real output), which rendered as raw
                  text otherwise -- \( \), $ $ etc. showing up literally. */}
              <MathText text={segment.title} />
            </p>
            <div className="whitespace-pre-wrap text-sm">
              <DiagramText text={segment.content} />
            </div>
          </div>
        )
      )}
    </div>
  );
}
