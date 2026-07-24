import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPublicKeyId, getRazorpayClient } from "@/lib/razorpay";

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: subscription, error } = await supabase
    .from("subscriptions")
    .select("id, amount_paise, status, razorpay_order_id")
    .eq("user_id", user.id)
    .eq("status", "pending_payment")
    .maybeSingle();

  if (error || !subscription) {
    return NextResponse.json({ error: "No pending subscription found" }, { status: 404 });
  }
  if (!subscription.amount_paise || subscription.amount_paise <= 0) {
    return NextResponse.json({ error: "Invalid subscription amount" }, { status: 400 });
  }

  try {
    const razorpay = getRazorpayClient();
    const order = await razorpay.orders.create({
      amount: subscription.amount_paise,
      currency: "INR",
      receipt: subscription.id,
      notes: { subscription_id: subscription.id, user_id: user.id },
    });

    await supabase
      .from("subscriptions")
      .update({ razorpay_order_id: order.id })
      .eq("id", subscription.id);

    return NextResponse.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: getPublicKeyId(),
    });
  } catch {
    return NextResponse.json({ error: "Could not create payment order" }, { status: 502 });
  }
}
