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

// Maps a logical (min..max) range onto (marginStart..viewSize - marginEnd),
// uniformly with the companion axis (via a shared `scale`) so shapes never
// get stretched -- a right angle drawn with a different x/y scale would no
// longer look like one, which would defeat the entire point of this being
// computed rather than left to the model.
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
  const xs = spec.points.map((p) => p.x);
  const ys = spec.points.map((p) => p.y);
  const { minX, maxX, minY, maxY } = boundingBox(xs, ys, false);
  const scale = sharedScale(minX, maxX, minY, maxY);
  const sx = makeScale(minX, maxX, VIEW_WIDTH, scale, false);
  // SVG y grows downward -- flip so a larger logical y renders higher, the
  // way a student expects "up" to read on paper.
  const sy = makeScale(minY, maxY, VIEW_HEIGHT, scale, true);

  const byLabel = new Map(spec.points.map((p) => [p.label, p]));
  const ANGLE_RADIUS = 16;
  // Rough "middle of the shape" in already-scaled SVG space -- just the
  // average of every point, not a true polygon centroid, but good enough
  // to reliably decide which side of a segment is "outward" for placing
  // that segment's length label clear of the shape's interior/fill.
  const centroid = {
    x: spec.points.reduce((sum, p) => sum + sx(p.x), 0) / spec.points.length,
    y: spec.points.reduce((sum, p) => sum + sy(p.y), 0) / spec.points.length,
  };
  const SEGMENT_LABEL_OFFSET = 12;

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
        const from = byLabel.get(a.from);
        const to = byLabel.get(a.to);
        if (!at || !from || !to) return null;
        const atX = sx(at.x);
        const atY = sy(at.y);
        const dir = (px: number, py: number) => {
          const dx = px - atX;
          const dy = py - atY;
          const len = Math.hypot(dx, dy) || 1;
          return { x: dx / len, y: dy / len };
        };
        const d1 = dir(sx(from.x), sy(from.y));
        const d2 = dir(sx(to.x), sy(to.y));
        if (a.rightAngle) {
          // Standard right-angle box notation: a small square corner formed
          // by stepping one unit along each ray, plus the corner between.
          const size = 9;
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
        const arcStart = { x: atX + d1.x * ANGLE_RADIUS, y: atY + d1.y * ANGLE_RADIUS };
        const arcEnd = { x: atX + d2.x * ANGLE_RADIUS, y: atY + d2.y * ANGLE_RADIUS };
        // Cross product sign decides sweep direction so the arc always
        // traces the actual (non-reflex) angle between the two rays.
        const cross = d1.x * d2.y - d1.y * d2.x;
        const sweep = cross > 0 ? 1 : 0;
        const labelPos = {
          x: atX + (d1.x + d2.x) * (ANGLE_RADIUS + 10),
          y: atY + (d1.y + d2.y) * (ANGLE_RADIUS + 10),
        };
        return (
          <g key={i}>
            <path
              d={`M ${arcStart.x} ${arcStart.y} A ${ANGLE_RADIUS} ${ANGLE_RADIUS} 0 0 ${sweep} ${arcEnd.x} ${arcEnd.y}`}
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
      {spec.points.map((p) => (
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
