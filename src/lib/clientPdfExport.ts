"use client";

// Snapshots a DOM node into a downloadable multi-page PDF, entirely in the
// browser. Used for the practice-paper answer-key export (practice-panel.tsx)
// -- deliberately NOT built on pdf-lib the way src/lib/receiptPdf.ts is:
// pdf-lib's StandardFonts are Latin-only and draw plain text, so they can't
// render LaTeX math (MathText's KaTeX output) or Hindi/Bengali script, both
// of which a practice paper's questions/answers routinely contain. Capturing
// the already-rendered DOM instead reuses the exact rendering the on-screen
// UI already proves correct, at the cost of producing a rasterized (not
// selectable/searchable) PDF.
//
// html2canvas/jspdf are dynamically imported so neither ships in the main
// bundle for the common case -- a student never sees the button that calls
// this at all.
export async function exportElementToPdf(
  element: HTMLElement,
  filename: string,
): Promise<void> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import("html2canvas"),
    import("jspdf"),
  ]);

  const canvas = await html2canvas(element, { scale: 2, useCORS: true });
  const imgData = canvas.toDataURL("image/png");

  const pdf = new jsPDF({ unit: "px", format: "a4" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const imgWidth = pageWidth;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;

  // Slices the one tall canvas across as many A4 pages as it takes, each
  // page drawing the same full image shifted up by one page-height --
  // the standard technique for a multi-page html2canvas+jspdf export. A
  // page break can occasionally fall mid-line; accepted as a cosmetic
  // trade-off rather than building real pagination-aware HTML layout.
  let heightLeft = imgHeight;
  let position = 0;
  pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
  heightLeft -= pageHeight;
  while (heightLeft > 0) {
    position -= pageHeight;
    pdf.addPage();
    pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
  }

  pdf.save(filename);
}
