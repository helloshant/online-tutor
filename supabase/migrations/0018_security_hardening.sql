-- Security hardening found while auditing Supabase advisories, applied live
-- and captured here for reproducibility. Scoped to Online Tutor's own
-- functions only -- unrelated leftover objects from other projects that
-- happened to share this Supabase project (an LMS app, a chat app, a
-- medical-equipment app) were cleaned up directly against the live project,
-- not recorded here, since they were never part of this app's schema.

-- Supabase grants EXECUTE on every function in `public` to anon/authenticated
-- (and, at creation time, to the PUBLIC pseudo-role) separately from
-- whatever an individual migration's own "revoke ... from public" does --
-- revoking from PUBLIC alone does not remove a role's own separate direct
-- grant, and revoking a role's own direct grant does not remove access it
-- still gets via PUBLIC (a role's effective privilege is the union of both).
-- Without this, anyone with just the anon key could call search_answer_bank
-- or search_topic_exercises directly via the REST RPC endpoint and read
-- banked Q&A for any board/grade/subject -- including pending_review/
-- rejected rows -- bypassing every subscription/entitlement check the
-- actual API routes enforce. bump_answer_bank_hit and
-- get_users_with_email_identity are lower-severity (a hit-count griefing
-- vector, and a userid-enumeration vector, respectively) but were meant to
-- be service-role-only too, per their own original migration comments.
revoke execute on function public.search_answer_bank(uuid, uuid, uuid, text, text, real) from public, anon, authenticated;
revoke execute on function public.search_topic_exercises(uuid, uuid, uuid, text, uuid, integer) from public, anon, authenticated;
revoke execute on function public.bump_answer_bank_hit(uuid) from public, anon, authenticated;
revoke execute on function public.get_users_with_email_identity(uuid[]) from public, anon, authenticated;

-- Trigger functions -- Postgres fires these via the trigger mechanism
-- regardless of the invoking role's own EXECUTE privilege on the function,
-- so revoking here doesn't affect their normal operation
-- (profiles_role_change_guard on profiles, on_tutorops_auth_user_created and
-- on_tutorops_auth_user_password_change on auth.users). Without this, each
-- was independently callable via its own REST RPC endpoint
-- (e.g. /rest/v1/rpc/handle_new_tutorops_user) by anyone with the anon key.
revoke execute on function public.enforce_profile_role_change() from public, anon, authenticated;
revoke execute on function public.handle_new_tutorops_user() from public, anon, authenticated;
revoke execute on function public.handle_tutorops_password_change() from public, anon, authenticated;

-- is_admin()/is_superadmin() are deliberately NOT revoked here -- every RLS
-- policy that calls them (boards, grades, subjects, profiles, etc.) is
-- evaluated as the querying role itself (anon/authenticated), so revoking
-- their EXECUTE would break RLS policy evaluation for every ordinary user,
-- not just lock down an unintended caller.

-- Hardens against search_path hijacking (a role that can create objects
-- earlier in an unqualified search_path could otherwise shadow a builtin/
-- schema object these functions rely on) -- doesn't change behavior, since
-- every one of these already only touches `public` (and auth.*, which is
-- always schema-qualified in their bodies).
alter function public.is_admin() set search_path = public;
alter function public.is_superadmin() set search_path = public;
alter function public.bump_answer_bank_hit(uuid) set search_path = public;
alter function public.enforce_profile_role_change() set search_path = public;
alter function public.get_users_with_email_identity(uuid[]) set search_path = public;
alter function public.handle_new_tutorops_user() set search_path = public;
alter function public.handle_tutorops_password_change() set search_path = public;
alter function public.search_answer_bank(uuid, uuid, uuid, text, text, real) set search_path = public;
alter function public.search_topic_exercises(uuid, uuid, uuid, text, uuid, integer) set search_path = public;
