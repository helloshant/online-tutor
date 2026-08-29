// Every type here is a fixed JSON contract, referenced by ID from every
// stage's prompt (see prompts.ts) rather than restated per prompt --
// design principle #1 in CBSE_Archetype_Pipeline_Redesign.md ("schema-
// first"). This file merges that base (v1) spec with its multi-level
// delta (Archetype_Pipeline_Redesign_v2_multilevel.md), which generalizes
// every schema from "CBSE Class 10 only" to any board/university program
// via the new EducationContext object -- v1 field names/shapes are kept
// exactly where the delta says "everything else unchanged"; only the
// specific fields the v2 doc calls out are added or widened.

// ---------------------------------------------------------------------------
// EducationContext (v2 §1) -- carried by every SegmentedQuestion,
// QuestionSignature, and Archetype. Archetypes are scoped to
// (education_stage, curriculum_source, subject_or_course) by default: a
// grade-9 archetype and a Bachelor's archetype are never silently merged
// just because their abstract_structure text looks similar.
// ---------------------------------------------------------------------------

export type EducationStage = "secondary" | "senior_secondary" | "undergraduate";

export type CurriculumSourceType = "school_board" | "university_program";

export type CurriculumSource = {
  type: CurriculumSourceType;
  // e.g. "CBSE", "ICSE", "IB Diploma", "Anna University B.Tech CSE",
  // "University of Delhi B.Sc Physics (Hons)".
  name: string;
  country_or_region: string | null;
  // True if a curriculum taxonomy document was provided for this source.
  // Most university courses won't have one the way CBSE/NCERT does --
  // false is the expected default for those, not an edge case (v2 §1, §7).
  taxonomy_supplied: boolean;
};

export type EducationContext = {
  education_stage: EducationStage;
  // e.g. "9", "11", "UG-2" (2nd year Bachelor's).
  grade_or_year: string;
  curriculum_source: CurriculumSource;
  // e.g. "Mathematics", "Data Structures and Algorithms", "Organic Chemistry II".
  subject_or_course: string;
  // e.g. "Science (PCM)", "B.Tech Computer Science" -- null for school
  // stages where not yet applicable.
  program_or_stream: string | null;
};

// ---------------------------------------------------------------------------
// 1.1 SegmentedQuestion (Stage 0 output -> Stage 1 input)
// ---------------------------------------------------------------------------

export type PaperType = "board_exam" | "sample_paper" | "compartment";
export type ExtractionMethod = "native_text" | "ocr";

export type PaperMeta = {
  subject: string;
  year: number;
  // v1 fixed this at "CBSE" -- widened to any board/institution name per
  // v2's generalization; the real scoping identity now lives on
  // education_context.curriculum_source, this is paper-level metadata.
  board: string;
  // v1 fixed this at 10 -- widened to a string (mirrors
  // education_context.grade_or_year, e.g. "10", "12", "UG-2").
  class: string;
  set_code: string | null;
  paper_type: PaperType;
  source_url: string;
  extraction_method: ExtractionMethod;
};

export type SegmentedQuestion = {
  // Stable unique id, e.g. "CBSE-MATH-2019-SET1-Q17-i".
  question_id: string;
  // Set if this is a sub-part of a larger stem.
  parent_question_id: string | null;
  education_context: EducationContext;
  paper: PaperMeta;
  marks: number | null;
  raw_text: string;
  cleaned_text: string;
  has_diagram: boolean;
  has_internal_choice: boolean;
  extraction_confidence: number;
  extraction_notes: string | null;
};

// ---------------------------------------------------------------------------
// 1.2 QuestionSignature (Stage 1 output -> clustering + Stage 2 input)
// ---------------------------------------------------------------------------

// v2 §2.2: expanded to cover Bachelor's-level formats (derivation,
// lab_report, essay, case_study, coding_problem, viva_style,
// open_ended_research, thesis_excerpt) alongside the original v1 set.
export type QuestionFormat =
  | "MCQ"
  | "short_answer"
  | "long_answer"
  | "case_based"
  | "assertion_reason"
  | "fill_blank"
  | "true_false"
  | "proof"
  | "numerical"
  | "source_based"
  | "data_interpretation"
  | "derivation"
  | "lab_report"
  | "essay"
  | "case_study"
  | "coding_problem"
  | "viva_style"
  | "open_ended_research"
  | "thesis_excerpt"
  | "other";

