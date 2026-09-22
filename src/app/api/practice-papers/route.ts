import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isStaff } from "@/lib/auth";
import { resolveStaffPreviewScope } from "@/lib/staffPreview";
import {
  resolveStudentSubjectScope,
  resolveContentMedium,
} from "@/lib/studentScope";
import {
  resolveMonthlyTokenLimit,
  startOfCurrentMonthIso,
} from "@/lib/usageLimits";
import { toArchetypeGradeOrYear } from "@/lib/archetypeGradeName";
import { generatePracticePaper } from "@/lib/orchestratorClient";
import type { Medium } from "@/lib/supabase/types";

// Kept in sync by hand with the orchestrator's own
// practiceBlueprint.ts:MAX_CHAPTERS_PER_PAPER -- same "mirrored constant"
// convention as ExerciseType across this app's client/server boundary.
const MAX_CHAPTERS_PER_PAPER = 4;

// POST generates a fresh paper for one or more selected chapters; GET
// lists the caller's own paper history. A real student's scope always
// comes from their own subscription (resolveStudentSubjectScope, ignoring
// any board/grade/medium the client sends); staff have no subscription at
// all, so they instead preview a specific board/grade/medium the same way
// /api/chat/route.ts already lets them -- see handlePost below. Staff
// never subscribe or have marks tracked, but they still need to be able to
// see and try this feature (e.g. to demo or QA it), the same way they can
// already preview Topics/Past years/chat.
export async function POST(request: Request) {
  try {
    return await handlePost(request);
  } catch (err) {
    console.error("Unexpected error in POST /api/practice-papers:", err);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
}

export async function GET() {
  try {
    return await handleGet();
  } catch (err) {
    console.error("Unexpected error in GET /api/practice-papers:", err);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
}

// Up to MAX_CHAPTERS_PER_PAPER chapters' worth of exercise generation is
// genuinely more LLM spend than a single exercise click -- same quota gate
// /api/topics/[id]/exercises/generate/route.ts already enforces for the
// same reason (real, repeatable, on-demand token cost), applied here too
// rather than leaving this one generation path unmetered.
async function handlePost(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const subjectId = typeof body?.subjectId === "string" ? body.subjectId : "";
  const chapters = Array.isArray(body?.chapters) ? body.chapters : null;

  if (
    !subjectId ||
    !chapters ||
    chapters.length === 0 ||
    chapters.length > MAX_CHAPTERS_PER_PAPER ||
    !chapters.every((c: unknown) => typeof c === "string" && c.trim())
  ) {
    return NextResponse.json(
      {
        error: `subjectId and 1-${MAX_CHAPTERS_PER_PAPER} chapter names are required`,
      },
      { status: 400 },
    );
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  // Staff have no subscription for resolveStudentSubjectScope to find --
  // they preview a specific board/grade/medium instead (the same one
  // dashboard-shell.tsx already resolves for Topics/Past years/chat, sent
  // through by PracticePanel), validated the same way
  // /api/chat/route.ts's own staff branch validates it: the board must
  // actually offer this subject/grade, or this is rejected rather than
  // trusting an arbitrary client-supplied combination.
  const scope = isStaff(profile?.role)
    ? await resolveStaffPreviewScope(supabase, subjectId, {
        boardId: body?.boardId,
        gradeId: body?.gradeId,
        medium: body?.medium,
      })
    : await resolveStudentSubjectScope(supabase, user.id, subjectId);
  if (!scope) {
    return NextResponse.json(
      {
        error: isStaff(profile?.role)
          ? "Select a board and grade to preview practice papers for."
          : "You don't have an active subscription for this subject.",
      },
      { status: isStaff(profile?.role) ? 400 : 403 },
    );
  }

  if (!isStaff(profile?.role)) {
    const admin = createAdminClient();
    const { data: override } = await admin
      .from("student_usage_limits")
      .select("monthly_token_limit")
      .eq("user_id", user.id)
      .maybeSingle();

    const { unlimited, limit } = resolveMonthlyTokenLimit(override);

    if (!unlimited) {
      const { data: usedTokens, error: usageError } = await admin.rpc(
        "monthly_llm_tokens_for_user",
        { p_user_id: user.id, p_since: startOfCurrentMonthIso() },
      );
      if (usageError) {
        console.error(
          "Failed to check monthly token usage, allowing the request:",
          usageError,
        );
      } else if ((usedTokens ?? 0) >= limit) {
        return NextResponse.json(
          {
            error:
              "You've reached this month's AI tutoring usage limit. It resets at the start of next month.",
          },
          { status: 429 },
        );
      }
    }
  }

  const [{ data: board }, { data: grade }, { data: subject }] =
    await Promise.all([
      supabase.from("boards").select("name").eq("id", scope.boardId).single(),
      supabase.from("grades").select("name").eq("id", scope.gradeId).single(),
      supabase
        .from("subjects")
        .select("name, code")
        .eq("id", subjectId)
        .single(),
    ]);

  // Same syllabus-scope medium every other generation path uses (see
  // /api/chat/route.ts's identical resolveContentMedium call) -- NOT
  // resolveStudentSubjectScope's own resolveAnswerBankMedium-derived
  // `scope.medium`, which answers a different question (where a student's
  // own banked answers live, not where the syllabus content itself lives).
  const contentMedium: Medium = resolveContentMedium(
    subject?.code ?? "",
    board?.name ?? "",
    scope.medium,
  );

  const { data: topicRows } = await supabase
    .from("syllabus_topics")
    .select("id, chapter, topic")
    .eq("board_id", scope.boardId)
    .eq("grade_id", scope.gradeId)
    .eq("subject_id", subjectId)
    .eq("medium", contentMedium)
    .in("chapter", chapters);

  const foundChapters = new Set((topicRows ?? []).map((t) => t.chapter));
  const missingChapter = chapters.find((c: string) => !foundChapters.has(c));
  if (missingChapter) {
    return NextResponse.json(
      { error: `No topics found for chapter "${missingChapter}".` },
      { status: 400 },
    );
  }

  try {
    const { questions, totalMarks } = await generatePracticePaper({
      userId: user.id,
      boardId: scope.boardId,
      gradeId: scope.gradeId,
      subjectId,
      subjectName: subject?.name ?? "",
      boardName: board?.name ?? "",
      gradeName: toArchetypeGradeOrYear(grade?.name ?? ""),
      medium: contentMedium,
      topics: (topicRows ?? []).map((t) => ({
        id: t.id,
        chapter: t.chapter,
        topic: t.topic,
      })),
    });

    if (questions.length === 0) {
      return NextResponse.json(
        {
          error:
            "Could not generate a practice paper right now. Please try again shortly.",
        },
        { status: 502 },
      );
    }

    const admin = createAdminClient();
    const { data: paper, error: paperError } = await admin
      .from("practice_papers")
      .insert({
        user_id: user.id,
        board_id: scope.boardId,
        grade_id: scope.gradeId,
        subject_id: subjectId,
        medium: contentMedium,
        chapters,
        total_marks: totalMarks,
      })
      .select("id, created_at")
      .single();

    if (paperError || !paper) {
      console.error("Failed to store generated practice paper:", paperError);
      return NextResponse.json(
        { error: "Could not save the generated practice paper." },
        { status: 500 },
      );
    }

    const { data: questionRows, error: questionsError } = await admin
      .from("practice_paper_questions")
      .insert(
        questions.map((q) => ({
          paper_id: paper.id,
          answered_question_id: q.answeredQuestionId,
          question_type: q.type,
          marks: q.marks,
          sort_order: q.sortOrder,
        })),
      )
      .select("id, answered_question_id, question_type, marks, sort_order");

    if (questionsError || !questionRows) {
      console.error(
        "Failed to store practice paper questions:",
        questionsError,
      );
      return NextResponse.json(
        { error: "Could not save the generated practice paper." },
        { status: 500 },
      );
    }

    const byAnsweredId = new Map(
      questions.map((q) => [q.answeredQuestionId, q]),
    );
    return NextResponse.json({
      paper: {
        id: paper.id,
        chapters,
        totalMarks,
        createdAt: paper.created_at,
        questions: questionRows
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((row) => ({
            id: row.id,
            question:
              byAnsweredId.get(row.answered_question_id)?.question ?? "",
            type: row.question_type,
            marks: row.marks,
          })),
      },
    });
  } catch (err) {
    console.error("Practice-paper generation request failed:", err);
    return NextResponse.json(
      {
        error:
          "Could not generate a practice paper right now. Please try again shortly.",
      },
      { status: 502 },
    );
  }
}

// Relies entirely on the RLS "user can read own rows" policy
// (0048_practice_papers.sql) -- the regular session client, not the admin
// client, is what makes that meaningful here.
async function handleGet() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: papers, error } = await supabase
    .from("practice_papers")
    .select("id, subject_id, chapters, total_marks, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to load practice paper history:", error);
    return NextResponse.json(
      { error: "Could not load your practice papers." },
      { status: 500 },
    );
  }

  // camelCase, matching every other route in this feature (POST's own
  // response, GET /api/practice-papers/[id]) -- rather than leaking this
  // one endpoint's raw snake_case row shape to the client.
  return NextResponse.json({
    papers: (papers ?? []).map((p) => ({
      id: p.id,
      subjectId: p.subject_id,
      chapters: p.chapters,
      totalMarks: p.total_marks,
      createdAt: p.created_at,
    })),
  });
}

// Paper generation fires up to ~16 sequential-ish LLM calls in bounded
// chunks -- comfortably past the platform's default route timeout.
export const maxDuration = 60;
