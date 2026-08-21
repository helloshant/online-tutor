-- ---------------------------------------------------------------------------
-- New "broadcast" microservice (services/broadcast): lets an admin/
-- superadmin send an announcement, a promotional message, a feedback
-- request, or a real in-app test to a segment of registered students,
-- filtered the same way the rest of the catalog already is (board/grade/
-- subject/medium, any of which can be left unset to mean "everyone").
--
-- Same "backend-only table" posture as answered_questions/chapter_documents/
-- topic_summaries throughout this app: every table below has RLS enabled
-- with zero client-facing policies. Nothing about a broadcast is read or
-- written directly by the web app's ordinary user-session client -- both
-- the admin authoring/sending side and the student inbox/feedback/test
-- side always go through services/broadcast's own service-role connection,
-- proxied by thin Next.js API routes/admin actions (see broadcastClient.ts).
-- This is a stronger posture than most of this app's own tables (which at
-- least read through RLS), chosen because grading a test and fanning out
-- recipients are both privileged operations with no safe partial exposure
-- to a student's own session the way, say, reading one's own chat history
-- is.
-- ---------------------------------------------------------------------------

create table public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('announcement', 'promotion', 'feedback', 'test')),
  title text not null,
  body text not null,
  -- Targeting: each dimension left null means "every value", exactly like
  -- an unset filter in the admin catalog's own board/grade/subject/medium
  -- selectors. subject_id is matched against subscription_subjects (a
  -- subscription's board/grade/medium are fixed to the subscription row
  -- itself, but its subject list is a many-to-many join table) -- see
  -- services/broadcast/src/audience.ts for the actual resolution query.
  board_id uuid references public.boards (id) on delete cascade,
  grade_id uuid references public.grades (id) on delete cascade,
  subject_id uuid references public.subjects (id) on delete cascade,
  medium text check (medium in ('English', 'Hindi', 'Bengali')),
  status text not null default 'draft' check (status in ('draft', 'sent', 'closed')),
  sent_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index broadcasts_status_idx on public.broadcasts (status);
alter table public.broadcasts enable row level security;

-- Materialized fan-out, created once at send time (see POST /v1/broadcasts/
-- :id/send): one row per (broadcast, matching student), rather than
-- re-evaluating the board/grade/subject/medium filter on every inbox read.
-- This also freezes *who* a broadcast reached at the moment it was sent --
-- a student who subscribes to the matching segment afterward does not
-- retroactively see it, the same way a real announcement wouldn't reach
-- someone who joined after it went out.
create table public.broadcast_recipients (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references public.broadcasts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (broadcast_id, user_id)
);

create index broadcast_recipients_user_idx on public.broadcast_recipients (user_id, created_at desc);
create index broadcast_recipients_broadcast_idx on public.broadcast_recipients (broadcast_id);
alter table public.broadcast_recipients enable row level security;

-- One response per student per feedback-type broadcast -- a plain 1-5
-- rating plus an optional free-text comment, deliberately simple (no
-- multi-question survey builder) since the ask was "get feedback", not a
-- full survey product.
create table public.broadcast_feedback_responses (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references public.broadcasts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  rating int check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  unique (broadcast_id, user_id)
);

create index broadcast_feedback_broadcast_idx on public.broadcast_feedback_responses (broadcast_id);
alter table public.broadcast_feedback_responses enable row level security;

-- ---------------------------------------------------------------------------
-- Real in-app test/quiz engine, scoped to a single test-type broadcast.
-- ---------------------------------------------------------------------------

create table public.test_questions (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references public.broadcasts (id) on delete cascade,
  question_type text not null check (question_type in ('mcq', 'short_answer')),
  question text not null,
  -- MCQ only: a JSON array of option strings, and the index into it that's
  -- correct -- never sent to a student's own GET /v1/broadcasts/:id/test
  -- response (see that handler), only used server-side by test/submit's
  -- auto-grading.
  options jsonb,
  correct_option int,
  max_score numeric not null default 1,
  sort_order int not null default 0
);

create index test_questions_broadcast_idx on public.test_questions (broadcast_id, sort_order);
alter table public.test_questions enable row level security;

-- One attempt per student per test -- no retakes, kept simple; an admin
-- who wants to allow a retake can delete the attempt row (cascades to its
-- answers) via a future admin action, not built here.
create table public.test_attempts (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references public.broadcasts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 'submitted': every MCQ question is auto-graded immediately, but at
  -- least one short_answer question is still awaiting an admin's score.
  -- 'graded': every question on the attempt has a score (whether that's
  -- every question being MCQ, or an admin having graded the rest).
  status text not null default 'in_progress' check (status in ('in_progress', 'submitted', 'graded')),
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  total_score numeric,
  max_possible_score numeric,
  unique (broadcast_id, user_id)
);

create index test_attempts_user_idx on public.test_attempts (user_id);
create index test_attempts_broadcast_idx on public.test_attempts (broadcast_id);
alter table public.test_attempts enable row level security;

create table public.test_answers (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.test_attempts (id) on delete cascade,
  question_id uuid not null references public.test_questions (id) on delete cascade,
  selected_option int,
  answer_text text,
  -- Set immediately on submit for mcq (selected_option = correct_option),
  -- left null for short_answer until an admin grades it via
  -- POST /v1/test-answers/:id/grade.
  is_correct boolean,
  score numeric,
  unique (attempt_id, question_id)
);

create index test_answers_attempt_idx on public.test_answers (attempt_id);
alter table public.test_answers enable row level security;

-- ---------------------------------------------------------------------------
-- New admin page: "broadcasts". Same grandfathering approach every earlier
-- page addition used, so this doesn't silently lock out an admin who could
-- already reach every other page.
-- ---------------------------------------------------------------------------

alter table public.admin_page_permissions drop constraint admin_page_permissions_page_check;
alter table public.admin_page_permissions add constraint admin_page_permissions_page_check
  check (page in ('users', 'catalog', 'answer_bank', 'observability', 'coupons', 'chapter_notes', 'topic_summaries', 'broadcasts'));

insert into public.admin_page_permissions (user_id, page)
select p.id, 'broadcasts'
from public.profiles p
where p.role = 'admin'
on conflict (user_id, page) do nothing;
