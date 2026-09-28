"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

// Instant, no-reload sign-out the moment another device signs into this
// same account -- src/proxy.ts enforces the same rule on the NEXT request
// this browser makes, but a tab sitting idle on an already-loaded page
// makes no further requests on its own, so that alone could leave a
// kicked-out device looking fully signed in for a while. This closes that
// gap with a live subscription instead: as soon as
// profiles.current_session_id changes to anything other than what THIS
// browser was handed at its own last sign-in (see singleSession.ts), sign
// out and redirect right away, without waiting for the next navigation.
//
// Mounted once, in the root layout, for every signed-in page load -- see
// that file's own comment on why it's safe to render unconditionally
// there. Renders nothing itself.
export function SingleSessionGuard({ userId, mySessionId }: { userId: string; mySessionId: string }) {
  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel(`single-session-${userId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${userId}` },
        (payload) => {
          const latestSessionId = (payload.new as { current_session_id: string | null }).current_session_id;
          if (latestSessionId && latestSessionId !== mySessionId) {
            void supabase.auth.signOut().finally(() => {
              window.location.href = "/login?reason=signed_in_elsewhere";
            });
          }
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, mySessionId]);

  return null;
}
