-- Lets an admin choose Anthropic or Azure OpenAI per pipeline run (and per
-- family-mining call) instead of the whole archetype-miner service being
-- locked to whatever LLM_PROVIDER its own .env.local sets -- e.g. Anthropic
-- for a PDF-based paper (native document reading, only supported on that
-- path) while defaulting to Azure OpenAI otherwise, when an admin has both
-- providers' credentials configured.
--
-- Resolved once at submission time (see pipelineRunner.ts's submitRun) and
-- stored here rather than only living in the request -- a run can take
-- minutes to hours, and every stage call for that run must keep using the
-- SAME provider throughout even if the service's own LLM_PROVIDER default
-- changes mid-run.
--
-- not null default 'anthropic': true for every run that already exists --
-- this service has only ever had a single, Anthropic-defaulting
-- LLM_PROVIDER resolution until now, so this is a real backfill value, not
-- a placeholder standing in for genuinely unknown history.
alter table public.archetype_pipeline_runs
  add column llm_provider text not null default 'anthropic'
    check (llm_provider in ('anthropic', 'azure-openai'));
