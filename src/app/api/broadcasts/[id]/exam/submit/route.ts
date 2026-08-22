import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const EXAM_BUCKET = "exam-files";
const ALLOWED_FILE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const MAX_FILE_BYTES = 15 * 1024 * 1024;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await handlePost(request, await params);
  } catch (err) {
    console.error("Unexpected error in POST /api/broadcasts/[id]/exam/submit:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

// Grading an exam is entirely manual (an admin marks the uploaded sheet
// question-by-question), so unlike Test's submit there's no auto-scoring
// logic that needs to live behind services/broadcast's own trust boundary
// -- this is a plain upload + row write, same trust level as every other
// student-facing write in this app that goes through the admin client
// after an ownership check (e.g. marking an inbox item read).
async function handlePost(request: Request, { id: broadcastId }: { id: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const admin = createAdminClient();

  const [{ data: recipient }, { data: broadcast }] = await Promise.all([
    admin.from("broadcast_recipients").select("id").eq("broadcast_id", broadcastId).eq("user_id", user.id).maybeSingle(),
    admin.from("broadcasts").select("type").eq("id", broadcastId).maybeSingle(),
  ]);
  if (!recipient) {
    return NextResponse.json({ error: "This wasn't sent to you." }, { status: 403 });
  }
  if (!broadcast || broadcast.type !== "exam") {
    return NextResponse.json({ error: "This isn't an exam." }, { status: 400 });
  }

  const { data: existing } = await admin
    .from("exam_submissions")
    .select("id, status")
    .eq("broadcast_id", broadcastId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (existing?.status === "graded") {
    return NextResponse.json({ error: "This has already been graded and can't be resubmitted." }, { status: 400 });
  }

  const formData = await request.formData();
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) {
    return NextResponse.json({ error: "Upload at least one file." }, { status: 400 });
  }

  const paths: string[] = [];
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES || !ALLOWED_FILE_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: `${file.name || "A file"} isn't a supported type/size (images or PDF, up to 15MB).` },
        { status: 400 }
      );
    }
    const path = `${broadcastId}/${user.id}-${crypto.randomUUID()}`;
    const { error: uploadError } = await admin.storage.from(EXAM_BUCKET).upload(path, file, { contentType: file.type });
    if (uploadError) {
      console.error("Exam answer sheet upload failed:", uploadError);
      return NextResponse.json({ error: "Could not upload your answer sheet. Please try again." }, { status: 500 });
    }
    paths.push(path);
  }

  const { error: upsertError } = await admin.from("exam_submissions").upsert(
    {
      broadcast_id: broadcastId,
      user_id: user.id,
      file_paths: paths,
      status: "submitted",
      submitted_at: new Date().toISOString(),
    },
    { onConflict: "broadcast_id,user_id" }
  );
  if (upsertError) {
    console.error("Failed to record exam submission:", upsertError);
    return NextResponse.json({ error: "Could not save your submission. Please try again." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
