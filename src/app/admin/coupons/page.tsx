import { requireAdminPage } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { generateCouponCodes, revokeCouponCode } from "./actions";

export default async function CouponsPage() {
  await requireAdminPage("coupons");
  const supabase = await createClient();

  const { data: coupons } = await supabase
    .from("coupon_codes")
    .select("*")
    .order("created_at", { ascending: false });

  const rows = coupons ?? [];
  const usedByIds = [...new Set(rows.map((c) => c.used_by).filter((id): id is string => Boolean(id)))];

  // profiles, not auth.users -- coupon_codes.used_by references auth.users
  // (same as every other user-reference column in this app), and profiles
  // is the table admins already have read access to for showing a name
  // (profiles.id is always the same id as auth.users.id).
  const { data: users } =
    usedByIds.length > 0
      ? await supabase.from("profiles").select("id, full_name").in("id", usedByIds)
      : { data: [] };
  const nameById = new Map((users ?? []).map((u) => [u.id, u.full_name]));

  return (
    <div>
      <h1 className="text-xl font-semibold">Coupons</h1>
      <p className="mt-1 max-w-2xl text-sm text-foreground/60">
        Single-use codes that bypass payment entirely — a student enters one on the{" "}
        <code className="rounded bg-brand/10 px-1 py-0.5 text-brand">/subscribe</code> page to activate their
        subscription for free. Each code works exactly once; once redeemed it can never be reused, even by the
        same student.
      </p>

      <form action={generateCouponCodes} className="mt-6 flex items-end gap-2">
        <div>
          <label htmlFor="count" className="block text-xs font-medium text-foreground/60">
            How many codes?
          </label>
          <input
            id="count"
            name="count"
            type="number"
            defaultValue={1}
            min={1}
            max={100}
            className="mt-1 w-24 rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          />
        </div>
        <button className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">
          Generate
        </button>
      </form>

      <div className="mt-6 overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-surface text-xs uppercase tracking-wide text-foreground/40">
            <tr>
              <th className="px-4 py-2 font-medium">Code</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Used by</th>
              <th className="px-4 py-2 font-medium">Created</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((coupon) => (
              <tr key={coupon.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2 font-mono">{coupon.code}</td>
                <td className="px-4 py-2">
                  {coupon.used_by ? (
                    <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-xs text-foreground/60">
                      Used
                    </span>
                  ) : (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">Unused</span>
                  )}
                </td>
                <td className="px-4 py-2 text-foreground/70">
                  {coupon.used_by
                    ? `${nameById.get(coupon.used_by) ?? "—"} · ${new Date(coupon.used_at!).toLocaleDateString()}`
                    : "—"}
                </td>
                <td className="px-4 py-2 text-foreground/50">{new Date(coupon.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-2 text-right">
                  {!coupon.used_by && (
                    <form action={revokeCouponCode.bind(null, coupon.id)}>
                      <button className="text-xs text-foreground/40 hover:underline">Revoke</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-foreground/50">
                  No coupon codes yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
