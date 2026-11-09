"use client";

import {
  buildDisplayItems,
  EXERCISE_TYPE_LABELS,
  SUBPART_LABELS,
} from "@/app/dashboard/practice-panel";
import type { Paper } from "@/app/dashboard/practice-panel";
import type { Paragraph as ParagraphType, TextRun as TextRunType } from "docx";

// Builds the practice-paper answer key as a real .docx (native text, not a
// rasterized image) and triggers a browser download. Reported directly:
// the earlier PDF export (html2canvas-pro + jspdf, snapshotting the
// rendered DOM) came out visibly blurry -- a canvas screenshot is
// inherently a fixed-resolution raster, and the paper's content is just
// text, so there's nothing to actually render as an image for. A .docx
// sidesteps that entirely: it's crisp at any zoom/print size because it's
// real text, and (unlike the pdf-lib-based receipt generator elsewhere in
// this app, Latin-only StandardFonts) Word's own fonts already cover
// Hindi/Bengali script with no extra work.
//
// Built straight from the paper's own structured data (same
// buildDisplayItems grouping practice-panel.tsx itself renders from), not
// by capturing any DOM -- there's no screenshot step needed for a text
// document. LaTeX delimiters in a question/answer's source text (handled
// visually by MathText's KaTeX rendering on screen) are left as plain
// text here: Word has no LaTeX renderer either, and the underlying text
// is still fully readable either way.
//
// docx is dynamically imported so it doesn't ship in the main bundle for
// the common case -- a student never sees the button that calls this at
// all. Only types are imported statically above (import type has no
// runtime cost).
export async function exportPaperToDocx(
  paper: Paper,
  answers: Map<string, string>,
  filename: string,
): Promise<void> {
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import("docx");

  function textRunsWithBreaks(text: string): TextRunType[] {
    // Stored question/answer text can carry internal line breaks (e.g. an
    // MCQ's own options, one per line) -- TextRun doesn't interpret "\n"
    // on its own, so each line after the first becomes its own run with
    // `break: 1` (a line break rendered before that run), the documented
    // docx pattern for a multi-line run.
    return text
      .split("\n")
      .map((line, i) => (i === 0 ? new TextRun(line) : new TextRun({ text: line, break: 1 })));
  }

  const children: ParagraphType[] = [
    new Paragraph({ text: "Mock Exam", heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: paper.chapters.join(", "), heading: HeadingLevel.HEADING_3 }),
    new Paragraph({ text: `Total: ${paper.totalMarks} marks` }),
    new Paragraph({ text: "" }),
  ];

  for (const item of buildDisplayItems(paper.questions)) {
    if (item.kind === "question") {
      const q = item.question;
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${item.number}. `, bold: true }),
            new TextRun({ text: `[${EXERCISE_TYPE_LABELS[q.type]}] `, bold: true, color: "666666" }),
            new TextRun({
              text: `(${q.marks} mark${q.marks === 1 ? "" : "s"}) `,
              italics: true,
              color: "666666",
            }),
            ...textRunsWithBreaks(q.question),
          ],
        }),
      );
      const answer = answers.get(q.id);
      if (answer) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: "Answer: ", bold: true }), ...textRunsWithBreaks(answer)],
          }),
        );
      }
      children.push(new Paragraph({ text: "" }));
    } else {
      const totalMarks = item.subparts.reduce((sum, sp) => sum + sp.marks, 0);
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${item.number}. `, bold: true }),
            new TextRun({ text: "[Case Study] ", bold: true, color: "666666" }),
            new TextRun({ text: `(${totalMarks} marks) `, italics: true, color: "666666" }),
            ...textRunsWithBreaks(item.scenario),
          ],
        }),
      );
      item.subparts.forEach((sp, i) => {
        children.push(
          new Paragraph({
            indent: { left: 360 },
            children: [
              new TextRun({ text: `${SUBPART_LABELS[i] ?? `(${i + 1})`} `, bold: true }),
              new TextRun({
                text: `(${sp.marks} mark${sp.marks === 1 ? "" : "s"}) `,
                italics: true,
                color: "666666",
              }),
              ...textRunsWithBreaks(sp.question),
            ],
          }),
        );
        const answer = answers.get(sp.id);
        if (answer) {
          children.push(
            new Paragraph({
              indent: { left: 360 },
              children: [new TextRun({ text: "Answer: ", bold: true }), ...textRunsWithBreaks(answer)],
            }),
          );
        }
      });
      children.push(new Paragraph({ text: "" }));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
