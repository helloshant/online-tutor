// Every prompt below is the source doc's own prompt text (base v1 +
// multi-level v2 delta folded in at the point each delta section says to
// add it), not a paraphrase -- design principle #1 ("schema-first," see
// types.ts) extends to the prompts themselves: they're a fixed contract,
// not something to freely rephrase per call site. The OFF-SCOPE CONTENT
// section in buildAnalyzerPrompt below is the one deliberate addition
// beyond that base spec (see its own comment for why).

import { OFF_SCOPE_CONTENT_FLAG } from "./types.js";

// ---------------------------------------------------------------------------
// Stage 0 -- Segmenter
// ---------------------------------------------------------------------------

export function buildSegmenterPrompt(): string {
  return `ROLE
You are an examination paper segmenter, covering secondary, senior
secondary, and undergraduate examinations across any school board or
university program.

INPUT FORMAT
The paper is given to you one of two ways: as a "raw_text" field in the JSON
envelope below, or as an attached PDF document (in which case raw_text will
read "(see attached PDF document)" -- read the paper directly off the PDF's
pages instead, including any diagrams, tables, and mathematical notation
they contain). Either way, the same SEGMENTATION RULE and schema apply.

TASK
Given the raw extracted text of one examination paper (or one section of a
paper), split it into individual SegmentedQuestion records conforming to the
SegmentedQuestion schema. The education_context you are given for this batch
is fixed for every record you produce -- copy it onto each record unchanged,
you are not inferring it.

SEGMENTATION RULE
Create one record per smallest independently-gradable reasoning unit:
- A stem with sub-parts (i)/(ii)/(iii) that require DIFFERENT reasoning
  becomes multiple records sharing one parent_question_id. WHENEVER you set
  parent_question_id on any record to a value, you MUST ALSO emit exactly
  one record of your own whose question_id equals that same value, holding
  the shared stem/stimulus text itself (raw_text/cleaned_text; marks null
  unless the stem itself was awarded marks separately from its parts). A
  parent_question_id that doesn't resolve to one of your own records'
  question_id values is invalid output.
- A stem where sub-parts are trivial continuations of the same reasoning
  (e.g. "hence, find...") stays as ONE record.
- Internal "OR" choices become SIBLING records (has_internal_choice: true),
  never variants of a single record -- a student encounters them as distinct
  question options, not modifications of one question.
- Case-based / source-based questions with multiple sub-questions on one
  shared stimulus: create one record per sub-question, and store the shared
  stimulus text once, referenced by all sibling records via parent_question_id.
- Undergraduate material: long-form derivations, multi-part lab reports,
  and case-study analyses are common at this level and often span a page or
  more as one gradable unit. The "smallest independently-gradable unit" rule
  still applies, but do NOT fragment a single derivation into separate
  records line-by-line -- a derivation with one continuous logical thread is
  one record even if it runs to 15 steps. Fragment only where the paper
  itself awards marks separately (e.g., "(a) Derive... (5 marks) (b) Hence
  show... (3 marks)").

DO NOT:
- Correct mathematical or factual errors in the source text -- flag them
  in extraction_notes instead.
- Merge sub-parts because they "feel similar" -- merging is a Stage 2/3
  judgment, not a Stage 0 judgment. Stage 0 only decides gradable-unit
  boundaries, never reasoning-similarity.
- Infer marks for sub-parts if the paper only gives a total; if marks
  cannot be confidently split, set marks to the total on the parent and
  null on children, and add an extraction_note explaining this.
- Turn a paper's own non-question material into a fake SegmentedQuestion
  record: cover pages, general/exam-wide instructions ("General
  Instructions" / "सामान्य निर्देश," section-structure notes like "Section
  A contains 16 MCQs of 1 mark each"), section headers, blank marking-
  scheme space, or a source/case-study STEM that has no sub-question
  attached to it at all. None of these is an independently-gradable
  reasoning unit -- skip them entirely, the same as you'd skip whitespace
  between questions. Confirmed live in production: a paper's own general-
  instructions block, in Hindi, was segmented as if it were a real
  question and reached later stages as one. This is never in tension with
  the COMPLETENESS rule below -- a paper's own stated question COUNT
  refers to its actual gradable questions, never its instructions pages,
  so correctly skipping non-question material is not "stopping early."

OCR / EXTRACTION QUALITY
If extraction_method is "ocr", set extraction_confidence conservatively.
Flag (in extraction_notes) any symbol, diagram reference, or table that
could not be reliably recovered -- do not guess at illegible content. This
is a PER-QUESTION judgment, never a whole-paper one: if some questions are
clearly legible and others are noisy or reference a diagram/graph the OCR
couldn't recover, segment every question you CAN confidently read, and
flag only the individual ones you genuinely cannot (low
extraction_confidence, a note explaining what's missing) -- never respond
with an empty result because part of the paper is noisy. A paper with any
segmentable content in it must never produce zero records.

BILINGUAL / DUAL-LANGUAGE PAPERS
Some boards (e.g. CBSE) print every question twice on the same paper --
once in Hindi, once in English, as two side-by-side or sequential blocks
that are translations of the same underlying question, not two different
questions. Do not create two records for the same question just because it
appears twice, and do not let this duplication stop you from segmenting
the paper. Produce ONE record per underlying question: prefer the English
version verbatim as raw_text/cleaned_text when both are present and
legible (this pipeline's own downstream classification stages work in
English); if only the Hindi version is legible, use that instead, in the
original Hindi, never translated (a translation is not "verbatim").

WORKED EXAMPLES
- Math (single-stem quadratic problem) -> 1 record.
- Science: case-based question with 3 sub-parts on a diagram of the human
  eye, where (i) is a label-recall and (iii) is an application question ->
  3 records, shared parent.
- Social Science: source-based history question with an excerpt and 2
  sub-questions of genuinely different cognitive level -> 2 records, shared
  parent, shared source excerpt stored once.
- Undergraduate (Physics lab report): "Derive the expression for the
  moment of inertia of a uniform disc about its central axis, and hence
  calculate the theoretical value for the given disc parameters (8 marks)."
  -> ONE record (the derivation and the "hence calculate" are one
  continuous reasoning thread; marks were not awarded separately in the
  paper).

SCHEMA
Return each record with EXACTLY these fields, no others -- do not invent
fields like "type", "options", "stimulus", "context", or "sequence_number",
and do not omit any of these:
{
  "question_id": "<a stable unique id you assign, e.g. CBSE-MATH-2019-SET1-Q17-i>",
  "parent_question_id": "<the question_id of the shared stem, or null if this record has no parent -- see the SEGMENTATION RULE above: this MUST match one of your own records' own question_id>",
  "paper": <copy the "paper" object from the input envelope, unchanged>,
  "marks": <number, or null -- see the DO NOT rule on inferring split marks>,
  "raw_text": "<the question exactly as it appears in the source, verbatim>",
  "cleaned_text": "<raw_text with OCR noise/formatting artifacts cleaned up -- same content, never reworded>",
  "has_diagram": <true if this question references or requires a diagram/figure>,
  "has_internal_choice": <true only for a sibling record of an internal OR choice>,
  "extraction_confidence": <number from 0 to 1>,
  "extraction_notes": "<free text on anything uncertain/illegible, or null>"
}
Do NOT include education_context on your output records -- it is stamped
on by the caller after your response, so there is nothing to gain by
adding it and it will be overwritten if you do.

COMPLETENESS
Segment the ENTIRE input, start to finish -- every question in the paper,
not just the first several. A long paper means a long response; that is
expected and correct, never a reason to stop early or summarize the
remainder. If the paper states its own total question count (e.g. "This
question paper contains 33 questions" / "इस प्रश्न-पत्र में 33 प्रश्न हैं"),
your output's top-level question count (records with parent_question_id
null) should match it -- treat a large shortfall against a stated count as
a sign you stopped too soon, not as a legitimate result. Producing a
shorter response by silently dropping questions from the middle or end of
a long paper is a failure of this task, not an acceptable simplification of
it, even when every record you DID produce is individually correct.

OUTPUT
Return ONLY a JSON array of SegmentedQuestion objects, each matching the
SCHEMA above exactly. No markdown, no explanatory prose.`;
}

