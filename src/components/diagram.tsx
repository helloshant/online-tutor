import type { DiagramSpec, GeometrySpec, GraphSpec, NumberLineSpec } from "@/lib/diagramSchema";

// Renders an already-validated DiagramSpec (see diagramSchema.ts -- nothing
// here trusts unvalidated input, that's parseDiagramSpec's job) as plain
// SVG. The model only ever supplies logical coordinates (point positions,
// which points a segment connects) -- every pixel/scaling/angle-arc
// computation below is this component's own job, which is what guarantees
// a "right angle" always actually looks like one and every diagram shares
// this app's exact theme colors, regardless of how precise the model's own
// numbers were.
const VIEW_WIDTH = 300;
const VIEW_HEIGHT = 200;
const MARGIN = 26;

// Standard "nice round number" tick-step algorithm (1/2/5 * a power of 10)
// -- used for both the graph axes and the number line, so ticks land on
// numbers a student would actually expect (1, 2, 5, 10, ...), not an
// arbitrary fraction of the range.
function niceStep(range: number, maxTicks = 7): number {
  if (range <= 0) return 1;
  const rough = range / maxTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const residual = rough / magnitude;
  const niceResidual = residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1;
  return niceResidual * magnitude;
}

// Maps a logical (min..max) range onto (marginStart..viewSize - marginEnd)
// at the given `scale` -- always the SAME value on both axes (see
// sharedScale below), so shapes don't get stretched and a right angle
// still looks like one. Any degenerate-aspect-ratio correction happens
// earlier, on the logical coordinates themselves (see
// proportionalPoints) -- never here, since scaling x and y differently
// would corrupt every angle computed from these already-scaled pixel
// positions (an actual regression hit once: it separated two overlapping
// point labels, but also visually collapsed a real 30°/60° angle pair
// down to two unreadable slivers, since dir() below measures direction in
// this function's *output* space).
function makeScale(min: number, max: number, viewSize: number, scale: number, flip: boolean) {
  const usable = viewSize - 2 * MARGIN;
  const center = (min + max) / 2;
  const rangeSpan = usable / scale;
  const start = center - rangeSpan / 2;
  return (v: number) => {
    const t = (v - start) / rangeSpan;
    return flip ? viewSize - MARGIN - t * usable : MARGIN + t * usable;
  };
}

function boundingBox(xs: number[], ys: number[], includeOrigin: boolean) {
  const allX = includeOrigin ? [...xs, 0] : xs;
  const allY = includeOrigin ? [...ys, 0] : ys;
  let minX = Math.min(...allX);
  let maxX = Math.max(...allX);
  let minY = Math.min(...allY);
  let maxY = Math.max(...allY);
  // A single point, or every point sharing an x/y, would otherwise divide
  // by a zero-width range -- pad out to a sensible minimum span instead.
  if (maxX - minX < 1) {
    minX -= 1;
    maxX += 1;
  }
  if (maxY - minY < 1) {
    minY -= 1;
    maxY += 1;
  }
  // 12% breathing room on every side so a point/label at the very edge of
  // the data isn't clipped against the diagram's own border.
  const padX = (maxX - minX) * 0.12;
  const padY = (maxY - minY) * 0.12;
  return { minX: minX - padX, maxX: maxX + padX, minY: minY - padY, maxY: maxY + padY };
}

function sharedScale(minX: number, maxX: number, minY: number, maxY: number) {
  const usableW = VIEW_WIDTH - 2 * MARGIN;
  const usableH = VIEW_HEIGHT - 2 * MARGIN;
  return Math.min(usableW / (maxX - minX), usableH / (maxY - minY));
}

