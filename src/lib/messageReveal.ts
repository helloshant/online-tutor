// Drives the "free flow" reveal animation used for a freshly-arrived
// assistant reply (see chat-panel.tsx's AssistantMessageContent). The
// backend has no real token stream to ride -- /api/chat returns the
// complete reply in one response (see orchestratorClient.ts's plain
// `await res.json()`, and the orchestrator's own non-streaming provider
// calls) -- so this is a client-side pacing device over text that already
// fully exists, not a true stream. The point is purely to stop it landing
// as a single burst.
//
// The one real constraint: it must never reveal a PARTIAL [STEP: ...]...
// [/STEP] or [DIAGRAM]...[/DIAGRAM] block. Cutting mid-block would either
// show raw, un-rendered markup (the block's own regex in worked-steps.tsx /
// diagram-text.tsx only matches a COMPLETE block, so a half-revealed one
// falls through to plain text and briefly flashes its literal tag syntax)
// or, worse for a diagram specifically, risk being caught by
// parseDiagramSpec mid-JSON and logged as a dropped/invalid diagram when
// it was never actually malformed -- just not fully arrived yet. So a
// block is always revealed atomically: fully included once the reveal
// cursor reaches the END of its closing tag, not present at all before
// that.

const STEP_OPEN = "[STEP:";
const STEP_CLOSE = "[/STEP]";
const DIAGRAM_OPEN = "[DIAGRAM]";
const DIAGRAM_CLOSE = "[/DIAGRAM]";

type Chunk = { kind: "text"; value: string } | { kind: "block"; value: string };

// Mirrors the precedence WorkedSteps/DiagramText already apply when
// rendering (STEP scanned first, DIAGRAM only within/after) by always
// preferring whichever open marker occurs earliest -- a DIAGRAM block
// nested inside a STEP's own content is naturally swept up as part of that
// STEP's block here too, since we search for STEP_CLOSE starting after
// STEP_OPEN and DIAGRAM_CLOSE isn't STEP_CLOSE, so the scan runs straight
// through it. That means a step containing a diagram reveals as one
// atomic unit -- the step card and its diagram appear together, which is
// what WorkedSteps already treats as a single card anyway.
function splitIntoTopLevelChunks(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const stepIdx = text.indexOf(STEP_OPEN, cursor);
    const diagramIdx = text.indexOf(DIAGRAM_OPEN, cursor);

    let openIdx = -1;
    let open = "";
    let close = "";
    if (stepIdx !== -1 && (diagramIdx === -1 || stepIdx <= diagramIdx)) {
      openIdx = stepIdx;
      open = STEP_OPEN;
      close = STEP_CLOSE;
    } else if (diagramIdx !== -1) {
      openIdx = diagramIdx;
      open = DIAGRAM_OPEN;
      close = DIAGRAM_CLOSE;
    }

    if (openIdx === -1) {
      chunks.push({ kind: "text", value: text.slice(cursor) });
      break;
    }
    if (openIdx > cursor) {
      chunks.push({ kind: "text", value: text.slice(cursor, openIdx) });
    }

    const closeIdx = text.indexOf(close, openIdx + open.length);
    if (closeIdx === -1) {
      // Unterminated -- shouldn't happen since this only ever runs on the
      // complete, already-fully-arrived reply, but fail open rather than
      // drop the remainder of a real reply if a marker is ever unbalanced.
      chunks.push({ kind: "text", value: text.slice(openIdx) });
      break;
    }
    const blockEnd = closeIdx + close.length;
    chunks.push({ kind: "block", value: text.slice(openIdx, blockEnd) });
    cursor = blockEnd;
  }

  return chunks;
}

export type RevealUnit = { text: string; weight: number; atomic: boolean };

// Each unit is either one word (plus any trailing whitespace, so rejoining
// units never loses or adds spacing) with weight 1, or one entire STEP/
// DIAGRAM block with weight equal to its own word count -- so a block
// takes roughly as long to "arrive" as that much prose would, rather than
// popping in instantly regardless of size or hanging forever on a tiny one.
export function buildRevealUnits(text: string): RevealUnit[] {
  const units: RevealUnit[] = [];
  for (const chunk of splitIntoTopLevelChunks(text)) {
    if (chunk.kind === "block") {
      const wordCount = chunk.value.split(/\s+/).filter(Boolean).length;
      units.push({ text: chunk.value, weight: Math.max(1, wordCount), atomic: true });
      continue;
    }
    // Splits into "word + any trailing whitespace" or "pure whitespace"
    // tokens -- every cut point falls between units, on whitespace already
    // present in the original text, so joining any prefix of these units
    // back together exactly reproduces that prefix of the source text.
    const tokens = chunk.value.match(/\S+\s*|\s+/g) ?? [];
    for (const token of tokens) {
      units.push({ text: token, weight: 1, atomic: false });
    }
  }
  return units;
}

export function totalRevealWeight(units: RevealUnit[]): number {
  return units.reduce((sum, u) => sum + u.weight, 0);
}

// Builds the text visible once `revealedWeight` units' worth of the
// message have "arrived". An atomic (block) unit only ever appears once
// revealedWeight covers its FULL weight -- never partially -- and nothing
// after it is shown until it does, so the cursor effectively pauses at a
// pending diagram/step rather than skipping ahead of it.
export function buildRevealedText(units: RevealUnit[], revealedWeight: number): string {
  let consumed = 0;
  let out = "";
  for (const unit of units) {
    if (consumed + unit.weight > revealedWeight) break;
    out += unit.text;
    consumed += unit.weight;
  }
  return out;
}