// ---------------------------------------------------------------------------
// Stage 1 -- Question Analyzer
// ---------------------------------------------------------------------------

export function buildAnalyzerPrompt(params: { taxonomySupplied: boolean; curriculumTaxonomyText?: string }): string {
  const { taxonomySupplied, curriculumTaxonomyText } = params;

  const taxonomySection = taxonomySupplied
    ? `Use the supplied curriculum taxonomy below. If a matching concept exists, use
it exactly and set taxonomy_match = "matched". If no matching concept exists
in the supplied taxonomy, propose the closest reasonable concept name, set
taxonomy_match = "no_match", and lower curriculum confidence accordingly. Do
not silently invent a taxonomy node without flagging it.

SUPPLIED CURRICULUM TAXONOMY
${curriculumTaxonomyText ?? "(none provided for this batch despite taxonomy_supplied=true -- treat as no_match)"}`
    : `No curriculum taxonomy document was supplied for this education_context
(taxonomy_supplied = false -- the expected default for most university
courses, not an edge case). Classify curriculum.concept etc. using your own
subject-matter knowledge and any syllabus/course-outline text provided with
this batch. Cap curriculum confidence at 0.7 or below and set taxonomy_match
= "no_match". If the course/subject is niche enough that classification is
genuinely uncertain (e.g. a highly specialized final-year elective), add a
free-text note to the flags array saying so.`;

  return `ROLE
You are an expert curriculum analyst and assessment designer, covering
Mathematics, Science, Social Science/Humanities, and undergraduate subjects
across any school board or university program.

INPUT
One SegmentedQuestion object (already isolated to a single gradable
reasoning unit -- do not re-segment it), carrying its own education_context.

TASK
Convert the question into a QuestionSignature. You are extracting and
classifying WHAT the question tests and HOW a student must reason -- you
are NOT naming an archetype and NOT rewriting or generating a question.
Echo the input's education_context onto your output unchanged -- you do not
infer it, it is supplied.

CORE PRINCIPLE
Ignore superficial wording. Two questions with different wording but the
same underlying reasoning process should produce similar signatures. Two
questions with similar wording but materially different reasoning should
produce different signatures.

DIMENSIONS TO ANALYZE

Curriculum
${taxonomySection}

OFF-SCOPE CONTENT (check this BEFORE curriculum classification)
Every question you're given was already stamped with a fixed
education_context (subject_or_course, grade_or_year) by the caller --
Stage 0 (Segmentation) copies it onto every record from the paper
unchanged, without checking it, so a paper submitted under the wrong
subject/grade, or one that happens to bundle a DIFFERENT subject's
content on the same pages (e.g. an English composition/writing section
printed in the same document as a Biology paper), reaches you carrying
that same wrong label with nothing upstream having caught it yet. You are
the first stage that actually reads the content for what it is, so this
is your check to make.
Confirmed live in production: exactly this slipped all the way through
and got mined into a real, student-facing archetype -- a "Biology"
question that was actually an English poem's own multiple-choice
question about symbolism, and separately, real Biology content that was
actually a DIFFERENT grade's own syllabus chapter, not this grade's.
If this question's actual subject matter clearly does NOT belong to the
declared subject_or_course (a different subject's content entirely -- a
poem, an essay-writing prompt, a different science), OR clearly belongs
to a different grade/level's own syllabus than the declared grade_or_year
(you may need your own subject-matter knowledge of what each grade
actually covers to recognize this, not just the taxonomy document if one
was supplied):
- Set curriculum.taxonomy_match to "no_match" and cap curriculum
  confidence at 0.2 or below.
- Add the EXACT flag string "${OFF_SCOPE_CONTENT_FLAG}" to the flags
  array (this exact string, not a paraphrase -- it's checked
  programmatically downstream to keep this question out of clustering
  and mining entirely, so it never becomes a mined archetype's own
  supporting evidence).
- Still fill in curriculum/learning_objective/etc as best you can from
  the actual content -- do not leave other fields empty or refuse to
  produce a signature; this flag is what routes the question to human
  review, not an excuse to skip analyzing it.
Do NOT flag a question just because it's an unusually-phrased or
borderline-difficult example of the declared subject/grade, and do NOT
flag it merely because its exact chapter/topic wording doesn't match a
supplied taxonomy document -- that's ordinary taxonomy_match: "no_match"
territory, not this flag. This flag is specifically for content that
plainly belongs to a DIFFERENT subject or a DIFFERENT grade's own
syllabus, not merely unfamiliar or hard to classify.

Learning objective
State what the student must demonstrate, as an observable action.
Good: "Determine the nature of roots using the discriminant."
Good: "Interpret a titration graph to identify the equivalence point."
Bad: "Understand quadratic equations." (not observable)
Bad: "Know about acids and bases." (not observable)

Skills
Identify primary and secondary skills from: computation, algebraic
manipulation, interpretation, comparison, logical reasoning, proof,
inference, construction, application, data interpretation, source
analysis, evaluation.

Reasoning pattern
An ordered list of steps a competent student takes. Do not copy solution
prose from source material -- describe the reasoning move, not the
arithmetic.
Example (Math): ["Identify coefficients", "Calculate discriminant",
"Compare discriminant with zero", "Classify the roots"]
Example (Science): ["Identify the independent and dependent variable in
the graph", "Locate the point where reaction rate changes", "Relate that
point to the underlying chemical process"]
Example (History/source-based): ["Identify the perspective of the
source's author", "Cross-reference the claim against the stated
historical context", "Draw an inference about intent or bias"]
Example (Undergraduate -- Data Structures): ["Identify the operation being
analyzed (insertion/deletion/search)", "Determine the relevant data
structure's underlying representation", "Derive time complexity by
counting operations relative to input size n", "Express result in Big-O
notation"]

Abstract structure
Strip names, numbers, specific entities, and wording. Represent the
underlying structure only.
Example: "Quadratic equation containing unknown parameter + condition on
roots -> determine parameter."
Example: "Given a labeled diagram of an organ system, identify structure
by function description."
Example (Undergraduate -- Data Structures): "Given an operation on a
specified data structure, determine asymptotic time/space complexity."

Format
One of: MCQ, short_answer, long_answer, case_based, assertion_reason,
fill_blank, true_false, proof, numerical, source_based, data_interpretation,
derivation, lab_report, essay, case_study, coding_problem, viva_style,
open_ended_research, thesis_excerpt, other. Question format diversity goes
up a lot at undergraduate level -- expect proportionally more derivation,
coding_problem, essay, and lab_report formats there, and fewer clean
MCQ/short_answer items than at secondary level.

Context
One of: pure_mathematics, real_world_application, science_application,
finance, geometry, physics, chemistry, biology, social_context,
historical_context, textual, diagram_based, data_based, other.

Cognitive level
Remember | Understand | Apply | Analyze | Evaluate | Create.

Reasoning direction
- forward: given information -> apply known method -> obtain result.
- reverse: given desired property/result -> infer unknown condition.
- mixed: both required.

Difficulty
Rate Easy | Medium | Hard, and in difficulty_rationale state the 1-2
factors that drove the rating (e.g. "two-step reverse reasoning, single
concept" = Medium; "single forward computation, one concept" = Easy;
"multi-concept synthesis with reverse reasoning" = Hard). Do not infer
difficulty from marks value alone -- a 1-mark question can be Hard, a
5-mark question can be Easy if it is long but mechanical.
In difficulty_reference_frame, state explicitly what level this rating is
relative to, e.g. "relative to grade 9 CBSE Mathematics expectations" or
"relative to a 2nd-year B.Tech DSA course." A "Hard" grade-9 question and a
"Hard" Bachelor's question are NOT comparable in absolute terms -- never
imply that they are.

Confidence
Score curriculum, reasoning_pattern, and an overall confidence from 0-1.
Lower confidence when: chapter mapping is ambiguous, OCR quality is poor
(check the SegmentedQuestion's own extraction_confidence), the question
is incomplete, multiple interpretations are plausible, or required
diagrams/data were flagged missing upstream.

Flags
Populate the flags array with any of: ocr_uncertain,
diagram_required_but_missing, ambiguous_interpretation, "${OFF_SCOPE_CONTENT_FLAG}"
(see the OFF-SCOPE CONTENT section above -- use this EXACT string, never
a paraphrase, when it applies), or a free-text flag if none of these fit.

SCHEMA
Return EXACTLY these fields, no others:
{
  "question_id": "<echo the input SegmentedQuestion's own question_id, unchanged>",
  "curriculum": {
    "subject": "<e.g. Mathematics>",
    "chapter": "<e.g. Quadratic Equations>",
    "topic": "<e.g. Nature of Roots>",
    "concept": "<e.g. Discriminant-based root classification>",
    "sub_concept": "<narrower than concept, or null>",
    "taxonomy_match": "matched" | "no_match"
  },
  "learning_objective": "<one observable-action sentence, see the Learning objective examples above>",
  "skills": { "primary": "<one skill from the Skills list above>", "secondary": ["<zero or more others>"] },
  "reasoning_pattern": ["<step 1>", "<step 2>", "..."],
  "abstract_structure": "<stripped of names/numbers, structure only>",
  "format": "<one value from the Format list above>",
  "context": "<one value from the Context list above>",
  "cognitive_level": "Remember" | "Understand" | "Apply" | "Analyze" | "Evaluate" | "Create",
  "reasoning_direction": "forward" | "reverse" | "mixed",
  "difficulty": "Easy" | "Medium" | "Hard",
  "difficulty_rationale": "<1-2 sentences citing the factors that drove the rating>",
  "difficulty_reference_frame": "<what level this rating is relative to, see the Difficulty section above>",
  "confidence": { "curriculum": <0-1>, "reasoning_pattern": <0-1>, "overall": <0-1> },
  "flags": ["<zero or more of: ocr_uncertain, diagram_required_but_missing, ambiguous_interpretation, ${OFF_SCOPE_CONTENT_FLAG}, or free text>"]
}
Do NOT include education_context on your output -- it is stamped on by the
caller after your response, so there is nothing to gain by adding it and
it will be overwritten if you do.

OUTPUT
Return ONLY one QuestionSignature JSON object matching the SCHEMA above
exactly. No markdown, no explanatory prose.`;
}

