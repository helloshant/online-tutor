// Mirrors the relevant subset of services/archetype-miner/src/types.ts --
// duplicated, not imported, same reasoning every other service boundary in
// this repo already follows (each service/app here is an independently
// deployable project with its own package.json, no shared workspace
// package to import from). Only what the admin UI actually renders/submits
// is included here -- SegmentedQuestion/QuestionSignature/ClusterInput
// never reach this app directly, so they're not duplicated.

export type EducationStage = "secondary" | "senior_secondary" | "undergraduate";
export type CurriculumSourceType = "school_board" | "university_program";

export type CurriculumSource = {
  type: CurriculumSourceType;
  name: string;
  country_or_region: string | null;
  taxonomy_supplied: boolean;
};

export type EducationContext = {
  education_stage: EducationStage;
  grade_or_year: string;
  curriculum_source: CurriculumSource;
  subject_or_course: string;
  program_or_stream: string | null;
};

export type ArchetypeVariation = {
  variation_id: string;
  description: string;
  variation_type: string;
  supporting_question_ids: string[];
};

export type ArchetypeStatus = "candidate" | "reviewed" | "final";
export type CriticDecision = "KEEP" | "MERGE" | "SPLIT" | "REVISE" | "REVIEW" | "ADD" | "REMOVE";

export type Archetype = {
  archetype_id: string;
  education_context: EducationContext;
  name: string;
  concept: string;
  learning_objective: string;
  invariant_reasoning_structure: string;
  variations: ArchetypeVariation[];
  supporting_question_ids: string[];
  stats: {
    question_count: number;
    years_observed: number[];
    first_observed_year: number | null;
    last_observed_year: number | null;
    marks_distribution: Record<string, number>;
    formats: Record<string, number>;
    difficulty_distribution: { Easy: number; Medium: number; Hard: number };
    grade_or_year_distribution: Record<string, number>;
  };
  generator_usable: boolean;
  generator_usability_rationale: string;
  mining_confidence: number;
  status: ArchetypeStatus;
  critic_decision: CriticDecision | null;
  critic_rationale: string | null;
  critic_evidence: string[];
  merge_target_id: string | null;
  split_result_ids: string[];
  possible_duplicate_of: string[];
};

// Row shape of the archetypes table (archetype jsonb column + the
// denormalized columns the admin UI filters/sorts on directly).
export type ArchetypeRow = {
  archetype_id: string;
  run_id: string;
  education_context: EducationContext;
  archetype: Archetype;
  status: ArchetypeStatus;
  critic_decision: CriticDecision | null;
  mining_confidence: number | null;
  created_at: string;
  updated_at: string;
};

export type PipelineInputKind = "raw_papers" | "pre_segmented";
export type PipelineStatus =
  | "pending"
  | "segmenting"
  | "analyzing"
  | "embedding"
  | "clustering"
  | "mining"
  | "critiquing"
  | "completed"
  | "failed";

export type PipelineRunStats = {
  segmented?: number;
  // Papers whose own Stage 0 call failed (most commonly a truncated
  // response) but every OTHER paper in the same batch still ran normally
  // -- see pipelineRunner.ts's per-paper try/catch in the service.
  papers_failed?: number;
  analyzed?: number;
  // Segmented records excluded from Stage 1 onward because they're purely
  // a shared stem/stimulus holder for other records, not an independently
  // gradable unit of their own -- not a failure, see pipelineRunner.ts's
  // own comment (excludeStemOnlyParents) in the service.
  stems_excluded?: number;
  clusters?: number;
  mined?: number;
  reviewed?: number;
  review_queue?: number;
};

export type PipelineRunRow = {
  id: string;
  education_context: EducationContext;
  input_kind: PipelineInputKind;
  // Resolved once at submission time (explicit choice, or the service's
  // own LLM_PROVIDER default) and fixed for the run's whole lifetime --
  // see supabase/migrations/0040_archetype_miner_llm_provider.sql and
  // pipelineRunner.ts's submitRun.
  llm_provider: "anthropic" | "azure-openai";
  status: PipelineStatus;
  stats: PipelineRunStats;
  error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type ReviewQueueSource = "stage1_low_confidence" | "stage2_ambiguous_cluster" | "stage3_review_flag";
export type ReviewQueueStatus = "pending" | "resolved";

export type ReviewQueueRow = {
  queue_item_id: string;
  run_id: string;
  source: ReviewQueueSource;
  reference_id: string;
  reason: string;
  confidence: number | null;
  status: ReviewQueueStatus;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
};

export type ArchetypeFamilyRow = {
  family_id: string;
  family_name: string;
  member_archetype_ids: string[];
  progression_notes: string;
  subject_or_course: string;
  created_at: string;
  updated_at: string;
};

export type ArchetypeCurriculumTaxonomyRow = {
  id: string;
  curriculum_source_type: CurriculumSourceType;
  curriculum_source_name: string;
  country_or_region: string | null;
  taxonomy_text: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};
