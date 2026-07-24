-- Online Tutor SaaS: core schema
-- Requires pgcrypto (Supabase projects have it enabled by default) for gen_random_uuid().

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now()
);

-- Auto-create a profile row whenever a new auth user signs up.
-- Named distinctly (not handle_new_user/on_auth_user_created) so this can
-- coexist in a Supabase project shared with other apps that already use
-- those common names for their own auth.users trigger.
create function public.handle_new_tutorops_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

create trigger on_tutorops_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_tutorops_user();

-- ---------------------------------------------------------------------------
-- Catalog: boards, grades, subjects, and the offerings/syllabus that tie
-- them together. This is what makes the app syllabus- and board-aware.
-- ---------------------------------------------------------------------------
create table public.boards (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,      -- e.g. "CBSE", "ICSE", "West Bengal Board"
  code text not null unique,      -- e.g. "CBSE", "ICSE", "WBBSE"
  created_at timestamptz not null default now()
);

create table public.grades (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,      -- e.g. "Grade 9"
  level int not null unique,      -- 9
  created_at timestamptz not null default now()
);

create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,      -- e.g. "Mathematics"
  code text not null unique,      -- e.g. "MATH"
  created_at timestamptz not null default now()
);

-- Which subjects are offered for a given board + grade combination.
create table public.board_grade_subjects (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards (id) on delete cascade,
  grade_id uuid not null references public.grades (id) on delete cascade,
  subject_id uuid not null references public.subjects (id) on delete cascade,
  unique (board_id, grade_id, subject_id)
);

-- The syllabus itself: chapters/topics scoped to board + grade + subject.
-- This is the source of truth the chat system prompt uses to keep the LLM
-- confined to what the student is actually meant to be learning.
create table public.syllabus_topics (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards (id) on delete cascade,
  grade_id uuid not null references public.grades (id) on delete cascade,
  subject_id uuid not null references public.subjects (id) on delete cascade,
  chapter text not null,
  topic text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (board_id, grade_id, subject_id, chapter, topic)
);

create index syllabus_topics_scope_idx
  on public.syllabus_topics (board_id, grade_id, subject_id, sort_order);

-- ---------------------------------------------------------------------------
-- Subscriptions: a user's chosen board/grade/medium + subjects + payment state
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  board_id uuid not null references public.boards (id),
  grade_id uuid not null references public.grades (id),
  medium text not null check (medium in ('English', 'Hindi', 'Bengali')),
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'active', 'cancelled', 'expired')),
  amount_paise integer,
  razorpay_order_id text,
  razorpay_payment_id text,
  created_at timestamptz not null default now(),
  activated_at timestamptz
);

-- A user can only have one subscription that is currently pending payment or
-- active at a time (they can re-subscribe later once cancelled/expired).
create unique index subscriptions_one_live_per_user
  on public.subscriptions (user_id)
  where status in ('pending_payment', 'active');

create index subscriptions_user_idx on public.subscriptions (user_id);

-- Subjects chosen as part of a subscription.
create table public.subscription_subjects (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions (id) on delete cascade,
  subject_id uuid not null references public.subjects (id) on delete cascade,
  unique (subscription_id, subject_id)
);

-- ---------------------------------------------------------------------------
-- Chat history
-- ---------------------------------------------------------------------------
create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  subscription_id uuid not null references public.subscriptions (id) on delete cascade,
  subject_id uuid not null references public.subjects (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index chat_messages_user_subject_idx
  on public.chat_messages (user_id, subject_id, created_at);
