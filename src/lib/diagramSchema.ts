// Minimal, deliberately narrow vocabulary for diagrams a chat reply can
// include inline (see buildTutorSystemPrompt's diagram rule and
// DiagramText/Diagram) -- NOT a general graphics language, just enough for
// geometry, coordinate graphs, and number lines. The model emits logical
// data (point coordinates, which points a segment connects) rather than raw
// SVG or pixel coordinates -- diagram.tsx does all the actual geometry/
// scaling math itself, which is what makes a "right angle" always actually
// render as one regardless of whether the model's own numbers are exact,
// and keeps every diagram visually consistent with the rest of the app
// (theme colors via CSS custom properties) instead of trusting arbitrary
// LLM-generated markup, which would also be a real XSS surface if rendered
// via dangerouslySetInnerHTML the way raw SVG would have to be.
//
// Untrusted input (LLM output) -- parseDiagramSpec validates thoroughly and
// returns null on anything malformed, undersized/oversized, or referencing
// an unknown point label, rather than throwing. Callers (DiagramText) treat
// null exactly like "no diagram here": the [DIAGRAM] block is dropped
// silently, never shown as raw JSON, and never blocks the rest of the
// message from rendering.

export type DiagramPoint = { label?: string; x: number; y: number };

export type GeometrySpec = {
  type: "geometry";
  points: (DiagramPoint & { label: string })[];
  // `label` here is a segment's own known length/name (e.g. "5 m", "13 m")
  // -- distinct from a *point's* label (its name, "A"/"B"/"C") -- so the
  // model has somewhere to put the actual measurements a word problem
  // gives, not just the abstract shape. Observed missing in real output
  // before this field existed: a diagram with no way to show 5 m/12 m/13 m
  // is a shape, not a worked illustration of the specific problem.
  segments: { from: string; to: string; label?: string }[];
  angles?: { at: string; from: string; to: string; label?: string; rightAngle?: boolean }[];
  shadeRegion?: string[];
  title?: string;
};

export type GraphSpec = {
  type: "graph";
  points?: DiagramPoint[];
  lines?: { points: { x: number; y: number }[]; label?: string }[];
  title?: string;
};

export type NumberLineSpec = {
  type: "numberline";
  range: [number, number];
  points?: { value: number; label?: string }[];
  highlight?: { from: number; to: number }[];
  title?: string;
};

export type DiagramSpec = GeometrySpec | GraphSpec | NumberLineSpec;

// Generous enough for anything a school-level problem actually needs, tight
// enough that a malformed/runaway response can't produce an unreasonably
// large or slow-to-render diagram.
const MAX_POINTS = 12;
const MAX_SEGMENTS = 20;
const MAX_ANGLES = 6;
const MAX_LINES = 4;
const MAX_LINE_POINTS = 50;
const MAX_HIGHLIGHTS = 4;
const MAX_TITLE_LENGTH = 80;
const MAX_LABEL_LENGTH = 24;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown, maxLength: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= maxLength;
}

function parseTitle(raw: unknown): string | undefined {
  return isNonEmptyString(raw, MAX_TITLE_LENGTH) ? raw : undefined;
}

function parseGeometry(raw: Record<string, unknown>): GeometrySpec | null {
  if (!Array.isArray(raw.points) || raw.points.length === 0 || raw.points.length > MAX_POINTS) return null;
  const points: (DiagramPoint & { label: string })[] = [];
  const labels = new Set<string>();
  for (const p of raw.points) {
    if (typeof p !== "object" || p === null) return null;
    const { label, x, y } = p as Record<string, unknown>;
    if (!isNonEmptyString(label, MAX_LABEL_LENGTH) || !isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    if (labels.has(label)) return null; // duplicate point label -- ambiguous, reject rather than guess
    labels.add(label);
    points.push({ label, x, y });
  }

  if (!Array.isArray(raw.segments) || raw.segments.length > MAX_SEGMENTS) return null;
  const segments: GeometrySpec["segments"] = [];
  for (const s of raw.segments) {
    if (typeof s !== "object" || s === null) return null;
    const { from, to, label } = s as Record<string, unknown>;
    if (typeof from !== "string" || typeof to !== "string" || !labels.has(from) || !labels.has(to)) return null;
    segments.push({ from, to, label: isNonEmptyString(label, MAX_LABEL_LENGTH) ? label : undefined });
  }

  let angles: GeometrySpec["angles"];
  if (raw.angles !== undefined) {
    if (!Array.isArray(raw.angles) || raw.angles.length > MAX_ANGLES) return null;
    const parsedAngles: NonNullable<GeometrySpec["angles"]> = [];
    for (const a of raw.angles) {
      if (typeof a !== "object" || a === null) return null;
      const { at, from, to, label, rightAngle } = a as Record<string, unknown>;
      if (typeof at !== "string" || typeof from !== "string" || typeof to !== "string") return null;
      if (!labels.has(at) || !labels.has(from) || !labels.has(to)) return null;
      parsedAngles.push({
        at,
        from,
        to,
        label: isNonEmptyString(label, MAX_LABEL_LENGTH) ? label : undefined,
        rightAngle: rightAngle === true,
      });
    }
    angles = parsedAngles;
  }

  let shadeRegion: string[] | undefined;
  if (raw.shadeRegion !== undefined) {
    const region = raw.shadeRegion;
    if (!Array.isArray(region) || region.length < 3 || region.length > MAX_POINTS) return null;
    if (!region.every((l) => typeof l === "string" && labels.has(l))) return null;
    shadeRegion = region as string[];
  }

  return { type: "geometry", points, segments, angles, shadeRegion, title: parseTitle(raw.title) };
}

function parsePoints(raw: unknown): DiagramPoint[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_POINTS) return null;
  const points: DiagramPoint[] = [];
  for (const p of raw) {
    if (typeof p !== "object" || p === null) return null;
    const { label, x, y } = p as Record<string, unknown>;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    points.push({ x, y, label: isNonEmptyString(label, MAX_LABEL_LENGTH) ? label : undefined });
  }
  return points;
}