// ---------------------------------------------------------------------------
// Stage 2 -- Archetype Miner
// ---------------------------------------------------------------------------

export function buildMinerPrompt(): string {
  return `ROLE
You are an expert examination-pattern researcher and assessment taxonomy
designer, covering Mathematics, Science, Social Science/Humanities, and
undergraduate subjects across any school board or university program.

INPUT
One ClusterInput object: a set of QuestionSignature objects that an
embedding+clustering step grouped together, plus diagnostics including
which neighboring clusters are closest to this one. Every member shares one
education_context scope -- you are never shown a mix of grades, boards, or
courses in one cluster.

HARD CONSTRAINT
Only mine archetypes within this one education_context scope. Do not
propose an archetype spanning multiple grades, boards, or courses -- if you
believe two questions from genuinely different scopes are testing "the
same" skill, that is out of scope for you; a future cross-level
progression layer handles that relationship separately, it is never a
reason to merge them into one archetype here.

TASK
Determine whether this cluster represents one archetype, multiple
archetypes, an incomplete archetype, or an ambiguous grouping -- and
produce Archetype object(s) accordingly. You are discovering the taxonomy,
not generating questions.

DEFINITIONS
- An archetype is a fundamentally distinct reasoning pattern used to
  assess a concept. NOT a wording pattern, sentence template, specific
  number, specific historical question, or a particular student's
  solution.
- A variation is a meaningful modification of an archetype that preserves
  its fundamental reasoning structure.

PRIMARY DECISION RULE
Ask: "Would a competent student at this level use essentially the same
reasoning strategy to solve these questions?"
Give primary weight to each question's own reasoning_pattern,
abstract_structure, and reasoning_direction fields (already extracted in
Stage 1) -- do not re-derive this judgment from raw wording alone. If two
questions share reasoning_pattern shape and reasoning_direction but differ
in surface details, treat them as the same archetype with a variation.
If reasoning_direction or the reasoning_pattern sequence differs
materially, treat them as separate archetypes even if vocabulary overlaps.

WORKED EXAMPLE (Math)
These share reasoning_pattern shape [identify coefficients -> apply
discriminant condition -> solve for parameter] and reasoning_direction
"reverse":
- Find k so roots are equal.
- Find p so roots are real and distinct.
- Find m so roots are not real.
-> One archetype, "Determine parameter from root condition," three
variations by condition type.
"Calculate the discriminant and state the nature of roots" has
reasoning_direction "forward" and a different reasoning_pattern shape ->
separate archetype.

WORKED EXAMPLE (Science)
- "Identify which variable is controlled in this experiment" (Understand,
  forward) and "Design a controlled experiment to test X" (Create,
  forward-but-generative) share vocabulary ("controlled experiment") but
  materially different cognitive operations -> separate archetypes, not
  variations of one.

WORKED EXAMPLE (Social Science)
- "Identify the cause of event X from the source" and "Evaluate the
  reliability of the source describing event X" share a source-based
  format and the same historical context, but the first is Understand/
  extraction and the second is Evaluate/critical-appraisal -> separate
  archetypes.

WORKED EXAMPLE (Undergraduate -- MERGE)
"Derive time complexity of binary search" and "Derive time complexity of
merge sort" share reasoning_pattern shape [identify recurrence relation ->
solve recurrence -> express in Big-O] and reasoning_direction "forward" ->
one archetype, "Derive asymptotic complexity via recurrence relation,"
variations by algorithm family.

CROSS-CLUSTER SPLIT CHECK
Before finalizing, check cluster_diagnostics.nearest_neighbor_clusters.
If you strongly suspect this cluster and a neighbor represent the same
true archetype split by the embedding step, note this explicitly by
setting the archetype's own "possible_duplicate_of" field to the
neighboring cluster_id(s) you suspect, so Stage 3 can verify against the
neighbor's own mined archetype.

VARIATION RULES
A meaningful variation reflects: a different condition, different
reasoning direction, different context type, different question format,
different level of abstraction, different number of unknowns/concepts, or
application vs. direct mathematics/science. Changing only numbers or
names is NEVER a meaningful variation -- do not create a variation for it.

REQUIRED ANALYSIS
1. Determine one archetype, multiple archetypes, incomplete, or ambiguous.
2. Identify common concept and learning objective per archetype.
3. Identify the invariant reasoning structure per archetype.
4. Separate genuine variations from noise.
5. Identify questions in the cluster that do not belong to any archetype
   you're proposing (flag them, do not force-fit).
6. Note possible duplicate candidate archetypes (see cross-cluster check).
7. Preserve full traceability: every question_id must appear in exactly
   one archetype's supporting_question_ids (or be explicitly flagged as
   not belonging).
8. Write student_explanation per archetype -- see the SCHEMA's own field
   description for exactly what this is (and, just as importantly, what
   it is NOT: never invariant_reasoning_structure's task instruction
   restated).

NAMING
Concise, concept-independent where possible, action-oriented, reusable.
Good: "Determine parameter from root condition."
Good: "Evaluate source reliability from contextual cues."
Bad: "2021-style quadratic question." Bad: "Question involving k."

STATISTICS
Calculate stats ONLY from the supplied cluster's questions. Do not infer
years, counts, or distributions beyond what's present. If a field would
require data not in the input, omit it -- do not estimate or backfill.
Include grade_or_year_distribution (counts by
education_context.grade_or_year across the archetype's supporting
questions) alongside the other stats fields.

CONFIDENCE
Set mining_confidence per archetype: lower it when the cluster shows mixed
reasoning_direction values, low intra_cluster_cohesion, or borderline
membership calls in step 5.

SCHEMA
Return EXACTLY these fields per archetype, no others -- do not include
status, critic_decision, critic_rationale, critic_evidence,
merge_target_id, or split_result_ids, those are set later, not by you:
{
  "archetype_id": "<a stable id you assign, e.g. a short slug>",
  "name": "<see NAMING above>",
  "concept": "<must match a member question's curriculum.concept>",
  "learning_objective": "<observable, same style Stage 1 uses>",
  "invariant_reasoning_structure": "<ONE prose sentence/phrase naming the reasoning structure shared by every member/variation, e.g. Determine an unknown parameter from a stated condition on the roots, via the discriminant. This is NOT an array of steps -- do not reuse the shape of a QuestionSignature's own reasoning_pattern field (that's a list of steps for one question; this is a single descriptive string naming the shared structure across the whole archetype).>",
  "student_explanation": "<2-4 plain-language sentences explaining the underlying CONCEPT itself, written for a student seeing this pattern's name for the first time, shown to them BEFORE they attempt a question of this type. This is NOT invariant_reasoning_structure restated -- invariant_reasoning_structure is an instruction describing the TASK ('Describe the sequence of hormonal and neuroendocrine signaling events that regulate parturition'); student_explanation actually TEACHES the mechanism/method/idea itself (e.g. what oxytocin and the positive-feedback loop actually do during parturition, in plain terms), so a student who doesn't already know this concept comes away knowing it, not just knowing what they're about to be asked to do. Keep it self-contained and accurate -- never invent facts beyond what the supporting questions/curriculum concept establish, and never reference 'this archetype,' 'this pattern,' or any exam-taxonomy language; write as if explaining the idea itself to a student, in the same style as a good textbook aside.>",
  "variations": [
    {
      "variation_id": "<id you assign>",
      "description": "<meaningful modifier only, never numbers/names>",
      "variation_type": "condition" | "reasoning_direction" | "context_type" | "format" | "abstraction_level" | "unknown_count" | "concept_count" | "application_vs_direct" | "other",
      "supporting_question_ids": ["<question_id>", "..."]
    }
  ],
  "supporting_question_ids": ["<every question_id under this archetype, across all its variations>"],
  "stats": {
    "question_count": <number>,
    "years_observed": [<number>, "..."],
    "first_observed_year": <number or null>,
    "last_observed_year": <number or null>,
    "marks_distribution": { "<marks value as a string key>": <count> },
    "formats": { "<format value>": <count> },
    "difficulty_distribution": { "Easy": <number>, "Medium": <number>, "Hard": <number> },
    "grade_or_year_distribution": { "<grade_or_year value>": <count> }
  },
  "generator_usable": <boolean>,
  "generator_usability_rationale": "<why, or why not>",
  "mining_confidence": <0-1>,
  "possible_duplicate_of": ["<cluster_id from cluster_diagnostics.nearest_neighbor_clusters, if any>"]
}
Do NOT include education_context -- it is stamped on by the caller after
your response, so there is nothing to gain by adding it and it will be
overwritten if you do.

OUTPUT
Return ONLY valid JSON: an array of Archetype objects matching the SCHEMA
above exactly (status: "candidate" is added by the caller, not by you --
omit it). No markdown, no explanatory prose.`;
}

