import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateWalletTopupReceiptPdf } from "@/lib/receiptPdf";

// Every code path below must return through a Response -- this top-level
// catch is the backstop so an unexpected throw never reaches the client as
// an empty body. Same pattern as every other API route in this app.
export async function GET(request: Request, { params }: { params: Promise<{ topupId: string }> }) {
  try {
    return await handleGetReceipt(await params);
  } catch (err) {
    console.error("Unexpected error in GET /api/wallet/receipt/[topupId]:", err);
    return NextResponse.json({ error: "Could not generate receipt" }, { status: 500 });
  }
}

// Generated on-demand rather than stored -- the receipt is fully derived
// from the wallet_topups row (never anything client-supplied), so there's
// nothing to keep in sync by persisting a copy, and "saved in the user's
// account" is this page, downloadable anytime their recharge history is
// visible (see the new "Recharge history" section in src/app/account/
// page.tsx, which links here).
async function handleGetReceipt({ topupId }: { topupId: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Ordinary session client -- RLS already lets a student read their own
  // wallet_topups rows (0055_student_wallets.sql), so this both scopes the
  // lookup to the signed-in student AND is the authorization check: a
  // topupId belonging to someone else simply comes back empty.
  const { data: topup } = await supabase
    .from("wallet_topups")
    .select("id, amount_paise, tokens_credited, ccavenue_tracking_id, activated_at, status")
    .eq("id", topupId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!topup || topup.status !== "active") {
    return NextResponse.json({ error: "No completed recharge found" }, { status: 404 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", user.id)
    .single();

  const pdfBytes = await generateWalletTopupReceiptPdf(topup, {
    name: profile?.full_name ?? null,
    email: user.email ?? "",
  });

  return new Response(new Uint8Array(pdfBytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="receipt-${topup.id}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
