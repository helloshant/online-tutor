-- ---------------------------------------------------------------------------
-- Fixes a real production timeout: services/archetype-miner's Stage 3
-- recovery (stage3Recovery.ts's own loadFallbackRows) does
-- `.eq("critic_decision", "REVIEW")` with no other filter -- confirmed
-- directly, this query started failing with Postgres error 57014
-- ("canceling statement due to statement timeout") once the archetypes
-- table grew large enough. archetypes had NO index on critic_decision at
-- all (only run_id, status, education_context, and the (run_id,
-- archetype_id) primary key -- see pg_indexes, checked directly), so
-- EVERY query filtering on critic_decision alone -- this one, and every
-- other one that filters status/critic_decision together (
-- archetypeCoverage.ts's getArchetypesWithChapterTopic, the orchestrator's
-- findArchetypesForTopic, server.ts's own family-mining route, and the new
-- studentExplanationBackfill.ts) -- forced a full sequential scan of the
-- whole table on every call.
--
-- Two indexes, covering both actual query shapes in this codebase:
-- critic_decision alone (Stage 3 recovery's own query, and the
-- review-queue's broader "what got REVIEWed" style lookups), and the
-- (status, critic_decision) pair together (every "accepted archetypes"
-- query above, which always filters both).
-- ---------------------------------------------------------------------------

create index if not exists archetypes_critic_decision_idx
  on public.archetypes using btree (critic_decision);

create index if not exists archetypes_status_critic_decision_idx
  on public.archetypes using btree (status, critic_decision);