// ---------------------------------------------------------------------------
// Stage 3 -- Archetype Critic
// ---------------------------------------------------------------------------

export function buildCriticPrompt(): string {
  return `ROLE
You are a senior assessment-taxonomy reviewer, auditing a candidate
catalogue of question archetypes mined from a historical examination
corpus, across Mathematics, Science, Social Science/Humanities, and
undergraduate subjects, across any school board or university program.

INPUT
The full candidate Archetype catalogue for one education_context scope
(array of Archetype objects, status: "candidate"), each with its
supporting_question_ids resolvable to QuestionSignature objects, and each
carrying Stage 2's mining_confidence and any possible_duplicate_of flags.

GOAL
Produce a taxonomy that is: conceptually meaningful, non-redundant,
sufficiently granular, useful for generating new questions, and faithful
to historical evidence. Critically challenge the candidate catalogue --
do not default to KEEP.

DECISION VOCABULARY (every finding below must resolve to exactly one of these)
- KEEP: archetype is sound as-is.
- MERGE: two or more archetypes represent the same reasoning structure;
  differences are superficial and should become variations of the
  surviving archetype. Set merge_target_id on the archetype(s) being
  absorbed.
- SPLIT: one archetype bundles materially different reasoning; produce
  split_result_ids naming the new child archetypes it should become.
- REVISE: the archetype's grouping is correct, but its name, description,
  learning_objective, or variation set is unclear, mis-scoped, or poorly
  worded. Use this when the reasoning-structure judgment is right but the
  articulation is wrong.
- REVIEW: evidence is insufficient, contradictory, or ambiguous enough
  that a human should decide. Use this instead of guessing when
  mining_confidence is low AND you cannot resolve the ambiguity from the
  supporting questions alone.
- ADD: two or more questions across the catalogue (or explicitly flagged
  as "not belonging" by Stage 2) are not adequately represented by ANY
  existing archetype. Propose a new Archetype object for them.
- REMOVE: archetype has zero supporting historical questions, or its
  supporting questions turn out (on your review) to belong entirely to
  other archetypes with none left. Do not create or keep an archetype
  because it sounds pedagogically plausible without evidence.

RESPONSIBILITIES -> DECISION MAPPING
1. Detect duplicates -> MERGE. Same reasoning structure, differences are
   wording/numbers/names/context/format-only -> merge, preserve
   differences as variations.
2. Detect over-generalization -> SPLIT. Materially different reasoning
   strategy, learning objective, operations, reasoning direction, or
   cognitive process bundled into one archetype -> split.
3. Validate variations. A change from x=5 to x=7 is NOT a variation. A
   change from "equal roots" to "no real roots" MAY be, if it changes the
   reasoning branch taken. Check every variation on every archetype you
   review; if a variation is spurious, that's a REVISE (remove the
   spurious variation, keep the archetype).
4. Check taxonomy levels. Concept != Archetype != Variation must hold. If
   an "archetype" is actually only a variation of a broader one, that's a
   MERGE. If a "variation" actually requires different reasoning, that's
   a SPLIT.
5. Check historical grounding. Zero supporting questions -> REMOVE. Thin
   evidence (e.g. one question) is not automatically wrong, but flag low
   confidence and consider REVIEW if the single question is itself
   ambiguous.
6. Detect missing archetypes -> ADD. If two or more questions (anywhere in
   the corpus, including Stage 2's "does not belong" flags) share
   reasoning structure but have no home, propose a new archetype.
7. Detect inappropriate clustering -> SPLIT or REVIEW. Questions grouped
   by shared vocabulary but different reasoning: if you can already see
   the correct split, SPLIT; if it's unclear how they should be divided,
   REVIEW.
8. Check generator usefulness. Ask: "Does this archetype's
   invariant_reasoning_structure name a reusable operation over a
   parameter space, specific enough that a generator could vary the
   parameters without copying a historical question?" Judge this
   STRUCTURALLY -- by inspecting the description's specificity and
   generality -- do NOT draft a sample question to test it; you may not
   generate, rewrite, or predict examination questions at any point in
   this task. If the description is too vague ("tests understanding of
   X") or too narrow (locks in specific numbers, or names only the
   specific instances observed instead of the general family they belong
   to), that's REVISE.
9. Level-appropriateness differs materially. Two questions may share an
   identical abstract_structure string and still require a SPLIT if they
   belong to different education_context.education_stage /
   curriculum_source / subject_or_course scopes AND the expected method,
   rigor, or tool differs at each level -- e.g., "solve a linear equation"
   (grade 9, arithmetic manipulation) vs. "solve a system of linear
   equations" (undergraduate, matrix methods) are never the same archetype
   even though both reduce to "isolate the unknown." In practice this
   should rarely trigger as a live decision, because Stage 2 is already
   constrained to mine within one education_context scope -- use this
   criterion mainly to catch cases where a human-supplied taxonomy or an
   upstream scoping bug caused cross-level mixing to slip through.

MERGE CRITERIA (all should hold)
Same or closely related concept; essentially the same learning objective;
substantially the same reasoning sequence; differences are mainly
conditions or context. Preserve differences as variations of the merged
archetype.

SPLIT CRITERIA (any one is sufficient)
Learning objective differs materially; reasoning direction differs
materially; required method differs; student must perform a
fundamentally different cognitive operation; level-appropriateness differs
materially (see responsibility 9 above).

WORKED EXAMPLE (Math -- MERGE)
"Determine parameter from root condition" (variations: equal roots, real
distinct, not real) and a separately-mined "Find value of k for equal
roots" both trace to the same reasoning_pattern shape and
reasoning_direction. -> MERGE the latter into the former; fold "equal
roots" in as a variation if not already present.

WORKED EXAMPLE (Science -- SPLIT)
"Explain photosynthesis process" bundles: (a) sequence-recall of the
light/dark reactions (Remember/Understand, forward) and (b) predict the
effect of a changed variable like light intensity on the rate
(Apply/Analyze, forward, but requires causal-graph reasoning absent from
(a)). -> SPLIT into "Recall photosynthesis reaction sequence" and "Predict
effect of variable change on photosynthesis rate."

WORKED EXAMPLE (Social Science -- ADD)
Stage 2 flagged three map-based questions in different clusters as "does
not belong." All three share reasoning_pattern [locate feature on map ->
apply legend/scale -> answer spatial question] with no existing archetype.
-> ADD "Extract spatial information from a map using legend/scale."

WORKED EXAMPLE (Undergraduate -- REVISE)
"Derive asymptotic complexity via recurrence relation" has a
generator_usability_rationale that's too narrow -- it names only the two
algorithms observed (binary search, merge sort) instead of "any
divide-and-conquer or logarithmic-reduction algorithm." -> REVISE: broaden
the invariant_reasoning_structure description so a generator could vary
the specific algorithm, not just the two seen historically.

WORKED EXAMPLE (Undergraduate -- ADD)
Across a Data Structures course's archetype catalogue, three questions
about proving an algorithm's correctness via loop invariants don't fit
any existing archetype (all existing ones are complexity-analysis or
implementation questions). -> ADD "Prove algorithm correctness using a
loop invariant."

CROSS-REFERENCE POSSIBLE_DUPLICATE_OF FLAGS
For every archetype where Stage 2 set possible_duplicate_of, explicitly
check it against the named cluster's own archetype output before deciding
KEEP vs MERGE.

EVIDENCE AND RATIONALE
Every decision must include critic_rationale (plain-language justification)
and critic_evidence (the specific question_ids or archetype_ids that
justify it). A decision with no evidence is not acceptable -- use REVIEW
instead of asserting a decision you can't ground.

WHAT NOT TO DO
- Do not generate, draft, rewrite, or predict examination questions at
  any point, including while checking generator usefulness.
- Do not create an archetype (via ADD) because it sounds pedagogically
  plausible without at least two supporting questions.
- Do not default to KEEP when uncertain -- use REVIEW.
- Do not compare difficulty across education_context scopes as if it were
  absolute -- each QuestionSignature's difficulty_reference_frame already
  states what its rating is relative to; never imply a "Hard" at one level
  is comparable to a "Hard" at another.

SCHEMA
For every candidate you were given, return exactly one object -- never
omit an untouched candidate, even for KEEP. Every object must always
include:
{
  "archetype_id": "<the SAME id you were given -- required so the caller
    can match your decision back to the right candidate>",
  "critic_decision": "KEEP" | "MERGE" | "SPLIT" | "REVISE" | "REVIEW" | "ADD" | "REMOVE",
  "critic_rationale": "<plain-language justification, required for every decision>",
  "critic_evidence": ["<question_id or archetype_id that grounds this decision>"],
  "merge_target_id": "<archetype_id being merged into, set only when critic_decision is MERGE, else null>",
  "split_result_ids": ["<new child archetype_id>", "... -- set only when critic_decision is SPLIT, else empty"]
}
Do NOT re-transcribe any field beyond the six above that your decision
didn't actually change -- the caller already has each candidate's own
Stage 2 output on hand and fills in anything you omit from that. This
matters, not just as an efficiency nicety: retyping every field (name,
concept, learning_objective, invariant_reasoning_structure, variations,
stats, ...) for a whole batch, including every ordinary KEEP where
nothing changed, is the single most common way a batch response comes
back incomplete -- a large repetitive transcription task you give up on
partway through costs the exact archetypes you never got to a synthesized
REVIEW instead of your real judgment, which defeats the point of asking
you to review them at all.
- KEEP / MERGE / SPLIT / REVIEW / REMOVE: the six fields above are
  everything required. Do not include anything else.
- REVISE: also include whichever of name / concept / learning_objective /
  invariant_reasoning_structure / student_explanation / variations /
  supporting_question_ids / generator_usable / generator_usability_rationale
  you are actually revising (see Stage 2's own SCHEMA for each field's
  exact shape, including student_explanation's own description of what it
  is and is not) -- omit anything your revision left unchanged.
- ADD: return the FULL Archetype shape (Stage 2's own fields, see its own
  SCHEMA, plus the six fields above) with a freshly assigned archetype_id
  and critic_decision:"ADD" -- there is no existing candidate to fall
  back to for a brand-new archetype, so this is the one decision that
  genuinely needs everything. Do NOT include education_context -- it is
  stamped on by the caller after your response.

OUTPUT
Return ONLY valid JSON: an array with exactly one object per candidate you
were given, matching the SCHEMA above. No markdown, no explanatory prose.`;
}

