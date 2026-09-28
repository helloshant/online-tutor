import { getSupabaseClient } from "./supabaseClient.js";
import { getJsonCompletion } from "./jsonCompletion.js";
import { buildTopicTranslationPrompt } from "./prompts.js";
import { getActiveLlmProvider, type LlmProvider } from "./llm.js";

// Stage 1 classifies curriculum.topic in whatever language it happens to
// default to for a given run (see prompts.ts's own LANGUAGE note, added
// after this was found) -- runs mined BEFORE that fix wrote curriculum.topic
// in English regardless of the question's own language or the curriculum
// source's own study medium, even when curriculum.chapter is (post
// Curriculum reconciliation, see curriculumReconciliation.ts) correctly in
// that medium's own script. Confirmed live: the student-facing sub-topic
// picker (archetypeExercises.ts's own subTopic, the mode of an archetype's
// supporting questions' curriculum.topic) showed English pills ("Waste
// Management", "Iron and Steel Industry") under a Bengali-script chapter
// for West Bengal Board Grade 10 Geography -- a jarring, inconsistent mix
// for a Bengali-medium student, and not something Curriculum reconciliation
// touches at all (that tool deliberately only ever rewrites chapter, see
// its own top comment on why chapter and topic are different granularities).
//
// Unlike chapter reconciliation, this has no fixed external "syllabus" list
// to match against -- curriculum.topic is a fine, often near-unique
// per-question label with no real syllabus_topics counterpart to copy
// verbatim from. So this is a straight LLM TRANSLATION pass, not a
// matching pass: for every row whose curriculum.chapter is already in a
// non-English script but whose curriculum.topic still isn't, translate
// that topic into the same script, using the chapter as context for which
// script and subject-area vocabulary to translate into.
const PAGE_SIZE = 1000;

type SignatureRow = {
  run_id: string;
  question_id: string;
  signature: { curriculum?: { chapter?: string; topic?: string } };
};

// Non-Latin scripts (Bengali, and any future medium this app supports)
// use code points outside the ASCII range; ordinary English prose
// (occasional em-dash/smart-quote aside) doesn't. A cheap, reliable-enough
// signal for "already written in a non-English script" without needing to
// hardcode which script in particular -- keeps this generic beyond Bengali.
const NON_ASCII_RE = /[^\x00-\x7F]/;

async function loadRows(params: { boardName: string; gradeName: string; subjectName: string }): Promise<SignatureRow[]> {
  const supabase = getSupabaseClient();
  const rows: SignatureRow[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("archetype_question_signatures")
      .select("run_id, question_id, signature")
      .eq("education_context->curriculum_source->>name", params.boardName)
      .eq("education_context->>grade_or_year", params.gradeName)
      .eq("education_context->>subject_or_course", params.subjectName)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      console.error("Topic translation: failed to load question signatures:", error);
      break;
    }
    const page = (data ?? []) as SignatureRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

type TranslatableTopic = { topic: string; chapterSample: string; count: number };

// Grouped by exact topic string (not by chapter) -- the same fine-grained
// topic label can appear under one chapter across many questions, and
// translating it once and applying it everywhere is both cheaper and more
// consistent than re-translating it per question. chapterSample is kept
// only as translation CONTEXT (which script/subject vocabulary to use),
// not as part of the grouping key.
function computeTranslatable(rows: SignatureRow[]): TranslatableTopic[] {
  const byTopic = new Map<string, TranslatableTopic>();
  for (const row of rows) {
    const chapter = row.signature?.curriculum?.chapter?.trim();
    const topic = row.signature?.curriculum?.topic?.trim();
    if (!chapter || !topic) continue;
    if (!NON_ASCII_RE.test(chapter) || NON_ASCII_RE.test(topic)) continue;
    const existing = byTopic.get(topic);
    if (existing) existing.count++;
    else byTopic.set(topic, { topic, chapterSample: chapter, count: 1 });
  }
  return Array.from(byTopic.values());
}

export type TopicTranslationPreview = {
  translatableTopics: number;
  affectedQuestions: number;
};

// Counts only -- no LLM call, no writes.
export async function previewTopicTranslation(params: {
  boardName: string;
  gradeName: string;
  subjectName: string;
}): Promise<TopicTranslationPreview> {
  const translatable = computeTranslatable(await loadRows(params));
  return {
    translatableTopics: translatable.length,
    affectedQuestions: translatable.reduce((sum, t) => sum + t.count, 0),
  };
}

type Translation = { fromTopic: string; toTopic: string };

const MAX_TOKENS = 8000;

// Same reasoning as curriculumReconciliation.ts's own UNMATCHED_BATCH_SIZE
// (added after a real production incident where one oversized call hit
// getJsonCompletion's truncation guard and aborted an entire pass with
// zero results) -- bounding each call's own output keeps this safe
// regardless of how large a scope's translatable-topic set grows to.
const BATCH_SIZE = 40;

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

async function requestTranslations(batch: TranslatableTopic[], provider: LlmProvider): Promise<Translation[]> {
  const { data } = await getJsonCompletion({
    systemPrompt: buildTopicTranslationPrompt(),
    message: JSON.stringify({
      topics: batch.map((t) => ({ topic: t.topic, chapter: t.chapterSample, count: t.count })),
    }),
    maxTokens: MAX_TOKENS,
    provider,
  });

  if (!Array.isArray(data)) {
    console.warn("Topic translation: response was not a JSON array.");
    return [];
  }

  const translations: Translation[] = [];
  let rejectedCount = 0;
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as Record<string, unknown>;
    if (typeof m.topic === "string" && typeof m.translated_topic === "string") {
      // A response that's still plain ASCII isn't a translation -- the
      // model just echoed the original back (or declined silently
      // without saying so). Never write that on top of a real value.
      if (!NON_ASCII_RE.test(m.translated_topic)) {
        rejectedCount++;
        continue;
      }
      translations.push({ fromTopic: m.topic, toTopic: m.translated_topic });
    }
  }
  console.log(
    `Topic translation: model translated ${translations.length}/${batch.length} topic(s), ${rejectedCount} rejected (not an actual translation).`
  );
  return translations;
}

