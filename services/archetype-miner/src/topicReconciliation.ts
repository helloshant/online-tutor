// The human-in-the-loop counterpart to curriculumReconciliation.ts, one
// level deeper. That file fixes curriculum.chapter against the real
// syllabus list, but deliberately never touches curriculum.topic -- for
// most subjects topic is a genuinely finer, per-question concept with no
// fixed vocabulary to check it against (see that file's own top comment).
//
// Some subjects are different: syllabus_topics itself groups several real
// topics under one shared "book section" chapter value (e.g. WB Bengali
// "ব্যাকরণ"/Grammar covers a dozen real grammar topics, a story anthology
// covers dozens of real story titles) -- confirmed live, this is a real,
// legitimate convention this app's syllabus catalogue already uses, not a
// data error. For a mined question under one of these shared chapters,
// curriculum.topic SHOULD identify which one of that section's real
// topics it belongs to -- and when it does, the app's own sub-topic
// picker (services/orchestrator/src/archetypeExercises.ts) needs
// curriculum.chapter reclassified down to that specific real topic before
// it can ever show anything for a student who picked that topic directly.
// A generic descriptor ("line analysis", "যৌক্তিক প্রকাশ") doesn't say
// WHICH real topic on its own -- confirmed live for WB Bengali "Sahitya
// Sanchayan" (a story anthology) and WB Mathematics "Ganit Prakash": every
// mined topic value under both turned out to be exactly this kind of
// generic, unplaceable-without-the-real-question-text label, something no
// automated exact-match or chapter-level reconciliation pass could ever
// resolve on its own.
//
// This is that resolution path: scoped to shared-chapter groups only (a
// subject with no shared chapters has no fixed within-chapter vocabulary
// to check a mined topic against in the first place, so there's nothing
// for this tool to usefully do there), surfaced with real sample question
// text exactly like curriculumReconciliation.ts's own cross-scope review
// UI, so a human who can actually read the question can identify which
// real topic it belongs to and attach it.
import { getSupabaseClient } from "./supabaseClient.js";
import { TOPIC_UNMATCHED_IGNORED_FLAG, type EducationContext } from "./types.js";

const PAGE_SIZE = 1000;

function normalize(s: string): string {
  return s.trim().toLowerCase().normalize("NFC");
}

type Scope = { boardName: string; gradeName: string; subjectName: string };

function scopeKey(scope: Scope): string {
  return JSON.stringify([scope.boardName, scope.gradeName, scope.subjectName]);
}

function refKey(runId: string, questionId: string): string {
  return `${runId}:${questionId}`;
}

// This scope's own chapter -> real topic list, but ONLY for chapters
// genuinely shared by 2+ real syllabus_topics rows -- a chapter with
// exactly one real topic under it isn't a "section" a mined topic needs
// placing within, it's just that one topic, already unambiguous.
async function loadSharedChapterTopics(scope: Scope): Promise<Map<string, string[]>> {
  const supabase = getSupabaseClient();
  const [{ data: board }, { data: grades }, { data: subject }] = await Promise.all([
    supabase.from("boards").select("id").eq("name", scope.boardName).maybeSingle(),
    supabase.from("grades").select("id, name"),
    supabase.from("subjects").select("id").eq("name", scope.subjectName).maybeSingle(),
  ]);
  if (!board || !subject) return new Map();
  const grade = (grades ?? []).find((g: { id: string; name: string }) => g.name.replace(/^grade\s+/i, "").trim() === scope.gradeName);
  if (!grade) return new Map();

  const { data, error } = await supabase
    .from("syllabus_topics")
    .select("chapter, topic")
    .eq("board_id", board.id as string)
    .eq("grade_id", grade.id as string)
    .eq("subject_id", subject.id as string);
  if (error) {
    console.error("Topic reconciliation: failed to load syllabus_topics:", error);
    return new Map();
  }

  const byChapter = new Map<string, { display: string; topics: Map<string, string> }>();
  for (const row of (data ?? []) as { chapter: string; topic: string }[]) {
    const key = normalize(row.chapter);
    let bucket = byChapter.get(key);
    if (!bucket) {
      bucket = { display: row.chapter, topics: new Map() };
      byChapter.set(key, bucket);
    }
    bucket.topics.set(normalize(row.topic), row.topic);
  }

  const shared = new Map<string, string[]>();
  for (const bucket of byChapter.values()) {
    if (bucket.topics.size < 2) continue;
    shared.set(normalize(bucket.display), Array.from(bucket.topics.values()));
  }
  return shared;
}

type GlobalSignatureRow = {
  run_id: string;
  question_id: string;
  education_context: EducationContext;
  signature: { flags?: string[]; curriculum?: { chapter?: string; topic?: string; concept?: string } };
};