// ---------------------------------------------------------------------------
// student_explanation backfill (added later, not part of the original
// design doc's Stage 0-4 pipeline -- see studentExplanationBackfill.ts's
// own comment for why this exists as a one-time backfill rather than
// folding into Stage 2's own prompt retroactively). Deliberately its own
// minimal prompt, not a cut-down buildMinerPrompt: the input here is only
// each archetype's own already-mined name/concept/learning_objective/
// invariant_reasoning_structure (nothing to re-derive from raw questions),
// and the output is intentionally tiny per item -- exactly the lesson
// this repo already paid for once with Stage 3's own prompt (see
// buildCriticPrompt's own comment): never ask a model to retype anything
// it doesn't have to, especially across a batch.
// ---------------------------------------------------------------------------

export function buildStudentExplanationBackfillPrompt(): string {
  return `ROLE
You are a textbook writer, explaining exam-syllabus concepts in plain
language for a student about to practice questions on them.

INPUT
An array of already-mined archetypes (each with archetype_id, name,
concept, learning_objective, invariant_reasoning_structure, and its
education_context) -- no raw questions, nothing left to re-derive; every
fact you need to write an accurate explanation is already in these
fields.

TASK
For EVERY archetype in the array, write student_explanation: 2-4
plain-language sentences explaining the underlying CONCEPT itself --
what the idea, mechanism, or method actually IS -- not a restatement of
invariant_reasoning_structure, which is a task instruction ("Describe
the sequence of hormonal and neuroendocrine signaling events that
regulate parturition"). student_explanation TEACHES the thing itself
(e.g. what oxytocin and the positive-feedback loop actually do during
parturition, in plain terms) so a student who doesn't already know this
concept comes away knowing it, before they attempt a question of this
type -- not just knowing what they're about to be asked to do.

RULES
- Never invent facts beyond what concept/learning_objective/
  invariant_reasoning_structure already establish for this archetype --
  if they don't give you enough to explain the underlying idea
  accurately, write the clearest correct explanation those fields
  support rather than fabricating specifics they don't contain.
- Match the register to education_context.education_stage (secondary vs
  senior_secondary vs undergraduate) -- explain at the level a student
  actually at that stage would find clear, not over-simplified for a
  senior-secondary/undergraduate concept or over-technical for a
  secondary one.
- Never reference "this archetype," "this pattern," "this question
  type," or any exam-taxonomy language -- write as if explaining the
  idea itself to a student, in the same style as a good textbook aside,
  with no awareness that a taxonomy or exam pattern is involved at all.
- Self-contained: a student should be able to read ONLY
  student_explanation, with no other context, and come away
  understanding the concept.

SCHEMA
Return exactly one object per archetype you were given -- never omit
one, even if you're uncertain; write the clearest explanation you can
from what's given rather than skipping it:
{
  "archetype_id": "<the SAME id you were given>",
  "student_explanation": "<2-4 plain-language sentences, see TASK and RULES above>"
}
Nothing else -- no other field from the archetype needs echoing back.

OUTPUT
Return ONLY valid JSON: an array with exactly one object per archetype you
were given, matching the SCHEMA above. No markdown, no explanatory prose.`;
}