// Rewrites curriculum.topic (ONLY -- curriculum.chapter is left exactly as
// it already was, whether reconciled or not) on every
// archetype_question_signatures row in this scope carrying one FROM value.
async function applyTranslation(
  supabase: ReturnType<typeof getSupabaseClient>,
  params: { boardName: string; gradeName: string; subjectName: string },
  translation: Translation
): Promise<number> {
  const { data, error } = await supabase
    .from("archetype_question_signatures")
    .select("run_id, question_id, signature")
    .eq("education_context->curriculum_source->>name", params.boardName)
    .eq("education_context->>grade_or_year", params.gradeName)
    .eq("education_context->>subject_or_course", params.subjectName)
    .eq("signature->curriculum->>topic", translation.fromTopic);
  if (error) {
    console.error(`Topic translation: failed to load rows for "${translation.fromTopic}":`, error);
    return 0;
  }

  let updated = 0;
  for (const row of (data ?? []) as SignatureRow[]) {
    const nextSignature = { ...row.signature, curriculum: { ...row.signature.curriculum, topic: translation.toTopic } };
    const { error: updateError } = await supabase
      .from("archetype_question_signatures")
      .update({ signature: nextSignature })
      .eq("run_id", row.run_id)
      .eq("question_id", row.question_id);
    if (updateError) {
      console.error(`Topic translation: failed to update ${row.run_id}:${row.question_id}:`, updateError);
      continue;
    }
    updated++;
  }
  return updated;
}

export type TopicTranslationResult = {
  translated: number;
  questionsUpdated: number;
  untranslatedRemaining: number;
};

let translationInProgress = false;

export function isTopicTranslationInProgress(): boolean {
  return translationInProgress;
}

// Same repeat-until-converged shape as curriculumReconciliation.ts's own
// MAX_ITERATIONS -- a model doesn't reliably translate every genuine case
// in one pass over a large batch, and re-running the same prompt gives a
// fresh sample another chance at exactly the ones missed the first time.
const MAX_ITERATIONS = 5;

async function runTopicTranslationOnePass(params: {
  boardName: string;
  gradeName: string;
  subjectName: string;
}): Promise<TopicTranslationResult> {
  const supabase = getSupabaseClient();
  const translatable = computeTranslatable(await loadRows(params));

  if (translatable.length === 0) {
    return { translated: 0, questionsUpdated: 0, untranslatedRemaining: 0 };
  }

  const provider = getActiveLlmProvider();
  const translations: Translation[] = [];
  for (const batch of chunk(translatable, BATCH_SIZE)) {
    try {
      translations.push(...(await requestTranslations(batch, provider)));
    } catch (err) {
      // One batch failing shouldn't take the rest of this pass's batches
      // down with it -- same reasoning curriculumReconciliation.ts's own
      // per-batch try/catch already applies.
      console.error(`Topic translation: batch of ${batch.length} topic(s) failed:`, err);
    }
  }

  let questionsUpdated = 0;
  for (const translation of translations) {
    questionsUpdated += await applyTranslation(supabase, params, translation);
  }

  return { translated: translations.length, questionsUpdated, untranslatedRemaining: translatable.length - translations.length };
}

export async function runTopicTranslation(params: {
  boardName: string;
  gradeName: string;
  subjectName: string;
}): Promise<TopicTranslationResult> {
  if (translationInProgress) {
    throw new Error("A topic translation pass is already in progress -- wait for it to finish before starting another.");
  }
  translationInProgress = true;
  try {
    const total: TopicTranslationResult = { translated: 0, questionsUpdated: 0, untranslatedRemaining: 0 };
    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      const pass = await runTopicTranslationOnePass(params);
      total.translated += pass.translated;
      total.questionsUpdated += pass.questionsUpdated;
      total.untranslatedRemaining = pass.untranslatedRemaining;

      console.log(
        `Topic translation: iteration ${iteration}/${MAX_ITERATIONS} for ${params.subjectName} (${params.boardName}, ` +
          `grade ${params.gradeName}) -- ${pass.translated} topic(s) translated, ${pass.questionsUpdated} question(s) updated, ` +
          `${pass.untranslatedRemaining} topic(s) still untranslated.`
      );

      if (pass.translated === 0) break;
    }

    console.log(
      `Topic translation: done -- ${total.translated} total topic(s) translated, ${total.questionsUpdated} total question(s) ` +
        `updated, ${total.untranslatedRemaining} topic(s) left untranslated.`
    );

    return total;
  } finally {
    translationInProgress = false;
  }
}
