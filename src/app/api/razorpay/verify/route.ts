import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyPaymentSignature } from "@/lib/razorpay";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const orderId = body?.razorpay_order_id;
  const paymentId = body?.razorpay_payment_id;
  const signature = body?.razorpay_signature;

  if (!orderId || !paymentId || !signature) {
    return NextResponse.json({ error: "Missing payment details" }, { status: 400 });
  }

  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("id, status, razorpay_order_id")
    .eq("user_id", user.id)
    .eq("status", "pending_payment")
    .maybeSingle();

  if (!subscription || subscription.razorpay_order_id !== orderId) {
    return NextResponse.json({ error: "No matching pending subscription" }, { status: 404 });
  }

  const isValid = verifyPaymentSignature({ orderId, paymentId, signature });
  if (!isValid) {
    return NextResponse.json({ error: "Payment signature verification failed" }, { status: 400 });
  }

  // Activation must bypass RLS (a user can never set their own subscription
  // to 'active') so it can only ever happen here, after signature
  // verification, using the service-role client.
  const admin = createAdminClient();
  const { error: updateError } = await admin
    .from("subscriptions")
    .update({
      status: "active",
      razorpay_payment_id: paymentId,
      activated_at: new Date().toISOString(),
    })
    .eq("id", subscription.id)
    .eq("status", "pending_payment");

  if (updateError) {
    return NextResponse.json({ error: "Could not activate subscription" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
