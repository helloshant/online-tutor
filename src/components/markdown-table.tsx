import { CitationText } from "@/components/citation-text";

// Reported directly: a reply laying out data as a table (e.g. standard
// trig ratios by angle) came back "jumbled" -- the model DOES write valid
// GFM pipe-table markdown (header row, a `|---|---|` separator row, body
// rows), but nothing in this rendering stack ever interpreted that syntax.
// It fell all the way through to CitationText/MathText as ordinary prose,
// which is worse than just leaving the pipes/dashes visible as literal
// text: CitationText's own unwrapHardWrappedText (see citation-text.tsx)
// collapses any single newline NOT part of a blank-line pair into a
// space -- exactly the newlines separating a table's own rows, since nothing
// about a markdown table involves blank lines between them -- so the whole
// table collapsed into one run-on line and then soft-wrapped at the bubble's
// width, landing text from unrelated columns/rows next to each other with
// no structure left to read it by. Pure prompt wording can't fix this on
// its own: even a perfectly-formatted pipe table is still just literal `|`
// and `-` characters to a viewer unless something turns it into an actual
// <table>, which is what this does.
//
// Slotted between DiagramText and CitationText in the rendering stack --
// same layering reasoning as DiagramText's own [DIAGRAM] blocks: find and
// extract the table block(s) FIRST, before CitationText's hard-wrap
// unwrapping ever gets a chance to eat their row-separating newlines, and
// hand everything else (unchanged) to CitationText exactly as before this
// existed.

// A GFM separator row: only `|`, `-`, `:`, and whitespace, with at least
// one dash somewhere (so a lone "-----" divider line the model sometimes
// writes on its own doesn't get misread as a table separator when there's
// no real header above it -- see the `headerLine.includes("|")` check
// below, which that alone doesn't fully guard against).
const SEPARATOR_LINE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

type Align = "left" | "right" | "center" | null;

function splitRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  // Real-world model output for this pattern never contains an escaped
  // `\|` inside a cell (it's numbers/short labels, not prose with literal
  // pipes) -- a plain split keeps this simple rather than handling a case
  // that doesn't come up.
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseAlign(separatorCell: string): Align {
  const t = separatorCell.trim();
  const left = t.startsWith(":");
  const right = t.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function alignClass(align: Align): string {
  return align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
}

function MarkdownTable({ header, aligns, rows }: { header: string[]; aligns: Align[]; rows: string[][] }) {
  return (
    <div className="my-2 overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-background/60">
            {header.map((cell, idx) => (
              <th key={idx} className={`border-b border-border px-3 py-1.5 font-semibold ${alignClass(aligns[idx])}`}>
                <CitationText text={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className={r % 2 === 1 ? "bg-background/30" : undefined}>
              {header.map((_, idx) => (
                <td key={idx} className={`border-b border-border/60 px-3 py-1.5 align-top ${alignClass(aligns[idx])}`}>
                  {/* A ragged row (model wrote fewer cells than the header)
                      renders its missing trailing cells empty rather than
                      dropping the whole table -- unlike a diagram, a table
                      cell carries no geometric claim that could be silently
                      wrong, just cosmetically incomplete, so failing open
                      here is the safer default, not a compromise. */}
                  <CitationText text={row[idx] ?? ""} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TableText({ text }: { text: string }) {
  const lines = text.split("\n");
  const parts: React.ReactNode[] = [];
  let key = 0;
  let proseStart = 0;
  let i = 0;

  const flushProse = (end: number) => {
    const chunk = lines.slice(proseStart, end).join("\n");
    if (chunk.trim()) parts.push(<CitationText key={key++} text={chunk} />);
  };

  while (i < lines.length) {
    const headerLine = lines[i];
    const separatorLine = lines[i + 1];
    if (
      separatorLine !== undefined &&
      headerLine.includes("|") &&
      separatorLine.includes("-") &&
      SEPARATOR_LINE.test(separatorLine)
    ) {
      flushProse(i);

      const header = splitRow(headerLine);
      const aligns = splitRow(separatorLine).map(parseAlign);

      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() !== "" && lines[j].includes("|")) {
        rows.push(splitRow(lines[j]));
        j++;
      }

      parts.push(<MarkdownTable key={key++} header={header} aligns={aligns} rows={rows} />);
      i = j;
      proseStart = j;
      continue;
    }
    i++;
  }
  flushProse(lines.length);

  return <>{parts}</>;
}