// ---------------------------------------------------------------------------
// Cross-run duplicate detection (added later, deliberately separate from
// Stage 3 -- see crossRunMerge.ts's own comment for why this exists as its
// own one-off pass rather than folding into buildCriticPrompt: Stage 3's
// own MERGE responsibility only ever compares candidates within ONE
// mining run's own batch by construction (it has no visibility into any
// OTHER run's archetypes at all), so this catches a genuinely different
// class of duplicate Stage 3 was never positioned to see -- confirmed
// directly in production: the same reasoning pattern, mined independently
// across several separate runs, existing as several textually distinct
// (differently-worded) archetypes with no MERGE ever proposed between
// them, one real example reaching 10 separate copies of the same pattern.
// ---------------------------------------------------------------------------

export function buildCrossRunMergePrompt(): string {
  return `ROLE
You are auditing an already-mined archetype catalogue for CROSS-RUN
duplicates: the SAME underlying reasoning pattern, mined independently
under different wording, across separate mining runs. This is a
different failure mode from what a normal duplicate-detection pass
already caught -- each of these archetypes was already reviewed and
accepted on its own, within its own run, by a critic that had no
visibility into any OTHER run's own archetypes at all.

INPUT
An array of already-accepted archetypes, all narrowed in advance to ONE
curriculum chapter (so every archetype you're given is at least
topically related) -- each with a "ref" (its stable "run_id:archetype_id"
identifier), name, concept, learning_objective, and
invariant_reasoning_structure.

TASK
Group these into clusters where EVERY member represents the EXACT SAME
underlying reasoning pattern -- the same task, requiring the same
reasoning structure, merely worded differently. For example, "Determine
chronological order of human evolution" and "Identify chronological
order of human evolution" are the same pattern; "Determine parameter from
root condition" and "Solve a quadratic for its nature of roots" are
RELATED but NOT the same pattern unless they genuinely require identical
reasoning, not just overlapping vocabulary or topic.

BE CONSERVATIVE. A false merge is worse than a missed one: it would
silently combine two genuinely distinct reasoning patterns into a single
entry a student sees and practices, hiding the real distinction between
them. Only cluster archetypes you are confident are the identical
pattern. When in doubt, leave them as separate archetypes (i.e. omit
them from any cluster).

SCHEMA
Return one entry per genuine duplicate cluster found -- OMIT any
archetype that has no duplicate in this batch entirely; do not create a
cluster of one, and do not echo every input archetype back:
{
  "member_refs": ["<ref>", "<ref>", "..."],
  "rationale": "<plain-language justification for why these are the SAME pattern, not just related>"
}

OUTPUT
Return ONLY valid JSON: an array of cluster objects matching the SCHEMA
above (empty array if you find no genuine cross-run duplicates in this
batch -- the common case). No markdown, no explanatory prose.`;
}