async function loadAllMinedRowsGlobal(): Promise<GlobalSignatureRow[]> {
  const supabase = getSupabaseClient();
  const rows: GlobalSignatureRow[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("archetype_question_signatures")
      .select("run_id, question_id, education_context, signature")
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      console.error("Topic reconciliation: failed to load question signatures (all scopes):", error);
      break;
    }
    const page = (data ?? []) as GlobalSignatureRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

// Kept short for the same reason curriculumReconciliation.ts's own
// SAMPLE_TEXT_TRUNCATE_LENGTH is -- an admin judging "which real topic is
// this actually about" needs the gist, not the full question.
const SAMPLE_TEXT_TRUNCATE_LENGTH = 300;

async function loadAllQuestionTextGlobal(): Promise<Map<string, string>> {
  const supabase = getSupabaseClient();
  const textByRef = new Map<string, string>();
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("archetype_segmented_questions")
      .select("run_id, question_id, question")
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      console.error("Topic reconciliation: failed to load segmented questions (all scopes):", error);
      break;
    }
    const page = (data ?? []) as { run_id: string; question_id: string; question: { raw_text?: string; cleaned_text?: string } }[];
    for (const row of page) {
      const text = (row.question?.cleaned_text || row.question?.raw_text || "").trim();
      if (text) textByRef.set(refKey(row.run_id, row.question_id), text.slice(0, SAMPLE_TEXT_TRUNCATE_LENGTH));
    }
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return textByRef;
}

const MAX_SAMPLE_QUESTIONS = 3;

export type UnmatchedTopicEntry = {
  boardName: string;
  gradeName: string;
  subjectName: string;
  chapter: string;
  topic: string;
  questionCount: number;
  // concept is included alongside the question text itself -- confirmed
  // directly, more than once, that it independently corroborates a human
  // reviewer's own read of the question (e.g. a "তৎপুরুষ সমাস" topic
  // value's own concept field: "Classification of Tatpurusha Compounds"),
  // worth surfacing rather than making an admin re-derive it from the raw
  // text alone.
  sampleQuestions: { ref: string; text: string; concept: string }[];
  // This chapter's own real topic list -- included per-entry (rather than
  // making the UI fetch it separately) so the "attach to..." dropdown can
  // be populated straight from the initial page load, same as
  // UnmatchedChapterEntry.acceptableValues.
  acceptableTopics: string[];
};