// The model's coordinates are logical units it's told not to worry about
// the precision of -- and it routinely reuses the prompt's own small
// illustrative helper-point offsets even when the problem's real distances
// are much larger on the other axis (observed directly: a building/tower
// depression diagram with a tiny horizontal offset next to vertical
// distances in the tens of units). Uniform scaling then ties the short
// axis's scale to whatever the long axis needs, collapsing it to a sliver
// a few pixels wide -- overlapping point labels, and (tried once, reverted)
// NOT safely fixable by scaling x/y differently at the pixel-mapping step,
// since every angle arc below is computed from direction vectors in that
// same pixel space and a non-uniform scale visibly distorts them.
//
// Fixed further upstream instead: widen the degenerate axis's LOGICAL
// spread before any scaling happens, so the single shared scale above
// still applies uniformly afterward -- everything downstream (segments,
// angle arcs, right-angle boxes) stays exactly as geometrically consistent
// as it was before this ever ran. This does mean an arc's drawn angle is
// only an approximation of the real one once it kicks in (same as the
// segment lengths already are -- the model's coordinates were never exact
// to begin with, and the actual value is always given via the segment/
// angle's own "label" text, never read off the drawing) -- a fair trade
// for a diagram that's actually legible instead of a collapsed sliver.
// Below `maxSkew`, this is a complete no-op (the common case, already
// reasonably proportioned, is untouched).
function proportionalPoints<P extends { x: number; y: number }>(points: P[]): P[] {
  if (points.length < 2) return points;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const xRange = maxX - minX;
  const yRange = maxY - minY;
  if (xRange <= 0 || yRange <= 0) return points;
  const maxSkew = 4;
  if (Math.max(xRange, yRange) / Math.min(xRange, yRange) <= maxSkew) return points;
  if (xRange < yRange) {
    const factor = yRange / maxSkew / xRange;
    const centerX = (minX + maxX) / 2;
    return points.map((p) => ({ ...p, x: centerX + (p.x - centerX) * factor }));
  }
  const factor = xRange / maxSkew / yRange;
  const centerY = (minY + maxY) / 2;
  return points.map((p) => ({ ...p, y: centerY + (p.y - centerY) * factor }));
}

function DiagramFrame({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <figure className="my-0.5 max-w-full">
      {/* w-full with a percentage-based min, not a small fixed max-w-[...]px
          -- a fixed pixel cap has no relationship to how wide the chat
          window actually is, which is exactly what made this look "too
          small" regardless of screen size. The diagram's own container
          (the step card) is already unconstrained up to the chat bubble's
          own width (max-w-[80%] of the panel, see chat-panel.tsx), so
          letting this genuinely fill it -- with min-w-[50%] as a floor for
          a narrower container -- comfortably clears "at least half the
          chat window" in the normal case instead of being held back. */}
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        className="h-auto w-full min-w-[50%] rounded-lg border border-border bg-background/40"
        role="img"
        aria-label={title ?? "Diagram"}
      >
        {children}
      </svg>
      {title && <figcaption className="mt-0.5 text-center text-xs text-foreground/50">{title}</figcaption>}
    </figure>
  );
}

