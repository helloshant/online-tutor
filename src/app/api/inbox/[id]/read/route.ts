import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await handlePost(await params);
  } catch (err) {
    console.error("Unexpected error in POST /api/inbox/[id]/read:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

// id here is the broadcast_recipients row's own id (not the broadcast's) --
// the client already has it from GET /api/inbox's `recipientId` field.
async function handlePost({ id: recipientId }: { id: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const admin = createAdminClient();
  // Scoped to this user's own id in the WHERE clause, not just looked up by
  // id alone -- a student can only ever mark their own recipient row read.
  const { error } = await admin
    .from("broadcast_recipients")
    .update({ read_at: new Date().toISOString() })
    .eq("id", recipientId)
    .eq("user_id", user.id);

  if (error) {
    console.error("Failed to mark inbox item as read:", error);
    return NextResponse.json({ error: "Could not update." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
