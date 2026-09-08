-- ---------------------------------------------------------------------------
-- Fixes a real production timeout confirmed directly (57014, "canceling
-- statement due to statement timeout") when scanning English/CBSE/grade 12
-- with services/archetype-miner's off-scope-content-scan. The same
-- board/grade/subject scope filter --
--   .eq("education_context->curriculum_source->>name", boardName)
--   .eq("education_context->>grade_or_year", gradeName)
--   .eq("education_context->>subject_or_course", subjectName)
-- -- is used identically across offScopeContentScan.ts, curriculumReconciliation.ts,
-- and crossRunMerge.ts against archetype_question_signatures,
-- archetype_segmented_questions, and archetypes, and NONE of the three had
-- any index covering it (checked directly via pg_indexes): every one of
-- these scope-filtered reads forced a full sequential scan.
--
-- archetypes already carries a GIN index on the whole education_context
-- column (archetypes_education_context_idx), but a default (jsonb_ops) GIN
-- index only accelerates containment operators (@>, ?, ?|, ?&) -- not the
-- `->>'key' = 'value'` equality PostgREST generates for .eq() on a JSON
-- path, which is exactly the shape every one of these queries uses. It
-- doesn't help this query at all, which is exactly why the sequential scan
-- was still happening despite that index already existing.
--
-- One matching three-column expression index per table, over the exact
-- same expressions the queries already filter on, so the planner can use
-- an index scan instead of scanning the whole table (and, for
-- archetype_question_signatures/archetype_segmented_questions's own
-- offset-paginated reads, stops the pathological case where a page whose
-- offset exceeds the scope's own total match count forces scanning the
-- ENTIRE table just to confirm there's nothing left).
-- ---------------------------------------------------------------------------

create index if not exists archetype_question_signatures_scope_idx
  on public.archetype_question_signatures (
    (education_context -> 'curriculum_source' ->> 'name'),
    (education_context ->> 'grade_or_year'),
    (education_context ->> 'subject_or_course')
  );

create index if not exists archetype_segmented_questions_scope_idx
  on public.archetype_segmented_questions (
    (education_context -> 'curriculum_source' ->> 'name'),
    (education_context ->> 'grade_or_year'),
    (education_context ->> 'subject_or_course')
  );

create index if not exists archetypes_scope_idx
  on public.archetypes (
    (education_context -> 'curriculum_source' ->> 'name'),
    (education_context ->> 'grade_or_year'),
    (education_context ->> 'subject_or_course')
  );
