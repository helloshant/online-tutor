import "server-only";

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { WalletTopup } from "@/lib/supabase/types";
import { baseAmountPaiseFromCharge } from "@/lib/walletPricing";

const RUPEE_FORMATTER = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function rupees(paise: number): string {
  return `Rs. ${RUPEE_FORMATTER.format(paise / 100)}`;
}

type DrawOptions = { size?: number; bold?: boolean; color?: [number, number, number] };

// Generates a one-page PDF receipt for a single COMPLETED wallet recharge
// (caller is responsible for only calling this on a topup with
// status: "active" -- see src/app/api/wallet/receipt/[topupId]/route.ts,
// which is the only caller and already enforces that). amount_paise on the
// row is the GST-inclusive charge actually collected (see GST_RATE's own
// comment in walletPricing.ts); the base/GST split shown here is reverse-
// derived from it with the same exact-integer formula the payment service
// itself validates against, not a separate guess.
export async function generateWalletTopupReceiptPdf(
  topup: Pick<WalletTopup, "id" | "amount_paise" | "tokens_credited" | "ccavenue_tracking_id" | "activated_at">,
  payer: { name: string | null; email: string },
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const margin = 56;
  const pageWidth = page.getWidth();
  let y = page.getHeight() - margin;

  // Draws a line of text and moves the cursor down by its own line height --
  // every line on this receipt goes through here or drawRow below, so y
  // only ever advances in one place.
  function line(value: string, options: DrawOptions = {}) {
    const size = options.size ?? 11;
    page.drawText(value, {
      x: margin,
      y,
      size,
      font: options.bold ? boldFont : font,
      color: rgb(...(options.color ?? [0.1, 0.1, 0.1])),
    });
    y -= size * 1.6;
  }

  // Draws a label flush left and a value flush right on the SAME line, then
  // advances the cursor once -- used for every line-item/total row so the
  // left and right halves never drift out of sync with each other.
  function drawRow(label: string, value: string, options: DrawOptions = {}) {
    const size = options.size ?? 11;
    const labelFont = options.bold ? boldFont : font;
    page.drawText(label, { x: margin, y, size, font: labelFont, color: rgb(...(options.color ?? [0.1, 0.1, 0.1])) });
    const valueWidth = labelFont.widthOfTextAtSize(value, size);
    page.drawText(value, {
      x: pageWidth - margin - valueWidth,
      y,
      size,
      font: labelFont,
      color: rgb(...(options.color ?? [0.1, 0.1, 0.1])),
    });
    y -= size * 1.6;
  }

  function hr() {
    y -= 4;
    page.drawLine({
      start: { x: margin, y },
      end: { x: pageWidth - margin, y },
      thickness: 1,
      color: rgb(0.85, 0.85, 0.85),
    });
    y -= 12;
  }

  line("SyllabusMate", { size: 20, bold: true, color: [0.14, 0.39, 0.92] });
  line("Payment Receipt", { size: 12, color: [0.4, 0.4, 0.4] });
  y -= 10;

  const activatedAt = topup.activated_at ? new Date(topup.activated_at) : new Date();
  const dateLabel = activatedAt.toLocaleDateString("en-IN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  line(`Receipt No: ${topup.id}`, { size: 10, color: [0.4, 0.4, 0.4] });
  line(`Date: ${dateLabel}`, { size: 10, color: [0.4, 0.4, 0.4] });
  hr();

  line("Billed to", { size: 10, bold: true, color: [0.4, 0.4, 0.4] });
  line(payer.name ?? payer.email, { size: 12 });
  line(payer.email, { size: 11, color: [0.3, 0.3, 0.3] });
  y -= 16;

  const baseAmountPaise = baseAmountPaiseFromCharge(topup.amount_paise);
  const gstPaise = topup.amount_paise - baseAmountPaise;

  drawRow("Description", "Amount", { size: 10, bold: true, color: [0.4, 0.4, 0.4] });
  hr();

  drawRow(`Wallet recharge -- ${topup.tokens_credited.toLocaleString()} tokens`, rupees(baseAmountPaise));
  drawRow("GST (18%)", rupees(gstPaise));
  hr();

  drawRow("Total paid", rupees(topup.amount_paise), { size: 13, bold: true });
  y -= 24;

  line(`Tokens credited: ${topup.tokens_credited.toLocaleString()}`, { size: 11 });
  if (topup.ccavenue_tracking_id) {
    line(`Payment reference: ${topup.ccavenue_tracking_id}`, { size: 10, color: [0.4, 0.4, 0.4] });
  }
  line("Payment status: Paid", { size: 10, color: [0.1, 0.55, 0.25] });

  y -= 24;
  line("This is a system-generated receipt and does not require a signature.", {
    size: 9,
    color: [0.55, 0.55, 0.55],
  });

  return pdfDoc.save();
}