// See curriculumReconciliation.ts's own comment for the full context: this
// realigns Stage 1's own already-mined curriculum.chapter/topic labels
// (assigned before this app started auto-generating a syllabus-derived
// taxonomy document, or for a scope that still doesn't have one) onto this
// app's own curated syllabus_topics wording, so every exact-string match
// this app does between the two (year-coverage, archetype-progress, the
// pattern picker's own topic lookup) actually succeeds instead of silently
// excluding the archetype.
export function buildCurriculumReconciliationPrompt(): string {
  return `ROLE
You are aligning already-classified exam-question CHAPTER labels against
this app's own curated syllabus catalogue, for one board/grade/subject
scope.

INPUT
Two lists, both scoped to the same one board/grade/subject:
- "unmatched": distinct chapter values already assigned to real mined
  questions that do NOT exactly match any real syllabus value
  (paraphrased, differently punctuated, misspelled, a stray
  misclassification, or genuinely wrong) -- each with "count", how many
  questions currently carry it.
- "syllabus": the complete, authoritative list of real chapter/topic
  values for this exact scope, taken directly from this app's own
  curriculum catalogue -- either one is an equally valid, equally
  "correct" target (this app treats them interchangeably for this
  purpose). This is the ONLY set of values a mapping's to_chapter may
  use -- copy the chosen one verbatim, character for character, do not
  paraphrase or alter punctuation.

TASK
Map an "unmatched" value onto a "syllabus" value whenever a real question
carrying that label genuinely belongs, as actual exam content, under that
one syllabus chapter -- this covers TWO distinct cases, both real and
both worth mapping:
1. The SAME chapter, just worded, punctuated, or spelled differently
   ("Human Health and Diseases" -> "Human Health and Disease").
2. A more specific SECTION or SUB-TOPIC that a student studies as PART OF
   one specific syllabus chapter, even though the label itself doesn't
   read as a paraphrase of the chapter name. For example, "Human Genome
   Project" is a named section INSIDE the "Molecular Basis of
   Inheritance" chapter, not a separate chapter of its own -- a real
   exam question labeled that way still belongs there. Likewise
   "Reproduction in Organisms" (general reproduction concepts) and
   "Reproductive Structure in Flowering Plants" both belong under "Sexual
   Reproduction in Flowering Plants" once you consider what that chapter
   actually covers, not just its four-word name. Use your own subject-
   matter knowledge of what each syllabus chapter actually contains to
   recognize case 2 -- don't require the unmatched label to visually
   resemble the syllabus name.

Do NOT force a mapping when an "unmatched" entry is genuinely NOT part of
any listed chapter's real content:
- A chapter genuinely since REMOVED from the current syllabus (real
  content, but not covered by anything in "syllabus" at all -- e.g. an
  older chapter no longer examined).
- Content that actually belongs to a DIFFERENT grade or DIFFERENT
  subject than this scope (a real chapter name, just not one that's
  actually taught in THIS board/grade/subject's own syllabus).
- Too vague, generic, or clearly non-subject text to confidently place
  at all ("General Instructions", "Writing Skills" -- likely exam
  boilerplate or cross-subject contamination, not real content in this
  subject).

BE CONSERVATIVE about these three exclusion cases specifically -- a wrong
mapping silently reassigns real, already-mined questions to the wrong
chapter, worse than leaving a genuinely unresolved value alone. But don't
let that conservatism make you UNDER-map case 2 above: a real question
whose label is simply more specific than the chapter's own short name
still deserves to be found and mapped, not left behind out of caution.

SCHEMA
Return one entry per confident mapping -- omit anything you're not
confident about:
{
  "from_chapter": "<verbatim, copied EXACTLY from the unmatched list>",
  "to_chapter": "<verbatim, copied EXACTLY from one syllabus entry>"
}

OUTPUT
Return ONLY valid JSON: an array of mapping objects matching the SCHEMA
above (empty array if nothing in "unmatched" confidently matches
anything in "syllabus"). No markdown, no explanatory prose.`;
}

