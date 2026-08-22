-- ---------------------------------------------------------------------------
-- A fifth broadcast type, 'exam': an admin attaches the question paper
-- (one or more files -- images/PDF, e.g. photographed or scanned pages)
-- and sends it to a segment of students the same way any other broadcast
-- is targeted (see 0028_broadcast_service.sql). Each student uploads their
-- own answer sheet (again, one or more files -- there's no way to
-- auto-grade a scanned handwritten response the way an MCQ answer is
-- auto-graded), and an admin later marks it question-by-question from the
-- uploaded sheet, mirroring how a short-answer Test response is graded
-- (see 0028's own test_answers/test_attempts) but scored per-question
-- against a single uploaded document rather than per-question typed text.
-- ---------------------------------------------------------------------------

alter table public.broadcasts drop constraint broadcasts_type_check;
alter table public.broadcasts add constraint broadcasts_type_check
  check (type in ('announcement', 'promotion', 'feedback', 'test', 'exam'));

-- The uploaded question-paper file(s) -- unused for every other broadcast
-- type. Storage *paths* (not public URLs -- see the private bucket below),
-- resolved to a short-lived signed URL server-side whenever a recipient or
-- an admin actually needs to view them, never exposed as a permanent link.
alter table public.broadcasts add column attachment_paths text[] not null default '{}';

-- One row per exam question -- just the text and how many marks it's
-- worth. No question_type/options/correct_option the way test_questions
-- has, since there is nothing machine-answerable here: every exam
-- question is inherently marked by a human against the uploaded answer
-- sheet, not answered in-app.
create table public.exam_questions (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references public.broadcasts (id) on delete cascade,
  question text not null,
  max_score numeric not null default 1,
  sort_order int not null default 0
);

create index exam_questions_broadcast_idx on public.exam_questions (broadcast_id, sort_order);
alter table public.exam_questions enable row level security;

-- One row per student per exam -- holds the uploaded answer-sheet file(s)
-- and the overall grading state. No retakes: a student replaces their
-- file_paths by re-submitting (upsert on the same row) while still
-- 'submitted', same "no do-over once graded" posture as test_attempts.
create table public.exam_submissions (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references public.broadcasts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  file_paths text[] not null default '{}',
  status text not null default 'submitted' check (status in ('submitted', 'graded')),
  total_score numeric,
  max_possible_score numeric,
  feedback text,
  submitted_at timestamptz not null default now(),
  unique (broadcast_id, user_id)
);

create index exam_submissions_broadcast_idx on public.exam_submissions (broadcast_id);
create index exam_submissions_user_idx on public.exam_submissions (user_id);
alter table public.exam_submissions enable row level security;

-- Per-question marks an admin assigns while grading one submission --
-- mirrors test_answers' (attempt_id, question_id) shape, minus the
-- selected_option/answer_text/is_correct columns that make no sense here
-- (the actual response lives in exam_submissions.file_paths, not per
-- question), so this is really just "score" keyed to (submission,
-- question).
create table public.exam_question_scores (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.exam_submissions (id) on delete cascade,
  question_id uuid not null references public.exam_questions (id) on delete cascade,
  score numeric not null,
  unique (submission_id, question_id)
);

create index exam_question_scores_submission_idx on public.exam_question_scores (submission_id);
alter table public.exam_question_scores enable row level security;

-- Private bucket -- unlike answer-bank-images (0017_answer_bank_image.sql),
-- an exam paper and especially a student's own answer sheet are not
-- content meant to be openly servable to anyone who guesses/obtains the
-- URL. Nothing reads/writes this bucket except the service-role admin
-- client (student uploads and admin downloads both go through Next.js API
-- routes/admin actions that check authorization first, then generate a
-- short-lived signed URL or perform the upload themselves), so no
-- storage.objects policy is needed here either -- service_role bypasses
-- RLS entirely.
insert into storage.buckets (id, name, public)
values ('exam-files', 'exam-files', false)
on conflict (id) do nothing;
