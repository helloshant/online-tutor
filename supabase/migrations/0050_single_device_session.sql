-- Backs the single-active-device login restriction: a random id assigned
-- at each successful sign-in (see src/lib/singleSession.ts), written here
-- (service-role, bypasses RLS -- covers every role uniformly, including
-- staff/admin) and compared on every subsequent request (src/proxy.ts)
-- against a same-value httpOnly cookie set on that one browser at that
-- same sign-in. A mismatch means a later sign-in elsewhere has since
-- overwritten this row -- that device is signed out. Null for any
-- account that hasn't signed in since this shipped; the comparison in
-- proxy.ts is a no-op until then, so this doesn't retroactively log
-- anyone out on deploy.
alter table profiles add column current_session_id uuid;

-- Lets a signed-in user's own browser subscribe to postgres_changes on
-- their own profile row (already readable under RLS: "profiles: user can
-- read own row") for an instant, no-reload sign-out the moment another
-- device signs in -- src/components/single-session-guard.tsx. The
-- proxy.ts check above is the same enforcement without needing a live
-- connection, for whenever this one isn't (a closed tab, a dropped
-- websocket, etc.).
alter publication supabase_realtime add table profiles;