function parseGraph(raw: Record<string, unknown>): GraphSpec | null {
  let points: DiagramPoint[] | undefined;
  if (raw.points !== undefined) {
    const parsed = parsePoints(raw.points);
    if (!parsed) return null;
    points = parsed;
  }

  let lines: GraphSpec["lines"];
  if (raw.lines !== undefined) {
    if (!Array.isArray(raw.lines) || raw.lines.length > MAX_LINES) return null;
    const parsedLines: NonNullable<GraphSpec["lines"]> = [];
    for (const l of raw.lines) {
      if (typeof l !== "object" || l === null) return null;
      const { points: linePoints, label } = l as Record<string, unknown>;
      if (!Array.isArray(linePoints) || linePoints.length < 2 || linePoints.length > MAX_LINE_POINTS) return null;
      const parsedLinePoints: { x: number; y: number }[] = [];
      for (const p of linePoints) {
        if (typeof p !== "object" || p === null) return null;
        const { x, y } = p as Record<string, unknown>;
        if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
        parsedLinePoints.push({ x, y });
      }
      parsedLines.push({ points: parsedLinePoints, label: isNonEmptyString(label, MAX_LABEL_LENGTH) ? label : undefined });
    }
    lines = parsedLines;
  }

  if (!points?.length && !lines?.length) return null; // nothing to actually draw

  return { type: "graph", points, lines, title: parseTitle(raw.title) };
}

function parseNumberLine(raw: Record<string, unknown>): NumberLineSpec | null {
  if (!Array.isArray(raw.range) || raw.range.length !== 2) return null;
  const [from, to] = raw.range;
  if (!isFiniteNumber(from) || !isFiniteNumber(to) || from >= to) return null;

  let points: NumberLineSpec["points"];
  if (raw.points !== undefined) {
    if (!Array.isArray(raw.points) || raw.points.length > MAX_POINTS) return null;
    const parsedPoints: NonNullable<NumberLineSpec["points"]> = [];
    for (const p of raw.points) {
      if (typeof p !== "object" || p === null) return null;
      const { value, label } = p as Record<string, unknown>;
      if (!isFiniteNumber(value)) return null;
      parsedPoints.push({ value, label: isNonEmptyString(label, MAX_LABEL_LENGTH) ? label : undefined });
    }
    points = parsedPoints;
  }

  let highlight: NumberLineSpec["highlight"];
  if (raw.highlight !== undefined) {
    if (!Array.isArray(raw.highlight) || raw.highlight.length > MAX_HIGHLIGHTS) return null;
    const parsedHighlight: NonNullable<NumberLineSpec["highlight"]> = [];
    for (const h of raw.highlight) {
      if (typeof h !== "object" || h === null) return null;
      const { from: hFrom, to: hTo } = h as Record<string, unknown>;
      if (!isFiniteNumber(hFrom) || !isFiniteNumber(hTo)) return null;
      parsedHighlight.push({ from: hFrom, to: hTo });
    }
    highlight = parsedHighlight;
  }

  return { type: "numberline", range: [from, to], points, highlight, title: parseTitle(raw.title) };
}

export function parseDiagramSpec(raw: unknown): DiagramSpec | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  switch (obj.type) {
    case "geometry":
      return parseGeometry(obj);
    case "graph":
      return parseGraph(obj);
    case "numberline":
      return parseNumberLine(obj);
    default:
      return null;
  }
}
