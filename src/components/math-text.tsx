"use client";

import katex from "katex";
import "katex/dist/katex.min.css";

// The tutor's replies (and generated summaries/exercises) routinely include
// LaTeX -- \( \sqrt{25} \), \[ \frac{1}{3} \], or $...$/$$...$$ -- since
// that's how an LLM naturally writes math. Rendered as plain text it shows
// up as literal backslashes and braces, which is what this exists to fix:
// split on the four common delimiter styles and render each math segment
// with KaTeX. Everything else -- not just plain text -- goes through
// renderEmphasis below (markdown **bold**/*italic*) and, within that,
// renderCaretExponents (plain-text pseudo-math like x^-5), so a run of
// non-LaTeX text still gets its own formatting rather than showing raw
// markdown/caret syntax literally.
const MATH_PATTERN = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g;

// Bulk-imported textbook content (e.g. Ganit Prakash, see the Answer Bank's
// bulk import) is often transcribed as plain-text pseudo-math rather than
// LaTeX -- caret exponents like `x^(1/a)`, `x^-5`, or nested ones like
// `{(x^-5)^(2/3)}^(-3/10)` -- which the pass above never touches, since
// there's no \( \) or $ $ around it. This handles that one specific, common
// convention (not a general math-notation parser): render the exponent as
// a raised <sup>, no KaTeX involved.
//
// The base can be a plain alphanumeric run (`x`), or a single level of
// parens/braces/brackets (`(16)`, `{...}`, `[...]`) -- all three show up in
// this kind of problem, for roots, grouped terms, and nested exponents. The
// exponent can be wrapped the same way, or bare with an optional leading
// minus (`^a`, `^-5`).
//
// Both the matched base and exponent are run back through this same
// function recursively -- each is always strictly shorter than the full
// match (it excludes at least the `^` itself), so this always terminates --
// which is what lets a caret expression nested inside a parenthesized/
// braced/bracketed base or exponent get its own <sup> treatment too,
// instead of being swallowed as inert text once the outer expression
// matches. Already-correct Unicode superscripts (kᵃ, k⁰, ...) display fine
// on their own and simply don't match this pattern.
const CARET_BASE = "(?:[A-Za-z0-9]+|\\([^()\\n]*\\)|\\{[^{}\\n]*\\}|\\[[^\\[\\]\\n]*\\])";
const CARET_EXPONENT_PATTERN = new RegExp(
  `(${CARET_BASE})\\^(?:\\(([^()\\n]+)\\)|\\{([^{}\\n]+)\\}|\\[([^\\[\\]\\n]+)\\]|(-?[A-Za-z0-9]+))`,
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

    const base = match[1];
    const exponent = match[2] ?? match[3] ?? match[4] ?? match[5];
    parts.push(
      <span key={nextKey()}>
        {renderCaretExponents(base, nextKey)}
        <sup>{renderCaretExponents(exponent, nextKey)}</sup>
      </span>
    );

    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

// Basic markdown emphasis -- the model routinely writes **bold** and
// *italic*/_italic_ (standard for how LLMs are trained to write emphasis),
// which rendered as plain text just shows the literal asterisks/
// underscores instead of the emphasis they're meant to convey (observed in
// real chat output: "the **Pythagoras theorem**" showing its own asterisks).
// Not a general markdown parser -- no links, headings, code fences, lists,
// none of which show up in a short chat reply the way emphasis does -- just
// these two. Bold is checked before italic in the same pass (one combined
// alternation) so `**x**` is never first misread as two adjacent `*x*`
// italics. Each match's own inner text still goes through
// renderCaretExponents, so e.g. a bolded exponent expression keeps working.
const EMPHASIS_PATTERN = /\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|_([^_\n]+?)_/g;

function renderEmphasis(text: string, nextKey: () => number): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(EMPHASIS_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push(...renderCaretExponents(text.slice(lastIndex, index), nextKey));
    }

    const bold = match[1];
    const italic = match[2] ?? match[3];
    parts.push(
      bold !== undefined ? (
        <strong key={nextKey()}>{renderCaretExponents(bold, nextKey)}</strong>
      ) : (
        <em key={nextKey()}>{renderCaretExponents(italic ?? "", nextKey)}</em>
      )
    );

    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(...renderCaretExponents(text.slice(lastIndex), nextKey));
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
    const displayLatex = match[1] ?? match[2];
    const inlineLatex = match[3] ?? match[4];
    const displayMode = displayLatex !== undefined;

    let precedingText = text.slice(lastIndex, index);
    // A display equation renders as its own display:block box (KaTeX's
    // .katex-display, with its own CSS margin -- see globals.css) -- it
    // already forces a line break before/after itself in the layout. Any
    // whitespace immediately adjacent to it in the source text -- a
    // newline (very common: the model naturally writes
    // "...values:\n\[ ... \]\n...") or, after CitationText's
    // unwrapHardWrappedText has already turned that newline into a plain
    // space by the time it reaches here, just a space -- is therefore
    // redundant. Originally this only stripped a trailing/leading newline
    // specifically, which missed exactly that already-a-space case: a lone
    // space character sandwiched between two adjacent display:block spans
    // still forces its own anonymous block box under normal flow, with the
    // *same* full line-height as an actual line break -- confirmed by
    // tracing the real text through both transforms and measuring the
    // rendered gap before/after widening this to match any whitespace, not
    // only \n. Trimmed only immediately adjacent to the match, not deeper
    // into the surrounding text, so real prose further back is untouched.
    if (displayMode) {
      precedingText = precedingText.replace(/[ \t\n]+$/, "");
    }
    if (precedingText) {
      parts.push(...renderEmphasis(precedingText, nextKey));
    }

    const html = katex.renderToString(displayLatex ?? inlineLatex ?? "", {
      throwOnError: false,
      displayMode,
    });

    parts.push(
      displayMode ? (
        // overflow-x-auto rather than letting a wide equation (a fraction,
        // a system of equations, a long derivation step -- common in
        // bulk-imported textbook content) either get visually clipped or
        // force the whole page into horizontal scroll on a narrow phone;
        // this way only the equation itself scrolls, within its own box.
        <span
          key={nextKey()}
          className="my-1 block overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <span key={nextKey()} dangerouslySetInnerHTML={{ __html: html }} />
      )
    );

    let nextIndex = index + match[0].length;
    if (displayMode) {
      // Same reasoning, mirrored for whatever comes right after -- see
      // above.
      const rest = text.slice(nextIndex);
      const stripped = rest.replace(/^[ \t\n]+/, "");
      nextIndex += rest.length - stripped.length;
    }
    lastIndex = nextIndex;
  }

  if (lastIndex < text.length) {
    parts.push(...renderEmphasis(text.slice(lastIndex), nextKey));
  }

  return <>{parts}</>;
}
