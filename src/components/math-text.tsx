"use client";

import katex from "katex";
import "katex/dist/katex.min.css";

// The tutor's replies (and generated summaries/exercises) routinely include
// LaTeX -- \( \sqrt{25} \), \[ \frac{1}{3} \], or $...$/$$...$$ -- since
// that's how an LLM naturally writes math. Rendered as plain text it shows
// up as literal backslashes and braces, which is what this exists to fix:
// split on the four common delimiter styles and render each math segment
// with KaTeX, leaving everything else as plain text.
const MATH_PATTERN = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g;

export function MathText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  // matchAll iterates its own internal copy of the regex rather than
  // mutating MATH_PATTERN's lastIndex, unlike a manual exec() loop -- safe
  // to call from render with a module-level pattern.
  for (const match of text.matchAll(MATH_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push(text.slice(lastIndex, index));
    }

    const displayLatex = match[1] ?? match[2];
    const inlineLatex = match[3] ?? match[4];
    const displayMode = displayLatex !== undefined;
    const html = katex.renderToString(displayLatex ?? inlineLatex ?? "", {
      throwOnError: false,
      displayMode,
    });

    parts.push(
      displayMode ? (
        <span key={key++} className="my-1 block" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <span key={key++} dangerouslySetInnerHTML={{ __html: html }} />
      )
    );

    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <>{parts}</>;
}
