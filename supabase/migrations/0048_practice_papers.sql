-- ---------------------------------------------------------------------------
-- Student-initiated mock practice papers: a student picks up to
-- MAX_CHAPTERS_PER_PAPER (see practiceBlueprint.ts) chapters, the
-- orchestrator generates a full paper mixing MCQ/short/long questions
-- (a fixed blueprint, not student-configurable -- see the accompanying
-- plan), the student photographs their handwritten answers and uploads
-- them, and the orchestrator's vision grading (see practicePaperGrading.ts)
-- assigns marks automatically. Unlike the admin-broadcast 'exam' type
-- (0029_exam_broadcast_type.sql), this is entirely student-initiated and
-- AI-graded -- a structurally different trigger/ownership model, hence a
-- fresh set of tables/bucket rather than reusing the broadcast ones.
-- ---------------------------------------------------------------------------

-- One row per generated paper. chapters is the raw list of
-- syllabus_topics.chapter values the student selected -- not a foreign key,
-- since a chapter isn't its own row (see syllabus_topics' own
-- (board,grade,subject,chapter,topic) shape).
create table public.practice_papers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  board_id uuid not null references public.boards (id) on delete cascade,
  grade_id uuid not null references public.grades (id) on delete cascade,
  subject_id uuid not null references public.subjects (id) on delete cascade,
  medium text not null check (medium in ('English', 'Hindi', 'Bengali')),
  chapters text[] not null,
  total_marks numeric not null,
  created_at timestamptz not null default now()
);

create index practice_papers_user_idx on public.practice_papers (user_id, created_at desc);
alter table public.practice_papers enable row level security;

create policy "practice_papers: user can read own rows"
  on public.practice_papers for select
  using (user_id = auth.uid());

create policy "practice_papers: admin can read all rows"
  on public.practice_papers for select
  using (public.is_admin());

-- One row per question on a paper. Deliberately references the SAME
-- answered_questions row today's topic-exercises use (see
-- storeGeneratedExercise in services/orchestrator/src/server.ts) rather than
-- duplicating question/answer text here -- this table only adds the paper
-- STRUCTURE (which questions, what order, worth how many marks) on top.
create table public.practice_paper_questions (
  id uuid primary key default gen_random_uuid(),
  paper_id uuid not null references public.practice_papers (id) on delete cascade,
  answered_question_id uuid not null references public.answered_questions (id) on delete cascade,
  question_type text not null check (question_type in ('MCQ', 'short_answer', 'long_answer', 'numerical')),
  marks numeric not null,
  sort_order int not null default 0,
  unique (paper_id, sort_order)
);

create index practice_paper_questions_paper_idx on public.practice_paper_questions (paper_id, sort_order);
alter table public.practice_paper_questions enable row level security;

create policy "practice_paper_questions: user can read own rows"
  on public.practice_paper_questions for select
  using (
    exists (
      select 1 from public.practice_papers p
      where p.id = practice_paper_questions.paper_id and p.user_id = auth.uid()
    )
  );

create policy "practice_paper_questions: admin can read all rows"
  on public.practice_paper_questions for select
  using (public.is_admin());

-- One row per (paper, student) -- no retakes once graded, same posture as
-- exam_submissions/test_attempts: a student wanting another attempt
-- generates a fresh paper instead of resubmitting against this one.
create table public.practice_paper_submissions (
  id uuid primary key default gen_random_uuid(),
  paper_id uuid not null references public.practice_papers (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  file_paths text[] not null default '{}',
  status text not null default 'submitted' check (status in ('submitted', 'grading', 'graded', 'failed')),
  total_score numeric,
  max_possible_score numeric,
  overall_feedback text,
  submitted_at timestamptz not null default now(),
  graded_at timestamptz,
  unique (paper_id, user_id)
);

create index practice_paper_submissions_user_idx on public.practice_paper_submissions (user_id);
alter table public.practice_paper_submissions enable row level security;

create policy "practice_paper_submissions: user can read own rows"
  on public.practice_paper_submissions for select
  using (user_id = auth.uid());

create policy "practice_paper_submissions: admin can read all rows"
  on public.practice_paper_submissions for select
  using (public.is_admin());

-- AI-assigned per-question marks + feedback, one row per (submission,
-- question) -- mirrors exam_question_scores' shape, except score/feedback
-- here come from the orchestrator's vision grading, never typed in by an
-- admin.
create table public.practice_paper_question_scores (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.practice_paper_submissions (id) on delete cascade,
  question_id uuid not null references public.practice_paper_questions (id) on delete cascade,
  score numeric not null,
  feedback text not null,
  unique (submission_id, question_id)
);

create index practice_paper_question_scores_submission_idx on public.practice_paper_question_scores (submission_id);
alter table public.practice_paper_question_scores enable row level security;

create policy "practice_paper_question_scores: user can read own rows"
  on public.practice_paper_question_scores for select
  using (
    exists (
      select 1 from public.practice_paper_submissions s
      where s.id = practice_paper_question_scores.submission_id and s.user_id = auth.uid()
    )
  );

create policy "practice_paper_question_scores: admin can read all rows"
  on public.practice_paper_question_scores for select
  using (public.is_admin());

-- No insert/update policy on any of the four tables above, deliberately:
-- every write here is privileged (paper generation spends LLM calls, grading
-- assigns marks nobody should be able to self-report) and always happens
-- server-side via the admin client after an explicit ownership check --
-- same posture as exam_submissions/student_archetype_progress.

-- Private bucket, same posture as exam-files (0029_exam_broadcast_type.sql)
-- -- a photographed answer sheet is not content meant to be openly
-- servable. Nothing reads/writes this bucket except the service-role admin
-- client; short-lived signed URLs only, never a permanent public link, so
-- no storage.objects policy is needed here either.
insert into storage.buckets (id, name, public)
values ('practice-answer-sheets', 'practice-answer-sheets', false)
on conflict (id) do nothing;