export type QuestionContext =
  | "pure_mathematics"
  | "real_world_application"
  | "science_application"
  | "finance"
  | "geometry"
  | "physics"
  | "chemistry"
  | "biology"
  | "social_context"
  | "historical_context"
  | "textual"
  | "diagram_based"
  | "data_based"
  | "other";

export type CognitiveLevel = "Remember" | "Understand" | "Apply" | "Analyze" | "Evaluate" | "Create";
export type ReasoningDirection = "forward" | "reverse" | "mixed";
export type Difficulty = "Easy" | "Medium" | "Hard";
export type TaxonomyMatch = "matched" | "no_match";

export type QuestionSignature = {
  question_id: string;
  education_context: EducationContext;
  curriculum: {
    subject: string;
    chapter: string;
    topic: string;
    concept: string;
    sub_concept: string | null;
    taxonomy_match: TaxonomyMatch;
  };
  // Observable, e.g. "Determine the nature of roots using the discriminant."
  learning_objective: string;
  skills: {
    primary: string;
    secondary: string[];
  };
  // Ordered steps a competent student takes -- the reasoning MOVE, never
  // copied solution arithmetic/prose.
  reasoning_pattern: string[];
  // Stripped of names/numbers/context -- the underlying structure only.
  abstract_structure: string;
  format: QuestionFormat;
  context: QuestionContext;
  cognitive_level: CognitiveLevel;
  reasoning_direction: ReasoningDirection;
  difficulty: Difficulty;
  // 1 sentence citing which factors drove the rating.
  difficulty_rationale: string;
  // v2 §2.2: MUST state what the difficulty rating is relative to, e.g.
  // "relative to grade 9 CBSE Mathematics expectations" -- a "Hard" grade-9
  // question and a "Hard" Bachelor's question are never comparable in
  // absolute terms.
  difficulty_reference_frame: string;
  confidence: {
    curriculum: number;
    reasoning_pattern: number;
    overall: number;
  };
  flags: string[];
};

// ---------------------------------------------------------------------------
// 1.3 ClusterInput (embedding/clustering output -> Stage 2 input)
// ---------------------------------------------------------------------------

export type ClusterDiagnostics = {
  // From the clustering algorithm, e.g. mean pairwise cosine similarity.
  intra_cluster_cohesion: number;
  // Clusters this one is closest to, for split-detection -- lets Stage 2
  // catch "same archetype split across two clusters" without needing full
  // cross-cluster memory.
  nearest_neighbor_clusters: string[];
};

export type ClusterInput = {
  cluster_id: string;
  // Every member of a cluster shares one education_context scope by
  // construction (clustering.ts never mixes scopes) -- carried here so
  // Stage 2's prompt has it without re-deriving from member_signatures[0].
  education_context: EducationContext;
  // "signature" -- concatenation of learning_objective + reasoning_pattern
  // + abstract_structure (see embeddingBasis() in clustering.ts).
  embedding_basis: "signature";
  member_signatures: QuestionSignature[];
  cluster_diagnostics: ClusterDiagnostics;
};

// ---------------------------------------------------------------------------
// 1.4 Archetype (Stage 2 output, Stage 3 input/output, final catalogue)
// ---------------------------------------------------------------------------

export type VariationType =
  | "condition"
  | "reasoning_direction"
  | "context_type"
  | "format"
  | "abstraction_level"
  | "unknown_count"
  | "concept_count"
  | "application_vs_direct"
  | "other";

export type ArchetypeVariation = {
  variation_id: string;
  // Meaningful modifier only, never numbers/names.
  description: string;
  variation_type: VariationType;
  supporting_question_ids: string[];
};

export type ArchetypeStatus = "candidate" | "reviewed" | "final";

export type CriticDecision = "KEEP" | "MERGE" | "SPLIT" | "REVISE" | "REVIEW" | "ADD" | "REMOVE";

