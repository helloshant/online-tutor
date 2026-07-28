-- Free-form provenance tags on answer-bank entries -- e.g. the textbook a
-- question was sourced from ("Ganit Prakash") or the exam paper it appeared
-- in ("WBJEE 2023") -- so entries can be found by that provenance rather
-- than only by board/grade/subject/medium/topic scope or full-text search
-- against the question itself. Deliberately a plain text[] rather than a
-- normalized tags table: tags here are open-ended labels an admin assigns,
-- not a controlled vocabulary that needs rename-once-updates-everywhere
-- semantics, so a separate table + join table would be more machinery than
-- the feature needs.
alter table public.answered_questions
  add column tags text[] not null default '{}';

-- GIN supports both containment queries (tags @> ARRAY['Ganit Prakash'],
-- used by the tag search/filter below) and the distinct-tags listing
-- (unnest(tags)) used to populate tag suggestions.
create index answered_questions_tags_idx on public.answered_questions using gin (tags);