// The whole-catalogue scan behind the admin review page: every mined
// (chapter, topic) pair where chapter is a known shared-chapter "section"
// for its scope and topic doesn't exactly match any of that section's own
// real topics. Long-running (a full-table read, plus one syllabus lookup
// per distinct scope) -- same accepted trade-off as
// computeUnmatchedAcrossAllScopes, an admin-triggered review page, not
// something rendered on student-facing traffic.
export async function computeUnmatchedTopicsAcrossAllScopes(): Promise<UnmatchedTopicEntry[]> {
  const [signatureRows, textByRef] = await Promise.all([loadAllMinedRowsGlobal(), loadAllQuestionTextGlobal()]);

  type Bucket = { scope: Scope; chapter: string; topic: string; count: number; refs: string[]; concepts: string[] };
  const buckets = new Map<string, Bucket>();
  const scopesSeen = new Map<string, Scope>();

  for (const row of signatureRows) {
    if ((row.signature?.flags ?? []).includes(TOPIC_UNMATCHED_IGNORED_FLAG)) continue;
    const chapter = row.signature?.curriculum?.chapter?.trim();
    const topic = row.signature?.curriculum?.topic?.trim();
    // No topic at all means nothing left to place -- either a chapter/
    // topic-shifted row already fixed (topic deliberately cleared to
    // null, see 0064_fix_shifted_curriculum_chapters.sql's own reasoning)
    // or a question that genuinely never had a finer concept mined.
    if (!chapter || !topic) continue;
    const boardName = row.education_context?.curriculum_source?.name;
    const gradeName = row.education_context?.grade_or_year;
    const subjectName = row.education_context?.subject_or_course;
    if (!boardName || !gradeName || !subjectName) continue;
    const scope: Scope = { boardName, gradeName, subjectName };
    const sKey = scopeKey(scope);
    scopesSeen.set(sKey, scope);

    const bucketKey = `${sKey}::${normalize(chapter)}::${normalize(topic)}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { scope, chapter, topic, count: 0, refs: [], concepts: [] };
      buckets.set(bucketKey, bucket);
    }
    bucket.count++;
    if (bucket.refs.length < MAX_SAMPLE_QUESTIONS) {
      bucket.refs.push(refKey(row.run_id, row.question_id));
      bucket.concepts.push(row.signature?.curriculum?.concept ?? "");
    }
  }

  // One syllabus lookup per distinct scope, not per bucket.
  const scopeList = Array.from(scopesSeen.values());
  const sharedByScope = new Map<string, Map<string, string[]>>();
  await Promise.all(
    scopeList.map(async (scope) => {
      sharedByScope.set(scopeKey(scope), await loadSharedChapterTopics(scope));
    })
  );

  const entries: UnmatchedTopicEntry[] = [];
  for (const bucket of buckets.values()) {
    const shared = sharedByScope.get(scopeKey(bucket.scope));
    const acceptableTopics = shared?.get(normalize(bucket.chapter));
    // Not a shared-chapter scope at all -- this topic value is ordinary
    // free-form fine-grained data with no fixed vocabulary to check it
    // against, nothing for this tool to do here (see this file's own top
    // comment on why that's correct, not a gap).
    if (!acceptableTopics) continue;
    const acceptableKeys = new Set(acceptableTopics.map(normalize));
    if (acceptableKeys.has(normalize(bucket.topic))) continue; // exact match -- already fine, or fixable mechanically, not ambiguous

    entries.push({
      ...bucket.scope,
      chapter: bucket.chapter,
      topic: bucket.topic,
      questionCount: bucket.count,
      sampleQuestions: bucket.refs.map((ref, i) => ({ ref, text: textByRef.get(ref) ?? "", concept: bucket.concepts[i] ?? "" })).filter((s) => s.text),
      acceptableTopics,
    });
  }

  entries.sort((a, b) => {
    const scopeCompare =
      a.boardName.localeCompare(b.boardName) || a.gradeName.localeCompare(b.gradeName) || a.subjectName.localeCompare(b.subjectName);
    if (scopeCompare !== 0) return scopeCompare;
    if (a.chapter !== b.chapter) return a.chapter.localeCompare(b.chapter);
    return b.questionCount - a.questionCount;
  });
  return entries;
}

type SignatureRow = { run_id: string; question_id: string; signature: GlobalSignatureRow["signature"] };

// The human-chosen counterpart to curriculumReconciliation.ts's own
// attachChapterMapping -- same trust rule (the target MUST be a real,
// verbatim topic under THIS chapter) regardless of who picked it. Rewrites
// curriculum.chapter (not topic -- the mined topic value stays exactly as
// it was, now correctly understood as a genuine within-topic concept
// rather than an ambiguous label) on every row in this scope carrying
// this exact (chapter, topic) pair.
export async function attachTopicMapping(
  params: Scope & { chapter: string; fromTopic: string; toTopic: string }
): Promise<{ questionsUpdated: number }> {
  const shared = await loadSharedChapterTopics(params);
  const acceptableTopics = shared.get(normalize(params.chapter));
  if (!acceptableTopics || !acceptableTopics.some((t) => normalize(t) === normalize(params.toTopic))) {
    throw new Error(`"${params.toTopic}" is not a real syllabus topic under "${params.chapter}" for this board/grade/subject.`);
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("archetype_question_signatures")
    .select("run_id, question_id, signature")
    .eq("education_context->curriculum_source->>name", params.boardName)
    .eq("education_context->>grade_or_year", params.gradeName)
    .eq("education_context->>subject_or_course", params.subjectName)
    .eq("signature->curriculum->>chapter", params.chapter)
    .eq("signature->curriculum->>topic", params.fromTopic);
  if (error) {
    console.error(`Topic reconciliation: failed to load rows for "${params.chapter}" / "${params.fromTopic}":`, error);
    return { questionsUpdated: 0 };
  }

  let updated = 0;
  for (const row of (data ?? []) as SignatureRow[]) {
    const nextSignature = { ...row.signature, curriculum: { ...row.signature.curriculum, chapter: params.toTopic } };
    const { error: updateError } = await supabase
      .from("archetype_question_signatures")
      .update({ signature: nextSignature })
      .eq("run_id", row.run_id)
      .eq("question_id", row.question_id);
    if (updateError) {
      console.error(`Topic reconciliation: failed to update ${row.run_id}:${row.question_id}:`, updateError);
      continue;
    }
    updated++;
  }
  return { questionsUpdated: updated };
}

// Marks every signature in this scope carrying this exact (chapter, topic)
// pair with TOPIC_UNMATCHED_IGNORED_FLAG -- see that flag's own comment.
export async function ignoreUnmatchedTopic(params: Scope & { chapter: string; topic: string }): Promise<{ questionsMarked: number }> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("archetype_question_signatures")
    .select("run_id, question_id, signature")
    .eq("education_context->curriculum_source->>name", params.boardName)
    .eq("education_context->>grade_or_year", params.gradeName)
    .eq("education_context->>subject_or_course", params.subjectName)
    .eq("signature->curriculum->>chapter", params.chapter)
    .eq("signature->curriculum->>topic", params.topic);
  if (error) {
    console.error(`Topic reconciliation: failed to load rows for "${params.chapter}" / "${params.topic}" to ignore:`, error);
    return { questionsMarked: 0 };
  }

  let marked = 0;
  for (const row of (data ?? []) as SignatureRow[]) {
    const nextFlags = Array.from(new Set([...(row.signature.flags ?? []), TOPIC_UNMATCHED_IGNORED_FLAG]));
    const { error: updateError } = await supabase
      .from("archetype_question_signatures")
      .update({ signature: { ...row.signature, flags: nextFlags } })
      .eq("run_id", row.run_id)
      .eq("question_id", row.question_id);
    if (updateError) {
      console.error(`Topic reconciliation: failed to mark ${row.run_id}:${row.question_id} ignored:`, updateError);
      continue;
    }
    marked++;
  }
  return { questionsMarked: marked };
}
