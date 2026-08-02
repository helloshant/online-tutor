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

// Bulk-imported textbook content (e.g. Ganit Prakash, see the Answer Bank's
// bulk import) is often transcribed as plain-text pseudo-math rather than
// LaTeX -- caret exponents like `x^(1/a)`, `k^a`, or `(16)^(-3/2)` -- which
// the pass above never touches, since there's no \( \) or $ $ around it.
// This handles that one specific, common convention (not a general
// math-notation parser): render the exponent as a raised <sup>, no KaTeX
// involved. The base can be a plain alphanumeric run (`x`, `k`) or a single
// level of parentheses (`(16)`, `(⁵√8)`) -- the latter is needed for roots
// and grouped terms, which show up constantly in this exact kind of
// problem. Already-correct Unicode superscripts (kᵃ, k⁰, ...) display fine
// on their own and simply don't match this pattern.
const CARET_BASE = "(?:[A-Za-z0-9]+|\\([^()\\n]*\\))";
const CARET_EXPONENT_PATTERN = new RegExp(
  `(${CARET_BASE})\\^\\(([^()\\n]+)\\)|(${CARET_BASE})\\^([A-Za-z0-9]+)`,
  "g"
);

function renderCaretExponents(text: string, nextKey: () => number): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(CARET_EXPONENT_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push(text.slice(lastIndex, index));
    }

    const base = match[1] ?? match[3];
    const exponent = match[2] ?? match[4];
    parts.push(
      <span key={nextKey()}>
        {base}
        <sup>{exponent}</sup>
      </span>
    );

    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

export function MathText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  const nextKey = () => key++;

  // matchAll iterates its own internal copy of the regex rather than
  // mutating MATH_PATTERN's lastIndex, unlike a manual exec() loop -- safe
  // to call from render with a module-level pattern.
  for (const match of text.matchAll(MATH_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push(...renderCaretExponents(text.slice(lastIndex, index), nextKey));
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
        <span key={nextKey()} className="my-1 block" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <span key={nextKey()} dangerouslySetInnerHTML={{ __html: html }} />
      )
    );

    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(...renderCaretExponents(text.slice(lastIndex), nextKey));
  }

  return <>{parts}</>;
}
