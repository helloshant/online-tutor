import { CitationText } from "@/components/citation-text";
import { Diagram } from "@/components/diagram";
import { parseDiagramSpec } from "@/lib/diagramSchema";

// buildTutorSystemPrompt's diagram rule asks the model to include an
// optional [DIAGRAM]{...json...}[/DIAGRAM] block within a step (or a plain
// reply) when a diagram would genuinely clarify it -- see diagramSchema.ts
// for why the model emits logical JSON data rather than raw SVG. This finds
// those blocks, parses + validates the JSON, and renders <Diagram> for a
// valid one; a malformed one (bad JSON, fails schema validation) is dropped
// silently -- fully consumed, never shown as raw JSON text, and never
// blocks the rest of the message from rendering -- same fail-open posture
// as every other rendering layer in this pipeline. Everything outside a
// matched block -- the overwhelming majority of replies, which never
// include a diagram at all -- passes straight through to CitationText
// unchanged.
const DIAGRAM_PATTERN = /\[DIAGRAM\]\s*([\s\S]*?)\s*\[\/DIAGRAM\]/g;

export function DiagramText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of text.matchAll(DIAGRAM_PATTERN)) {
    const index = match.index ?? 0;

    let spec = null;
    try {
      spec = parseDiagramSpec(JSON.parse(match[1]));
    } catch {
      spec = null;
    }

    if (index > lastIndex) {
      parts.push(<CitationText key={key++} text={text.slice(lastIndex, index)} />);
    }
    if (spec) {
      parts.push(<Diagram key={key++} spec={spec} />);
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
