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

export function CitationText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of text.matchAll(CITATION_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push(<MathText key={key++} text={text.slice(lastIndex, index)} />);
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

  if (lastIndex < text.length) {
    parts.push(<MathText key={key++} text={text.slice(lastIndex)} />);
  }

  return <>{parts}</>;
}
