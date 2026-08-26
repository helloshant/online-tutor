import { MathText } from "@/components/math-text";

// buildTutorSystemPrompt's rule 6 already asks the model to write
// "(Source: ...)" inline whenever it leans on chapter-notes RAG material --
// that instruction existed before this component did, but rendered as
// plain parenthetical text it's easy to miss entirely, which defeats the
// point: the citation is exactly what should let a student tell "this is
// grounded in my actual textbook" apart from "this is the model's own
// general knowledge," and that distinction is invisible if it doesn't look
// different from the rest of the sentence. This finds that same pattern and
// renders it as a small badge instead, everywhere else passed straight
// through MathText unchanged (a message with no citation in it renders
// identically to before).
const CITATION_PATTERN = /\(Source:\s*([^)]+)\)/g;

// Some model-generated prose (topic summaries especially, but not only
// those) comes back hard-wrapped -- a literal \n roughly every 60-80
// characters, mid-sentence, rather than only at real paragraph breaks.
// Every caller of CitationText renders with white-space: pre-wrap, so each
// of those is a forced line break the container's own width can never
// override -- observed directly in real output: a topic-summary card
// stretched to its actual full available width, with the paragraph inside
// it still wrapping at roughly half of that, because the text's own
// embedded newlines don't reflow with the container the way ordinary
// word-wrap would. Rejoins those before anything else runs: a single
// newline NOT part of a blank-line pair is a mid-paragraph wrap and gets
// replaced with a space (letting the paragraph reflow to its real
// container width); an actual blank line (a genuine paragraph break) is
// preserved as one. Safe to run before the citation/LaTeX passes below --
// neither [STEP]/[DIAGRAM] structural markers (already stripped by
// WorkedSteps/DiagramText before text ever reaches here) nor a citation's
// own parenthetical content depend on a literal newline surviving, and
// KaTeX doesn't distinguish a space from a newline within an expression.
function unwrapHardWrappedText(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n/g, " ").trim())
    .join("\n\n");
}

export function CitationText({ text }: { text: string }) {
  const unwrapped = unwrapHardWrappedText(text);
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of unwrapped.matchAll(CITATION_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push(<MathText key={key++} text={unwrapped.slice(lastIndex, index)} />);
    }
    parts.push(
      <span
        key={key++}
        className="mx-1 inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-brand/10 px-2 py-0.5 align-middle text-xs font-medium text-brand"
      >
        📖 {match[1].trim()}
      </span>
    );
    lastIndex = index + match[0].length;
  }

  if (lastIndex < unwrapped.length) {
    parts.push(<MathText key={key++} text={unwrapped.slice(lastIndex)} />);
  }

  return <>{parts}</>;
}
