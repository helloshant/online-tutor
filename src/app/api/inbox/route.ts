import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Every code path below must return through NextResponse.json -- this
// top-level catch is the backstop so an unexpected throw never reaches the
// client as an empty/non-JSON body. Same pattern as /api/chat.
export async function GET() {
  try {
    return await handleGet();
  } catch (err) {
    console.error("Unexpected error in GET /api/inbox:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

async function handleGet() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // broadcast_recipients/broadcasts both have RLS enabled with zero
  // client-facing policies (see 0028_broadcast_service.sql) -- same
  // "backend-only table" posture as answered_questions/chapter_documents,
  // so this needs the service-role client, scoped server-side to this
  // authenticated user's own id (never trusted from the request itself).
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("broadcast_recipients")
    .select("id, read_at, created_at, broadcasts(id, type, title, body, status)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("Failed to load inbox:", error);
    return NextResponse.json({ error: "Could not load your inbox." }, { status: 500 });
  }

  type Row = {
    id: string;
    read_at: string | null;
    created_at: string;
    broadcasts: { id: string; type: string; title: string; body: string; status: string } | null;
  };

  const items = ((data ?? []) as unknown as Row[])
    .filter((row) => row.broadcasts !== null)
    .map((row) => ({
      recipientId: row.id,
      readAt: row.read_at,
      createdAt: row.created_at,
      broadcastId: row.broadcasts!.id,
      type: row.broadcasts!.type,
      title: row.broadcasts!.title,
      body: row.broadcasts!.body,
    }));

  return NextResponse.json({ items });
}