function GeometryDiagram({ spec }: { spec: GeometrySpec }) {
  const points = proportionalPoints(spec.points);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const { minX, maxX, minY, maxY } = boundingBox(xs, ys, false);
  const scale = sharedScale(minX, maxX, minY, maxY);
  const sx = makeScale(minX, maxX, VIEW_WIDTH, scale, false);
  // SVG y grows downward -- flip so a larger logical y renders higher, the
  // way a student expects "up" to read on paper.
  const sy = makeScale(minY, maxY, VIEW_HEIGHT, scale, true);

  const byLabel = new Map(points.map((p) => [p.label, p]));
  const ANGLE_RADIUS = 16;
  // Rough "middle of the shape" in already-scaled SVG space -- just the
  // average of every point, not a true polygon centroid, but good enough
  // to reliably decide which side of a segment is "outward" for placing
  // that segment's length label clear of the shape's interior/fill.
  const centroid = {
    x: points.reduce((sum, p) => sum + sx(p.x), 0) / points.length,
    y: points.reduce((sum, p) => sum + sy(p.y), 0) / points.length,
  };
  const SEGMENT_LABEL_OFFSET = 12;
  // Mutated during the angles .map() below, in iteration order -- same
  // pattern as the `key` counters elsewhere in this codebase (e.g.
  // math-text.tsx's nextKey()); tracks how many angles at each vertex have
  // already been drawn, so a repeat gets pushed onto a larger radius.
  const angleOccurrenceAtVertex = new Map<string, number>();

  return (
    <DiagramFrame title={spec.title}>
      {spec.shadeRegion && (
        <polygon
          points={spec.shadeRegion.map((l) => byLabel.get(l)).filter(Boolean).map((p) => `${sx(p!.x)},${sy(p!.y)}`).join(" ")}
          style={{ fill: "var(--brand)", opacity: 0.08 }}
        />
      )}
      {spec.segments.map((s, i) => {
        const from = byLabel.get(s.from);
        const to = byLabel.get(s.to);
        if (!from || !to) return null;
        const x1 = sx(from.x);
        const y1 = sy(from.y);
        const x2 = sx(to.x);
        const y2 = sy(to.y);
        let labelPos: { x: number; y: number } | null = null;
        if (s.label) {
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;
          const dx = x2 - x1;
          const dy = y2 - y1;
          const len = Math.hypot(dx, dy) || 1;
          // Perpendicular to the segment, then flipped if it happens to
          // point toward the shape's centroid, so the label always lands
          // outside the shape rather than overlapping its fill/other edges.
          let px = -dy / len;
          let py = dx / len;
          if (px * (centroid.x - midX) + py * (centroid.y - midY) > 0) {
            px = -px;
            py = -py;
          }
          labelPos = { x: midX + px * SEGMENT_LABEL_OFFSET, y: midY + py * SEGMENT_LABEL_OFFSET };
        }
        return (
          <g key={i}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} style={{ stroke: "var(--foreground)" }} strokeWidth={1.5} />
            {labelPos && (
              <text x={labelPos.x} y={labelPos.y} fontSize={10} textAnchor="middle" style={{ fill: "var(--foreground)" }}>
                {s.label}
              </text>
            )}
          </g>
        );
      })}
      {spec.angles?.map((a, i) => {
        const at = byLabel.get(a.at);
        const from = a.fromHorizontal ? undefined : byLabel.get(a.from ?? "");
        const to = byLabel.get(a.to);
        if (!at || !to || (!a.fromHorizontal && !from)) return null;
        // The classic pair this feature exists for -- two angles of
        // elevation/depression measured from the same point (e.g. a
        // building's top, to a tower's top and bottom) -- share a vertex
        // AND one ray, so at a single fixed radius their arcs and labels
        // land on top of each other (observed directly: two overlapping
        // degree labels unreadable as one). Stagger each additional angle
        // at the same vertex onto a larger radius so they render as
        // concentric arcs instead.
        const occurrence = angleOccurrenceAtVertex.get(a.at) ?? 0;
        angleOccurrenceAtVertex.set(a.at, occurrence + 1);
        const radius = ANGLE_RADIUS + occurrence * 11;
        const atX = sx(at.x);
        const atY = sy(at.y);
        const dir = (px: number, py: number) => {
          const dx = px - atX;
          const dy = py - atY;
          const len = Math.hypot(dx, dy) || 1;
          return { x: dx / len, y: dy / len };
        };
        // A pure (±1, 0) unit vector in already-scaled pixel space --
        // horizontal by construction regardless of the model's own
        // coordinates -- pointed toward whichever side "to" is actually on,
        // so the angle opens up on the same side as the ray it's paired
        // with rather than an arbitrary fixed direction. Used directly for
        // fromHorizontal, and also as a fallback below for a non-horizontal
        // "from" that turns out to be nearly collinear with "to".
        const horizontalDir = { x: sx(to.x) - atX >= 0 ? 1 : -1, y: 0 };
        const d2 = dir(sx(to.x), sy(to.y));
        let usesHorizontal = a.fromHorizontal === true;
        let d1 = usesHorizontal ? horizontalDir : dir(sx(from!.x), sy(from!.y));
        if (!usesHorizontal) {
          // Defense in depth against a real, repeated failure mode: a
          // depression/elevation angle where the model supplied a "from"
          // point that's nearly in the same direction as "to" (seen
          // directly in production output: reusing a target's own base
          // point as the reference instead of the horizontal, collapsing
          // the angle to only a few degrees regardless of its label). A
          // labeled angle this small is never what a school-level geometry
          // problem is actually illustrating -- rather than render an
          // unreadable sliver, silently fall back to the same computed
          // horizontal fromHorizontal uses. Harmless for a genuinely
          // intended small angle (there isn't one in practice at this
          // level) and for every ordinary case (right angles, the ladder's
          // 20-70°-ish angles), which stay far above this threshold.
          const dot = d1.x * d2.x + d1.y * d2.y;
          const cross = d1.x * d2.y - d1.y * d2.x;
          const angleDeg = (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
          // 20°, not a stricter cutoff: verified directly against the exact
          // JSON pulled from production (see the commit this threshold
          // shipped in) that one of the two mislabeled angles there
          // computed to ~13.6° post-stretch -- comfortably "collapsed" by
          // any reasonable eyeball test, but above a naively tight cutoff
          // like 10°. A single 20° threshold catches both without risking
          // a legitimately-intended small angle at this app's level (this
          // feature has no example, real or in the prompt, of an
          // intentionally-drawn arc under 20°).
          if (angleDeg < 20 && !a.rightAngle) {
            d1 = horizontalDir;
            usesHorizontal = true;
          }
        }
        // A short dashed stub showing the implied horizontal itself --
        // without it there'd be nothing on screen explaining what the arc
        // below is measured from, since (unlike the `from`-point case)
        // there's no drawn segment along this ray. Rendered here and
        // folded into the shared arc/right-angle-box rendering below via a
        // fragment, rather than duplicating that rendering for this case.
        const horizontalStub = usesHorizontal ? (
          <line
            x1={atX}
            y1={atY}
            x2={atX + d1.x * (radius + 14)}
            y2={atY}
            style={{ stroke: "var(--foreground)" }}
            strokeWidth={1}
            strokeDasharray="3 2"
            opacity={0.5}
          />
        ) : null;
        if (a.rightAngle) {
          // Standard right-angle box notation: a small square corner formed
          // by stepping one unit along each ray, plus the corner between.
          const size = 9 + occurrence * 4;
          const p1 = { x: atX + d1.x * size, y: atY + d1.y * size };
          const p2 = { x: atX + d1.x * size + d2.x * size, y: atY + d1.y * size + d2.y * size };
          const p3 = { x: atX + d2.x * size, y: atY + d2.y * size };
          return (
            <polyline
              key={i}
              points={`${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`}
              fill="none"
              style={{ stroke: "var(--foreground)" }}
              strokeWidth={1.25}
            />
          );
        }
        const arcStart = { x: atX + d1.x * radius, y: atY + d1.y * radius };
        const arcEnd = { x: atX + d2.x * radius, y: atY + d2.y * radius };
        // Cross product sign decides sweep direction so the arc always
        // traces the actual (non-reflex) angle between the two rays.
        const cross = d1.x * d2.y - d1.y * d2.x;
        const sweep = cross > 0 ? 1 : 0;
        // Grows faster with occurrence than the arc radius itself
        // (radius+12, +10 more per repeat) -- observed directly: two
        // shared-vertex angles whose "to" rays are close together (as an
        // elevation/depression pair usually is) have nearly the same
        // bisector direction, so radial distance is the only thing that
        // can keep their labels apart; matching the arcs' own tighter
        // stagger left both labels, and a nearby point label, crowded
        // into the same few pixels.
        const labelDistance = radius + 12 + occurrence * 10;
        const labelPos = {
          x: atX + (d1.x + d2.x) * labelDistance,
          y: atY + (d1.y + d2.y) * labelDistance,
        };
        return (
          <g key={i}>
            {horizontalStub}
            <path
              d={`M ${arcStart.x} ${arcStart.y} A ${radius} ${radius} 0 0 ${sweep} ${arcEnd.x} ${arcEnd.y}`}
              fill="none"
              style={{ stroke: "var(--brand)" }}
              strokeWidth={1.25}
            />
            {a.label && (
              <text x={labelPos.x} y={labelPos.y} fontSize={9} textAnchor="middle" style={{ fill: "var(--brand)" }}>
                {a.label}
              </text>
            )}
          </g>
        );
      })}
      {points.map((p) => (
        <g key={p.label}>
          <circle cx={sx(p.x)} cy={sy(p.y)} r={2.5} style={{ fill: "var(--foreground)" }} />
          <text x={sx(p.x) + 6} y={sy(p.y) - 6} fontSize={11} style={{ fill: "var(--foreground)" }}>
            {p.label}
          </text>
        </g>
      ))}
    </DiagramFrame>
  );
}

