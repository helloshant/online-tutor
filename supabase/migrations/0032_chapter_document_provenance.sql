-- ---------------------------------------------------------------------------
-- Provenance tracking for chapter_documents -- prompted by a real question:
-- prescribed textbooks are copyrighted, so chapter notes can't be a lightly
-- reworded copy of one. The sustainable strategy is original, admin-authored
-- notes at this app's own syllabus_topics granularity (informed by the
-- textbook, never copied from it), occasionally accelerated by genuinely
-- open-licensed material (NCERT, DIKSHA/NROER, OpenStax, public-domain
-- literary works) as a first draft an author still rewrites and reviews --
-- see docs/content-authoring-guide.md for the full policy this schema
-- supports.
--
-- Without this, there is no way to audit *how* any given document came to
-- be -- these three columns make that auditable per-row rather than trusted
-- to institutional memory. source_type is deliberately not "did you copy
-- anything" (every row already implicitly claims "no" by existing at all,
-- which isn't a meaningful default to assert) -- it's "what, if anything,
-- did the author draw on beyond their own understanding of the syllabus,"
-- which is the actual auditable fact.
alter table public.chapter_documents
  add column source_type text not null default 'original'
    check (source_type in ('original', 'public_domain', 'cc_licensed', 'ncert_or_diksha', 'other')),
  -- Populated when source_type isn't 'original' -- the specific open
  -- resource (an NCERT PDF page, a DIKSHA/NROER content id, a Wikipedia
  -- article, ...) the author drew on, so the claim is checkable later
  -- rather than resting on the author's memory.
  add column source_url text,
  -- Free-text detail a structured source_type can't capture on its own --
  -- e.g. "CC-BY-SA, paraphrased and restructured, not reproduced" or "poem
  -- confirmed public domain (author d. 1941, +60y)". Optional even when
  -- source_type isn't 'original', though strongly encouraged there.
  add column source_note text;

comment on column public.chapter_documents.source_type is
  'What the author drew on beyond their own understanding of the syllabus topic: original (default, no external source), public_domain, cc_licensed, ncert_or_diksha, or other. Never a substitute for actually writing original prose -- see docs/content-authoring-guide.md.';
