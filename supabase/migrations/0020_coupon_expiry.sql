-- Coupon codes had no expiry at all -- a generated code stayed valid
-- indefinitely until redeemed or manually revoked. This adds an optional
-- expiry: nullable, so existing/future codes generated without one keep
-- today's "valid forever until used" behavior, and an admin can set one
-- per batch at generation time.
alter table public.coupon_codes
  add column expires_at timestamptz;