function GraphDiagram({ spec }: { spec: GraphSpec }) {
  const allPoints = [...(spec.points ?? []), ...(spec.lines ?? []).flatMap((l) => l.points)];
  const xs = allPoints.map((p) => p.x);
  const ys = allPoints.map((p) => p.y);
  const { minX, maxX, minY, maxY } = boundingBox(xs, ys, true);
  const scale = sharedScale(minX, maxX, minY, maxY);
  const sx = makeScale(minX, maxX, VIEW_WIDTH, scale, false);
  const sy = makeScale(minY, maxY, VIEW_HEIGHT, scale, true);

  const stepX = niceStep(maxX - minX);
  const stepY = niceStep(maxY - minY);
  const xTicks: number[] = [];
  for (let v = Math.ceil(minX / stepX) * stepX; v <= maxX; v += stepX) xTicks.push(Math.round(v * 1e6) / 1e6);
  const yTicks: number[] = [];
  for (let v = Math.ceil(minY / stepY) * stepY; v <= maxY; v += stepY) yTicks.push(Math.round(v * 1e6) / 1e6);

  return (
    <DiagramFrame title={spec.title}>
      {/* Axes through the origin (always in view -- boundingBox above forces it). */}
      <line x1={MARGIN} y1={sy(0)} x2={VIEW_WIDTH - MARGIN} y2={sy(0)} style={{ stroke: "var(--border)" }} strokeWidth={1.25} />
      <line x1={sx(0)} y1={MARGIN} x2={sx(0)} y2={VIEW_HEIGHT - MARGIN} style={{ stroke: "var(--border)" }} strokeWidth={1.25} />
      {xTicks.map((v) => (
        <g key={`x${v}`}>
          <line x1={sx(v)} y1={sy(0) - 2} x2={sx(v)} y2={sy(0) + 2} style={{ stroke: "var(--border)" }} />
          {v !== 0 && (
            <text x={sx(v)} y={sy(0) + 12} fontSize={8} textAnchor="middle" style={{ fill: "var(--foreground)", opacity: 0.6 }}>
              {v}
            </text>
          )}
        </g>
      ))}
      {yTicks.map((v) => (
        <g key={`y${v}`}>
          <line x1={sx(0) - 2} y1={sy(v)} x2={sx(0) + 2} y2={sy(v)} style={{ stroke: "var(--border)" }} />
          {v !== 0 && (
            <text x={sx(0) - 5} y={sy(v) + 3} fontSize={8} textAnchor="end" style={{ fill: "var(--foreground)", opacity: 0.6 }}>
              {v}
            </text>
          )}
        </g>
      ))}
      {spec.lines?.map((l, i) => (
        <polyline
          key={i}
          points={l.points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")}
          fill="none"
          style={{ stroke: "var(--brand)" }}
          strokeWidth={1.5}
        />
      ))}
      {spec.points?.map((p, i) => (
        <g key={i}>
          <circle cx={sx(p.x)} cy={sy(p.y)} r={2.5} style={{ fill: "var(--brand)" }} />
          {p.label && (
            <text x={sx(p.x) + 6} y={sy(p.y) - 6} fontSize={11} style={{ fill: "var(--foreground)" }}>
              {p.label}
            </text>
          )}
        </g>
      ))}
    </DiagramFrame>
  );
}

function NumberLineDiagram({ spec }: { spec: NumberLineSpec }) {
  const [from, to] = spec.range;
  const y = VIEW_HEIGHT / 2;
  const sx = (v: number) => MARGIN + ((v - from) / (to - from)) * (VIEW_WIDTH - 2 * MARGIN);
  const step = niceStep(to - from);
  const ticks: number[] = [];
  for (let v = Math.ceil(from / step) * step; v <= to; v += step) ticks.push(Math.round(v * 1e6) / 1e6);

  return (
    <DiagramFrame title={spec.title}>
      {spec.highlight?.map((h, i) => (
        <rect
          key={i}
          x={sx(Math.max(h.from, from))}
          y={y - 6}
          width={Math.max(0, sx(Math.min(h.to, to)) - sx(Math.max(h.from, from)))}
          height={12}
          style={{ fill: "var(--brand)", opacity: 0.15 }}
        />
      ))}
      <line x1={sx(from)} y1={y} x2={sx(to)} y2={y} style={{ stroke: "var(--foreground)" }} strokeWidth={1.5} />
      {ticks.map((v) => (
        <g key={v}>
          <line x1={sx(v)} y1={y - 4} x2={sx(v)} y2={y + 4} style={{ stroke: "var(--foreground)" }} />
          <text x={sx(v)} y={y + 16} fontSize={8} textAnchor="middle" style={{ fill: "var(--foreground)", opacity: 0.7 }}>
            {v}
          </text>
        </g>
      ))}
      {spec.points?.map((p, i) => (
        <g key={i}>
          <circle cx={sx(p.value)} cy={y} r={3} style={{ fill: "var(--brand)" }} />
          {p.label && (
            <text x={sx(p.value)} y={y - 10} fontSize={10} textAnchor="middle" style={{ fill: "var(--foreground)" }}>
              {p.label}
            </text>
          )}
        </g>
      ))}
    </DiagramFrame>
  );
}

export function Diagram({ spec }: { spec: DiagramSpec }) {
  switch (spec.type) {
    case "geometry":
      return <GeometryDiagram spec={spec} />;
    case "graph":
      return <GraphDiagram spec={spec} />;
    case "numberline":
      return <NumberLineDiagram spec={spec} />;
  }
}