export type Archetype = {
  archetype_id: string;
  education_context: EducationContext;
  // Concise, concept-independent, action-oriented.
  name: string;
  // Curriculum concept it belongs to -- must match a
  // QuestionSignature.curriculum.concept.
  concept: string;
  learning_objective: string;
  invariant_reasoning_structure: string;
  variations: ArchetypeVariation[];
  // All questions under this archetype, across variations.
  supporting_question_ids: string[];
  stats: {
    question_count: number;
    years_observed: number[];
    first_observed_year: number | null;
    last_observed_year: number | null;
    marks_distribution: Record<string, number>;
    formats: Record<string, number>;
    difficulty_distribution: { Easy: number; Medium: number; Hard: number };
    // v2 §2.3: lets a later pass see whether a reasoning pattern actually
    // recurs across grades/years within one scope, without conflating
    // separate archetypes to get there.
    grade_or_year_distribution: Record<string, number>;
  };
  // Structural check: does the description name a reusable operation +
  // parameter space?
  generator_usable: boolean;
  generator_usability_rationale: string;
  // Stage 2's confidence that this is a coherent single archetype.
  mining_confidence: number;
  status: ArchetypeStatus;
  critic_decision: CriticDecision | null;
  critic_rationale: string | null;
  critic_evidence: string[];
  // Set when critic_decision = MERGE.
  merge_target_id: string | null;
  // Set when critic_decision = SPLIT -- references new child archetypes.
  split_result_ids: string[];
  // Stage 2's own cross-cluster split-check output (prompts.ts §Stage 2,
  // "CROSS-CLUSTER SPLIT CHECK") -- cluster_ids Stage 2 suspects represent
  // the same true archetype as this one, for Stage 3 to verify against.
  possible_duplicate_of: string[];
};

// ---------------------------------------------------------------------------
// 2.4 ArchetypeFamily (v2 §2.4) -- cross-level progression. Explicitly NOT
// required for v1 of the multi-level system ("not something to build into
// Stage 2/3 yet -- flag it as a future extension"). Defined here only so
// the schema doesn't need to change again later; no pipeline stage in this
// service produces or persists it yet.
// ---------------------------------------------------------------------------

export type ArchetypeFamily = {
  family_id: string;
  family_name: string;
  // One archetype_id per education_stage/level where this reasoning skill recurs.
  member_archetype_ids: string[];
  progression_notes: string;
};

// ---------------------------------------------------------------------------
// Section 6: human review queue -- the defined destination for every
// "I'm not sure" state (a Stage 1 signature below the confidence threshold,
// a Stage 2 cluster flagged ambiguous/incomplete, every Stage 3
// critic_decision:'REVIEW') so REVIEW is never a dead end.
// ---------------------------------------------------------------------------

export type ReviewQueueSource = "stage1_low_confidence" | "stage2_ambiguous_cluster" | "stage3_review_flag";
export type ReviewQueueStatus = "pending" | "resolved";

export type ReviewQueueItem = {
  queue_item_id: string;
  source: ReviewQueueSource;
  // question_id or archetype_id.
  reference_id: string;
  reason: string;
  confidence: number | null;
  status: ReviewQueueStatus;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
};

// ---------------------------------------------------------------------------
// Pipeline run tracking -- this service's own addition (not part of either
// source doc), matching supabase/migrations/0038_archetype_miner.sql's
// archetype_pipeline_runs table.
// ---------------------------------------------------------------------------

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
  analyzed?: number;
  clusters?: number;
  mined?: number;
  reviewed?: number;
  review_queue?: number;
};

export type PipelineRun = {
  id: string;
  education_context: EducationContext;
  input_kind: PipelineInputKind;
  status: PipelineStatus;
  stats: PipelineRunStats;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

// Either a raw paper's text (Stage 0 will segment it) or an
// already-segmented question (Stage 0 is skipped for these) -- a run's
// input_kind determines which shape the API expects, checked once at
// submission time (see server.ts).
//
// raw_text and pdf_base64 are both optional here at the type level, but
// server.ts requires exactly one non-empty value at submission time: a
// paper is either pre-extracted text, or an actual PDF Stage 0 reads
// directly (Anthropic's native document understanding -- see
// anthropicProvider.ts), never both and never neither.
export type RawPaperInput = {
  // Echoed onto every SegmentedQuestion this paper produces.
  paper: PaperMeta;
  raw_text?: string;
  // Base64-encoded PDF bytes, no "data:" URL prefix.
  pdf_base64?: string;
};

export type PreSegmentedInput = Omit<SegmentedQuestion, "education_context">;
