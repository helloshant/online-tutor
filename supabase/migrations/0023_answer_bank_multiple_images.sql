-- A banked question can now carry several images (e.g. a multi-page
-- textbook solution or more than one figure) instead of just one -- same
-- text[] pattern already used for tags. Array order is display order,
-- oldest-appended-first, matching how an admin adds them "one after
-- another" via the Answer Bank page.
alter table public.answered_questions
  add column image_urls text[] not null default '{}';

update public.answered_questions
  set image_urls = array[image_url]
  where image_url is not null;

alter table public.answered_questions
  drop column image_url;
