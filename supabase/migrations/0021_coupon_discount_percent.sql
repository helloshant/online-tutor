-- Coupons moved from an all-or-nothing "bypass payment entirely" model to a
-- percentage discount applied to the subscription's amount_paise. Default
-- 100 preserves today's behavior for any already-generated, not-yet-redeemed
-- codes (100% off == the old free-access outcome) without needing a backfill.
alter table public.coupon_codes
  add column discount_percent smallint not null default 100
    check (discount_percent between 1 and 100);
