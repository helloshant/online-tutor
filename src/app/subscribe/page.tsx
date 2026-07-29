import { redirect } from "next/navigation";
import { isStaff, requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PRICE_PER_SUBJECT_INR } from "@/lib/pricing";
import { CCAvenueCheckout } from "./ccavenue-checkout";
import { CouponForm } from "./coupon-form";

// Shown after CCAvenue redirects the browser back through
// /api/ccavenue/callback with a non-success outcome -- see that route for
// which value maps to which case.
const CALLBACK_ERROR_MESSAGES: Record<string, string> = {
  payment_failed: "Payment was not completed. You can try again below.",
  invalid_response: "Something went wrong reading the payment response. Please try again.",
  activation_failed: "Payment succeeded but we couldn't activate your subscription. Please contact support.",
};

export default async function SubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const { user, profile } = await requireUser();
  // Staff never pay -- if they somehow land here, send them straight in.
  if (isStaff(profile?.role)) redirect("/dashboard");

  const supabase = await createClient();

  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("id, status, medium, amount_paise, board_id, grade_id")
    .eq("user_id", user.id)
    .in("status", ["pending_payment", "active"])
    .maybeSingle();

  if (!subscription) redirect("/onboarding");
  if (subscription.status === "active") redirect("/dashboard");

  const [{ data: board }, { data: grade }, { data: subscriptionSubjects }] = await Promise.all([
    supabase.from("boards").select("name").eq("id", subscription.board_id).single(),
    supabase.from("grades").select("name").eq("id", subscription.grade_id).single(),
    supabase
      .from("subscription_subjects")
      .select("subjects(name)")
      .eq("subscription_id", subscription.id),
  ]);

  const subjectNames = (subscriptionSubjects ?? [])
    .map((row) => (row as unknown as { subjects: { name: string } | null }).subjects?.name)
    .filter((name): name is string => Boolean(name));

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">Complete your subscription</h1>
        <p className="mt-1 text-sm text-foreground/60">One last step before you can start asking questions.</p>

        {error && CALLBACK_ERROR_MESSAGES[error] && (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {CALLBACK_ERROR_MESSAGES[error]}
          </p>
        )}

        <dl className="mt-6 space-y-3 text-sm">
          <div className="flex justify-between border-b border-border pb-2">
            <dt className="text-foreground/60">Board</dt>
            <dd className="font-medium">{board?.name}</dd>
          </div>
          <div className="flex justify-between border-b border-border pb-2">
            <dt className="text-foreground/60">Grade</dt>
            <dd className="font-medium">{grade?.name}</dd>
          </div>
          <div className="flex justify-between border-b border-border pb-2">
            <dt className="text-foreground/60">Medium</dt>
            <dd className="font-medium">{subscription.medium}</dd>
          </div>
          <div className="flex justify-between border-b border-border pb-2">
            <dt className="text-foreground/60">Subjects ({subjectNames.length})</dt>
            <dd className="text-right font-medium">{subjectNames.join(", ")}</dd>
          </div>
          <div className="flex justify-between pt-1 text-base">
            <dt className="font-semibold">Total</dt>
            <dd className="font-semibold">
              ₹{((subscription.amount_paise ?? 0) / 100).toFixed(0)}/month
            </dd>
          </div>
        </dl>

        <p className="mt-4 text-xs text-foreground/50">
          {subjectNames.length} subject(s) × ₹{PRICE_PER_SUBJECT_INR}/month
        </p>

        <CCAvenueCheckout />
        <CouponForm />
      </div>
    </div>
  );
}
