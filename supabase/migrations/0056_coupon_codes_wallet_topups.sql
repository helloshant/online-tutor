-- Coupons now apply to wallet recharges, not subscriptions (subscriptions
-- are free/instant -- see supabase/migrations/0055_student_wallets.sql).
-- subscription_id stays untouched (historical redemptions from before this
-- shipped keep reading correctly, see services/payment/src/coupons.ts's own
-- redeemCoupon, left in place but now unreachable going forward, same
-- "leave the old path alone" posture 0055 already took for CCAvenue) --
-- wallet_topup_id is the new target a fresh redemption claims.
alter table public.coupon_codes
  add column wallet_topup_id uuid references public.wallet_topups(id) on delete set null;