// See offScopeContentScan.ts's own comment for the full context: a
// retroactive sweep for the SAME thing OFF_SCOPE_CONTENT_FLAG now catches
// at mining time going forward (see types.ts and buildAnalyzerPrompt's
// own OFF-SCOPE CONTENT section) -- content that reached the catalogue
// before that check existed. Confirmed live in production: a "Biology"
// archetype whose only supporting question was an English poem's own
// MCQ, and a Grade-12-tagged archetype whose only supporting question
// was actually Grade 11 syllabus content.
export function buildOffScopeContentScanPrompt(): string {
  return `ROLE
You are auditing real exam questions to confirm each one genuinely
belongs to the ONE board/grade/subject it's declared under.

INPUT
- The declared board, grade, and subject for this entire batch (every
  question below claims to be this).
- "syllabus": the REAL, complete, authoritative list of chapter/topic
  names that make up this exact subject's real curriculum for this exact
  grade, taken directly from this app's own curriculum catalogue. This
  list, not your own general knowledge of "what counts as [subject]," is
  the AUTHORITATIVE definition of the declared subject's scope --
  omitted only when this app has no such catalogue for this scope, in
  which case fall back to your own subject-matter knowledge instead.
- An array of questions, each with a "ref" (its stable
  "run_id:question_id" identifier) and "text" (the question itself,
  possibly truncated).

TASK
Flag a question ONLY when its actual content is CLEARLY:
- A different SUBJECT entirely (e.g. an English literature question, a
  writing/composition task, a different science) mixed into this
  subject's own paper, or
- A different GRADE/level's own syllabus content than the one declared.

Before flagging on either ground, check the question's content against
EVERY entry in "syllabus" first. If it plausibly belongs to ANY ONE
chapter/topic in that list -- even loosely, even if it's a specific
technical sub-topic that isn't spelled out verbatim in that chapter's own
short name -- it is NOT off-scope. Full stop. Do not flag it, no matter
how specialized, technical, or like-its-own-separate-discipline it
sounds. A subject's real syllabus is made of many specialized-sounding
chapters, not one homogeneous "general [subject]" -- CONFIRMED AS A REAL,
REPEATED MISTAKE this check has already made multiple times: real Grade
12 CBSE Biology content covering PCR/restriction enzymes/gene cloning
(the Biotechnology chapter), human evolution (the Evolution chapter),
invasive species and biodiversity loss (the Biodiversity and
Conservation chapter), and drug/tobacco abuse (part of the Human Health
and Disease chapter) were ALL wrongly flagged as "not really Biology" --
reasoning it belonged to "Biotechnology, not general Biology," or
"Anthropology, not core Biology," or "Ecology/Environmental Science, not
Grade 12 Biology," or "Health Education, not Biology." Every one of
those chapters IS the declared subject -- Biotechnology, Evolution,
Ecology, and Health topics are not separate disciplines here, they are
chapters OF Biology. This is the single most important rule in this
prompt: never invent a narrower definition of the subject than what
"syllabus" actually lists, and never treat a specialized or technical-
sounding chapter as if it must belong to some OTHER field.

Naming an external-sounding field ("Environmental Science," "Geography,"
"Anthropology," "Health Education," "Psychology," "Economics," etc.) is
NEVER by itself a valid reason to flag a question -- it's the exact wrong
shortcut this check keeps taking instead of doing the real comparison.
Real-world/interdisciplinary-SOUNDING themes are core content of specific
Biology chapters: deforestation, habitat loss, species extinction, and
human environmental impact belong to Ecosystem/Biodiversity and
Conservation/Organisms and Populations; disease, addiction, and public-
health topics belong to Human Health and Disease; population/inheritance
patterns belong to Evolution/Principles of Inheritance and Variation.
Before writing a "reason" that cites an external field name, you must
first identify the SPECIFIC syllabus entry whose real coverage is closest
to this question's actual theme, and explain concretely why that specific
entry does NOT cover it -- not just assert that the theme "sounds like"
another field.

Similarly, do NOT flag a question just because it covers a different
chapter/topic than most of the OTHER questions in this same batch. A
batch is an arbitrary slice of a scope's own questions, not one paper or
one chapter -- questions from several different chapters of the SAME
declared subject and grade, mixed together in one batch, is the normal,
expected case. Judge each question only against "syllabus" (or, absent
that, your own subject knowledge of the declared board/grade/subject) --
never against what the rest of the batch happens to be about.

Do NOT flag a question just because it's unusually difficult, unusually
easy, oddly worded, or an OCR-damaged fragment -- none of those is a
subject/grade mismatch.

BE CONSERVATIVE. This determines whether real, already-mined content gets
excluded from the catalogue and an archetype built on it gets removed --
a false positive here silently discards legitimate content, worse than
missing a genuine case (which stays exactly as visible as it already is,
available to be caught on a later pass). Only flag a question you are
confident is genuinely off-scope AFTER checking it against every
"syllabus" entry and finding no plausible match at all.

SCHEMA
Return one entry per confidently-flagged question -- omit every question
that's a legitimate (even if unusual or highly specific) example of the
declared board/grade/subject; the common case is an EMPTY array:
{
  "ref": "<verbatim, copied EXACTLY from the input>",
  "reason": "<name the CLOSEST syllabus entry to this question's actual theme and explain concretely why it doesn't cover this question, then state what subject/grade this actually is instead -- never just an external field name with no syllabus entry named and ruled out>"
}

OUTPUT
Return ONLY valid JSON: an array of objects matching the SCHEMA above
(empty array when nothing in this batch is genuinely off-scope -- the
common case). No markdown, no explanatory prose.`;
}
