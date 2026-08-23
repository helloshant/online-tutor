# Writing chapter notes: a copyright-safe authoring guide

This is for anyone writing content in **Admin → Chapter notes** (`chapter_documents`) —
the material the tutor retrieves and grounds its answers in. It exists because the
prescribed textbooks this app's syllabus is based on are copyrighted, and it's easy to
accidentally cross the line from "explaining a topic" to "reproducing a textbook" without
meaning to. Read this before authoring content at scale, not just the first time.

## The one rule everything else follows from

**Copyright protects the specific words an author chose to use (expression). It does not
protect the underlying facts, ideas, formulas, or procedures those words describe.**

The quadratic formula, the steps of photosynthesis, the date of an election, the plot of a
story — none of that is ownable by anyone. What *is* ownable is a specific textbook's
particular sentences, paragraph structure, worked examples, and illustrations describing
those things. So the question to ask about every paragraph you write is not "am I allowed
to explain this topic" (yes, always) but **"did I write this in my own words, or did I
lightly reword something I read"** (only the first one is safe).

A useful test: close the book, wait a few minutes, then write the explanation from memory
of the *concept*, not from memory of the *sentence*. If you can't do that, you're not far
enough from the source yet.

## Two very different risk levels, by subject

**Low risk — Math, Science, Geography, History, Civics and similar.** The content is
facts and procedures. Write clear, original explanations at the topic's own level — this
is the normal, expected case, and it's also your best content: original notes aligned to
this app's own syllabus topics are something no competitor can just copy from a PDF.

**High risk — English/Bengali/Hindi prose and poetry.** The poem or story *is* the
copyrighted expression. A close plot paraphrase can still infringe even without quoting a
single sentence verbatim. For these:

- **Never paste or closely paraphrase the primary text** (the poem itself, the story's
  prose) unless you've confirmed it's public domain (see below).
- Do write original commentary *about* the work: theme analysis, character notes,
  vocabulary, the kind of comprehension questions likely to be asked — your own
  observations about the text, not a retelling of the text.
- If a student needs the exact original lines, the tutor is already instructed to say so
  and point them to their physical textbook rather than reproduce it (see
  `buildTutorSystemPrompt`'s rule 6 and its few-shot examples in
  `services/orchestrator/src/prompts.ts`) — chapter notes should support that behavior,
  not undermine it by having the primary text sitting in the database in the first place.

**Public domain check, in India:** generally, an author's death + 60 years. A lot of
older poems/short stories in school anthologies genuinely qualify — verify per work, don't
assume from "it feels old."

## The actual workflow

1. **Read the prescribed textbook for understanding**, the same way you'd read anything to
   learn it. Reading something you have legitimate access to isn't infringement — copying
   or closely paraphrasing its expression is.
2. **Close it. Write the note from your own understanding**, at the exact
   `syllabus_topics` granularity this app already uses (one chapter/topic — check what's
   listed in Admin → Catalog for this board/grade/subject/medium before you start, so your
   note lines up with what a student will actually click on).
3. **Optionally cross-check 1–2 open sources for accuracy** (see the list below) — this is
   fine and encouraged for factual correctness, but the note you save should still be your
   own writing, not theirs.
4. **Fill in the Source field** on save if step 3 applied (see below) — leave it as
   "Original" (the default) when it didn't.
5. Someone else on the team should spot-check new notes periodically, the same way any
   other content goes through review on this platform.

## Recording provenance

Every chapter document has a **Source** field (collapsed by default under "Source
(copyright provenance)" on the add/edit forms and the bulk JSON import):

| Value | When to use it |
|---|---|
| **Original** (default) | Your own writing, informed by your general knowledge of the topic. This should be the vast majority of documents. |
| **Public domain** | The content includes a verified public-domain work (an old poem/story). Note *why* it's public domain (author, death year) in the note field. |
| **CC-licensed** | You drew on a Creative Commons source (Wikipedia, OpenStax, ...) — paraphrased/restructured, not reproduced. Note the specific license (CC-BY vs. CC-BY-SA matter) and link the source. |
| **NCERT/DIKSHA** | You drew on NCERT or DIKSHA/NROER material. Link the specific page/resource. |
| **Other** | Anything else — explain in the note. |

This isn't a substitute for writing originally — a "CC-licensed" tag on a paragraph that's
still just a lightly-reworded copy doesn't make it safe. It exists so the team can audit
*how* any given document came to be, later, without relying on memory.

## Genuinely open sources worth knowing about

Useful as background reading or a first-draft accelerant — **not** as something to paste
in. Always rewrite, always record the source.

- **NCERT** (ncert.nic.in) — textbooks are freely downloadable, and NCERT doesn't enforce
  copyright the way commercial publishers do for educational reuse. Strong foundation for
  CBSE-aligned Math/Science; most state syllabi (including WBBSE) overlap with NCERT
  content at the concept level even when the prescribed book is different.
- **DIKSHA** and **NROER** — India's national open-content platforms, explicitly
  CC-licensed and mapped to NCERT and several state curricula. The one actually designed
  for this kind of reuse.
- **OpenStax** (openstax.org) — CC-BY, high quality, but US-curriculum-shaped. Good for
  cross-checking STEM accuracy, not a direct source for Indian-board topic notes.
- **Wikipedia / Wikibooks** — CC-BY-SA. Fine as background reading; be aware share-alike
  terms carry real obligations for anything that counts as a derivative work, which is one
  more reason to rewrite thoroughly rather than adapt lightly.

**Avoid:** any commercial publisher's site, Khan Academy (licensing is inconsistent
site-wide), and any "notes" or "guide" site that's itself just reformatted textbook
content — copying from a copy doesn't make it safer.

## Quick checklist before you save

- [ ] Did I write this from my own understanding, not by rewording what I read?
- [ ] If this is a literature chapter — is the primary text (poem/story) excluded, or
      confirmed public domain?
- [ ] If I used an open source for reference — is the Source field filled in?
- [ ] Does this match an actual topic already in the Catalog for this board/grade/subject/
      medium (not a near-duplicate chapter name)?

If in doubt on anything legal beyond this guide, ask — don't guess and publish.
