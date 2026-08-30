-- question_id and archetype_id were global primary keys, but both are
-- generated deterministically from real-world content -- question_id from
-- a paper's own board/subject/year/question-number metadata (Stage 0's own
-- prompt asks for "a stable unique id, e.g. CBSE-MATH-2019-SET1-Q17-i"),
-- archetype_id from an archetype's own name/concept. Resubmitting the SAME
-- paper as a new run -- the documented recovery path after an interrupted
-- or failed run (see pipelineRunner.ts's own comment: "restarting an
-- interrupted run means resubmitting it") -- reproduces the exact same
-- id values, and a GLOBAL primary key then rejects the whole new run's
-- insert outright over a single collision.
--
-- Scoping uniqueness to (run_id, id) instead lets the same real-world
-- question/archetype be mined again in an independent run without
-- colliding with an earlier run's own copy of it -- every run keeps its
-- own row. Every actual read/write in this service already carries run_id
-- alongside the id column (verified: no query anywhere looks a row up by
-- question_id/archetype_id alone, across runs), so this only changes the
-- uniqueness constraint itself, not any query shape.
--
-- Drop order matters: child FKs before the parent PK they depend on,
-- since Postgres won't drop a PK a live FK still references.

alter table public.archetype_question_embeddings
  drop constraint archetype_question_embeddings_question_id_fkey;
alter table public.archetype_question_embeddings
  drop constraint archetype_question_embeddings_pkey;

alter table public.archetype_question_signatures
  drop constraint archetype_question_signatures_question_id_fkey;
alter table public.archetype_question_signatures
  drop constraint archetype_question_signatures_pkey;

alter table public.archetype_segmented_questions
  drop constraint archetype_segmented_questions_parent_question_id_fkey;
alter table public.archetype_segmented_questions
  drop constraint archetype_segmented_questions_pkey;

alter table public.archetype_segmented_questions
  add constraint archetype_segmented_questions_pkey primary key (run_id, question_id);
-- parent_question_id must now resolve within the SAME run, not globally --
-- consistent with services/archetype-miner/src/stage0Segmenter.ts's own
-- dangling-parent check, which already only ever compares question_ids
-- within one paper's own batch.
alter table public.archetype_segmented_questions
  add constraint archetype_segmented_questions_parent_question_id_fkey
  foreign key (run_id, parent_question_id) references public.archetype_segmented_questions (run_id, question_id)
  on delete set null;

alter table public.archetype_question_signatures
  add constraint archetype_question_signatures_pkey primary key (run_id, question_id);
alter table public.archetype_question_signatures
  add constraint archetype_question_signatures_question_id_fkey
  foreign key (run_id, question_id) references public.archetype_segmented_questions (run_id, question_id)
  on delete cascade;

alter table public.archetype_question_embeddings
  add constraint archetype_question_embeddings_pkey primary key (run_id, question_id);
alter table public.archetype_question_embeddings
  add constraint archetype_question_embeddings_question_id_fkey
  foreign key (run_id, question_id) references public.archetype_question_signatures (run_id, question_id)
  on delete cascade;

-- archetypes.archetype_id has no incoming foreign key from any other table
-- (archetype_review_queue.reference_id and archetype_families.
-- member_archetype_ids are both plain text/jsonb, deliberately not real
-- FKs -- see their own migration comments), so this one is a straight
-- swap, no cascading FK to rebuild.
alter table public.archetypes drop constraint archetypes_pkey;
alter table public.archetypes add constraint archetypes_pkey primary key (run_id, archetype_id);
