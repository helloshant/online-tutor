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
  // `from` names an actual point for an angle between two drawn rays (e.g.
  // the ladder's right angle). `fromHorizontal: true` is the alternative
  // for an elevation/depression angle, where one ray is an *implied*
  // horizontal at the vertex's own height rather than a point the problem
  // actually names -- `from` is ignored in that case, since diagram.tsx
  // computes that ray itself (always exactly horizontal in already-scaled
  // pixel space, by construction). This exists because the natural-language
  // instruction to "add a helper point at the vertex's own height" was
  // observed, twice, reusing a nearby scene point instead (e.g. a tower's
  // base standing in for the observer's own horizontal) -- collapsing both
  // angles down to a couple of degrees, since that reused point is nearly
  // straight down from the vertex, not off to the side. A boolean flag
  // removes the model's chance to get the coordinate math wrong entirely,
  // the same reason every other geometric computation here (scaling, arc
  // sweep direction, right-angle boxes) already lives in diagram.tsx and
  // not in the model's own numbers.
  angles?: { at: string; from?: string; to: string; label?: string; rightAngle?: boolean; fromHorizontal?: boolean }[];
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
  // Strict, all-or-nothing -- deliberately reverted from an earlier,
  // more lenient version that skipped an individual bad point (or
  // segment/angle) and rendered whatever was left. Requested explicitly:
  // a diagram silently missing a point it should have shown is worse than
  // no diagram at all, since a student has no way to tell "this was never
  // part of the problem" apart from "this failed to render." One
  // malformed point -- most often the model writing an unknown's name
  // (e.g. "h", the very thing a problem is solving for) into a coordinate
  // field; diagram-text.tsx's sanitizer turns that into null before this
  // ever runs, but null still isn't a valid coordinate -- now rejects the
  // WHOLE diagram, not just that point.
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

    // First pass: which "to" targets are already legitimately spoken for
    // at each vertex, considering only entries that are valid on their own
    // (a self-referential "to" doesn't count as claiming anything). Used
    // below to recover a broken angle's target when it's unambiguous --
    // kept even under the stricter all-or-nothing policy above, since a
    // mechanically-deduced target makes that angle fully correct, not
    // merely present-but-incomplete; it's a repair, not a partial result.
    const usedTargetsByVertex = new Map<string, Set<string>>();
    for (const entry of raw.angles) {
      if (typeof entry !== "object" || entry === null) continue;
      const { at, to } = entry as Record<string, unknown>;
      if (typeof at !== "string" || typeof to !== "string") continue;
      if (!labels.has(at) || !labels.has(to) || to === at) continue;
      if (!usedTargetsByVertex.has(at)) usedTargetsByVertex.set(at, new Set());
      usedTargetsByVertex.get(at)!.add(to);
    }

    const parsedAngles: NonNullable<GeometrySpec["angles"]> = [];
    // Strict again, same reasoning as points/segments above: one malformed
    // angle now rejects the whole diagram rather than being dropped with
    // everything else left standing.
    for (const a of raw.angles) {
      if (typeof a !== "object" || a === null) return null;
      const { at, from, to: rawTo, label, rightAngle, fromHorizontal } = a as Record<string, unknown>;
      if (typeof at !== "string" || typeof rawTo !== "string") return null;
      if (!labels.has(at) || !labels.has(rawTo)) return null;

      let to = rawTo;
      if (to === at) {
        // "to" naming the SAME point as "at" gives a zero-length ray --
        // not fixable by the collinear-angle fallback in diagram.tsx,
        // since that only ever corrects the *direction* of "from", never
        // a ray that has no direction to correct in the first place.
        // Recoverable, though, for exactly this app's headline pattern:
        // two angles at one vertex to two OTHER points (a tower's top and
        // bottom) -- if there's exactly one point in the scene that isn't
        // the vertex and isn't already another angle's target here, that
        // is a mechanical deduction, not a guess among several
        // candidates, so use it instead of rejecting the diagram.
        const used = usedTargetsByVertex.get(at) ?? new Set<string>();
        const candidates = points.map((p) => p.label).filter((l) => l !== at && !used.has(l));
        if (candidates.length !== 1) return null; // ambiguous or no candidate -- don't guess, and don't show a partial diagram either
        to = candidates[0];
        used.add(to);
        usedTargetsByVertex.set(at, used);
      }
      const usesHorizontal = fromHorizontal === true;
      // `from` is still required (and must name a real, distinct point)
      // unless the horizontal ray is computed instead -- an angle needs
      // two rays one way or the other.
      if (!usesHorizontal && (typeof from !== "string" || !labels.has(from) || from === at)) return null;
      parsedAngles.push({
        at,
        from: typeof from === "string" && labels.has(from) ? from : undefined,
        to,
        label: isNonEmptyString(label, MAX_LABEL_LENGTH) ? label : undefined,
        rightAngle: rightAngle === true,
        fromHorizontal: usesHorizontal,
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

const MAX_TARGETS = 3;

function parseAngleDeg(raw: unknown): number | null {
  if (isFiniteNumber(raw)) return raw;
  if (typeof raw === "string") {
    const match = raw.match(/-?\d+(\.\d+)?/);
    if (match) {
      const n = Number(match[0]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// "angleFromHorizontal" -- a template, not a general shape -- exists
// because every single bug this app's diagram feature has ever had traced
// back to the same root: the model choosing its own point coordinates for
// an elevation/depression problem. A helper point reused from elsewhere in
// the scene, coordinates wildly out of proportion to the real numbers, a
// "to" that names the vertex itself -- five distinct real production
// failures, all upstream of anything diagram.tsx's rendering math could
// fix, because by the time a coordinate reaches the renderer the actual
// mistake has already happened.
//
// This input shape has NO coordinates at all -- only a vertex label, a
// direction, and each target's actual angle (as a number or a "30°"
// string) and label. parseAngleFromHorizontal computes every point's
// position itself via real trigonometry (tan of the given angle), so the
// arithmetic is guaranteed geometrically consistent with the labeled
// angle every time, not just usually. The OUTPUT is a plain GeometrySpec
// -- identical to what a hand-written [DIAGRAM] block already produces --
// so every downstream consumer (diagram.tsx's rendering, its collision
// avoidance, fromHorizontal support) needs no changes at all; only the
// INPUT shape recognized here is new. buildTutorSystemPrompt now teaches
// this as the preferred way to describe this specific, extremely common
// pattern, with the general "geometry" shape kept for anything else (a
// ladder against a wall, a general triangle) that doesn't fit it.
function parseAngleFromHorizontal(raw: Record<string, unknown>): GeometrySpec | null {
  const { vertexLabel, direction, targets: rawTargets, baseLabel, baseSegmentLabel, connectingSegmentLabel } = raw;
  if (!isNonEmptyString(vertexLabel, MAX_LABEL_LENGTH)) return null;
  if (direction !== "up" && direction !== "down") return null;
  if (!Array.isArray(rawTargets) || rawTargets.length < 1 || rawTargets.length > MAX_TARGETS) return null;

  const labels = new Set<string>([vertexLabel]);
  const targets: { label: string; angleDeg: number; segmentLabel?: string }[] = [];
  for (const t of rawTargets) {
    if (typeof t !== "object" || t === null) return null;
    const { label, angleDeg: rawAngle, segmentLabel } = t as Record<string, unknown>;
    if (!isNonEmptyString(label, MAX_LABEL_LENGTH) || labels.has(label)) return null;
    const angleDeg = parseAngleDeg(rawAngle);
    // Must be a real acute angle -- 0 or 90 (or anything past it) isn't a
    // meaningful elevation/depression angle and would degenerate the
    // trig below (a horizontal or vertical sight line).
    if (angleDeg === null || angleDeg <= 0 || angleDeg >= 90) return null;
    labels.add(label);
    targets.push({ label, angleDeg, segmentLabel: isNonEmptyString(segmentLabel, MAX_LABEL_LENGTH) ? segmentLabel : undefined });
  }

  // The vertex's own base -- e.g. the foot of the building it stands atop
  // -- only makes sense for a depression angle (an elevation angle's
  // vertex is already at ground level, so there's nothing below it to
  // draw), and only paired with a label for that segment (the building's
  // own height); a bare foot point with nothing labeling it isn't worth
  // the extra point.
  let baseLbl: string | undefined;
  if (baseLabel !== undefined) {
    if (direction !== "down") return null;
    if (!isNonEmptyString(baseLabel, MAX_LABEL_LENGTH) || labels.has(baseLabel)) return null;
    if (!isNonEmptyString(baseSegmentLabel, MAX_LABEL_LENGTH)) return null;
    baseLbl = baseLabel;
    labels.add(baseLbl);
  }

  // Fixed "nice" units, not real-world scale -- the model never supplies
  // (and this was never meant to convey) actual distances, only the
  // labeled angle values need to be geometrically real, and they are:
  // each target's y is computed directly from its own angleDeg via
  // tan(), not approximated or copied from an illustrative example.
  const VERTEX_Y = direction === "down" ? 100 : 0;
  const TARGET_X = 100;
  const sign = direction === "down" ? -1 : 1;

  const points: (DiagramPoint & { label: string })[] = [{ label: vertexLabel, x: 0, y: VERTEX_Y }];
  const segments: GeometrySpec["segments"] = [];
  const angles: NonNullable<GeometrySpec["angles"]> = [];

  for (const t of targets) {
    const y = VERTEX_Y + sign * TARGET_X * Math.tan((t.angleDeg * Math.PI) / 180);
    points.push({ label: t.label, x: TARGET_X, y });
    segments.push({ from: vertexLabel, to: t.label, label: t.segmentLabel });
    angles.push({ at: vertexLabel, to: t.label, fromHorizontal: true, label: `${t.angleDeg}°` });
  }

  // Consecutive targets connected in the order given -- the model lists
  // them in a sensible order (nearest to horizontal first is typical),
  // and this is only meaningful for exactly two targets (e.g. a tower's
  // top and bottom, both sighted from the same vertex).
  if (targets.length === 2 && isNonEmptyString(connectingSegmentLabel, MAX_LABEL_LENGTH)) {
    segments.push({ from: targets[0].label, to: targets[1].label, label: connectingSegmentLabel });
  }

  if (baseLbl) {
    points.push({ label: baseLbl, x: 0, y: 0 });
    segments.push({ from: vertexLabel, to: baseLbl, label: baseSegmentLabel as string });
  }

  return { type: "geometry", points, segments, angles, title: parseTitle(raw.title) };
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
    case "angleFromHorizontal":
      return parseAngleFromHorizontal(obj);
    case "graph":
      return parseGraph(obj);
    case "numberline":
      return parseNumberLine(obj);
    default:
      return null;
  }
}
