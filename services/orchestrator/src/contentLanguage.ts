import type { Medium } from "./types.js";

// Unicode block ranges for the scripts this app's own three mediums are
// conventionally written in. Bengali and Devanagari (Hindi) are entirely
// disjoint from Latin script, so counting characters in each block against
// a sample's total letter count is a reliable, cheap way to tell which
// script a block of text is ACTUALLY written in -- unlike trusting a
// syllabus_topics/chapter_documents row's own `medium` column, which
// means "which student COHORT this content serves," not "what script this
// text is in" (see the web app's own studentScope.ts top comment). Those
// two readings can genuinely diverge: West Bengal Board's own English-
// Second-Language reader is tagged medium=Bengali (the cohort it serves),
// but its real chapter_documents text is English-language prose.
// Confirmed live: trusting `medium` as a script signal made server.ts's
// own /v1/topic-summary route return that content UNCHANGED for a
// Bengali-toggled request -- responseLanguage happened to equal the
// row's own `medium` tag, even though the actual characters on the page
// never were Bengali at all.
const BENGALI_RANGE = /[ঀ-৿]/g;
const DEVANAGARI_RANGE = /[ऀ-ॿ]/g;

// A generous, cheap-to-scan prefix -- script composition doesn't vary
// meaningfully across the length of this app's own admin-authored/
// ingested content (a chapter is either written in one script throughout,
// or overwhelmingly so), so there's no accuracy reason to scan an entire
// multi-thousand-character document, only a performance one to avoid.
const SAMPLE_LENGTH = 1000;

// Below this fraction of Bengali/Devanagari characters (of all LETTER
// characters in the sample), the text is treated as English -- a citation,
// a proper noun, or a handful of transliterated words shouldn't flip the
// whole document's detected script.
const SCRIPT_THRESHOLD = 0.3;

// Best-effort guess at which of this app's three mediums a block of text
// is ACTUALLY written in, purely from its own characters -- never from any
// metadata (a `medium` column, a request parameter) about it. Defaults to
// "English" whenever neither Bengali nor Devanagari clears the threshold
// (covers genuine English text, and any script this app doesn't otherwise
// support, equally safely -- an English default is never wrong in a way
// that skips a needed translation, only in a way that adds one that turns
// out to be a no-op reproduction of already-English text).
export function detectContentLanguage(text: string): Medium {
  const sample = text.slice(0, SAMPLE_LENGTH);
  const totalLetters = (sample.match(/\p{L}/gu) ?? []).length;
  if (totalLetters === 0) return "English";

  const bengaliCount = (sample.match(BENGALI_RANGE) ?? []).length;
  if (bengaliCount / totalLetters >= SCRIPT_THRESHOLD) return "Bengali";

  const devanagariCount = (sample.match(DEVANAGARI_RANGE) ?? []).length;
  if (devanagariCount / totalLetters >= SCRIPT_THRESHOLD) return "Hindi";

  return "English";
}
