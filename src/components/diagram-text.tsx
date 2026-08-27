import { CitationText } from "@/components/citation-text";
import { Diagram } from "@/components/diagram";
import { parseDiagramSpec } from "@/lib/diagramSchema";

// buildTutorSystemPrompt's diagram rule asks the model to include an
// optional [DIAGRAM]{...json...}[/DIAGRAM] block within a step (or a plain
// reply) when a diagram would genuinely clarify it -- see diagramSchema.ts
// for why the model emits logical JSON data rather than raw SVG. This finds
// those blocks, parses + validates the JSON, and renders <Diagram> for a
// valid one; a malformed one (bad JSON, fails schema validation) is dropped
// silently to the student -- fully consumed, never shown as raw JSON text,
// and never blocks the rest of the message from rendering -- same
// fail-open posture as every other rendering layer in this pipeline, just
// with a console.warn left in so a failed attempt is still visible in
// devtools while this format is new enough to need real-world tuning (vs.
// nothing logged at all, which means the model never attempted one).
// Everything outside a matched block -- the overwhelming majority of
// replies, which never include a diagram at all -- passes straight through
// to CitationText unchanged.
const DIAGRAM_PATTERN = /\[DIAGRAM\]\s*([\s\S]*?)\s*\[\/DIAGRAM\]/g;

// A specific, recurring, real production mistake: the model writes an
// unknown's own name into a numeric field -- most often a coordinate whose
// value it doesn't actually know yet because it's the very thing the
// problem is solving for (e.g. {"label":"D","x":12,"y":h}, "h" being the
// tower height the steps below go on to calculate). A bare, unquoted
// identifier there isn't valid JSON at all, so JSON.parse throws before
// parseDiagramSpec's own per-field validation ever gets a chance to run.
// Rewriting a bare identifier (never `true`/`false`/`null`, which are
// legitimate unquoted JSON values) to `null` first makes the JSON itself
// always parseable, so the failure becomes an ordinary, expected
// isFiniteNumber rejection -- parseDiagramSpec then rejects the WHOLE
// diagram on it (see diagramSchema.ts: deliberately all-or-nothing, no
// partial diagram), the same outcome as any other malformed field, rather
// than a raw, uncaught JSON syntax error.
function sanitizeAlmostJson(raw: string): string {
  return raw.replace(/:(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)(?=[,}\]])/g, (match, pre, ident, post) => {
    if (ident === "true" || ident === "false" || ident === "null") return match;
    return `:${pre}null${post}`;
  });
}

// When a diagram fails to parse, also strips a trailing heading-only line
// (or a short run of them -- e.g. "### Geometry Setup:" immediately
// followed by an empty "#### " right before the [DIAGRAM] tag, both
// observed directly in production) from the text immediately preceding
// it. Such a heading exists only to introduce the diagram that's about to
// silently vanish; left behind, it reads as an obviously broken response
// (a heading with nothing under it) even though the rest of the reply is
// fine. Only ever strips a heading that's genuinely the LAST thing before
// the tag -- if there were any other prose under it already, this
// wouldn't match at the end of the string, so real content is never at
// risk of being removed by this.
const TRAILING_HEADING = /(?:^|\n)#{1,6}[ \t]*[^\n]*$/;
function stripOrphanedHeading(precedingText: string): string {
  let result = precedingText;
  for (;;) {
    // Trailing NEWLINES, not just spaces/tabs: stripping an empty heading
    // line (e.g. "#### " right before the tag) leaves a dangling blank
    // line behind it -- without also collapsing that, the next iteration's
    // match would need to find "#" as the literal last non-whitespace
    // character, but a blank line sits between it and the real heading
    // above ("### Geometry Setup:"), so a second, genuinely-orphaned
    // heading right above an already-removed one would go undetected.
    const trimmed = result.replace(/\s+$/, "");
    const match = trimmed.match(TRAILING_HEADING);
    if (!match || match.index === undefined) return result;
    result = trimmed.slice(0, match.index);
  }
}

export function DiagramText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of text.matchAll(DIAGRAM_PATTERN)) {
    const index = match.index ?? 0;

    let spec = null;
    try {
      spec = parseDiagramSpec(JSON.parse(sanitizeAlmostJson(match[1])));
    } catch {
      spec = null;
    }

    const precedingText = spec ? text.slice(lastIndex, index) : stripOrphanedHeading(text.slice(lastIndex, index));
    if (precedingText) {
      parts.push(<CitationText key={key++} text={precedingText} />);
    }
    if (spec) {
      parts.push(<Diagram key={key++} spec={spec} />);
    } else {
      // Diagnostic only, not user-facing -- the block itself is still
      // dropped silently either way (see below). Distinguishes "the model
      // never attempted a diagram here" (nothing logged) from "it tried and
      // the JSON/schema didn't validate" (logged, with the actual raw text
      // to inspect) while this format is still new enough to need that.
      console.warn("Dropped an unparseable [DIAGRAM] block:", match[1]);
    }
    // Whether or not it parsed, this block is fully consumed here -- a
    // malformed one is dropped silently rather than left for the text
    // renderer below to show as literal JSON.
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(<CitationText key={key++} text={text.slice(lastIndex)} />);
  }

  return <>{parts}</>;
}
