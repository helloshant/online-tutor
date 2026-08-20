# TutorOps — Online Tutor SaaS

A chatops-style tutoring platform. Students subscribe to a board, grade, medium, and a set of
subjects; pay via CCAvenue (optionally redeeming a one-time discount code first — anywhere from a
percentage off to 100%, which skips payment entirely); then chat with an LLM tutor that stays
confined to the subscribed subject and that grade/board's syllabus, always answering in the chosen
language. Admins get a panel to see every user's selections, manage the underlying
board/grade/subject/syllabus catalog, and generate discount codes.

Built with Next.js (App Router), Supabase (Postgres + Auth + Row Level Security), CCAvenue, and a
separate LLM orchestration service (Anthropic Claude by default, or Azure OpenAI) with a
cache/knowledge-base pipeline in front of the LLM.

## Architecture

Five containers:

```
                       HTTP (internal only)     ┌──────────────────┐
                    ┌────────────────────────►  │ orchestrator      │
  ┌──────────────┐  │   x-internal-api-key      │ (4000, Express)   │
  │   web (3000) │──┤◄────────────────────────  └───┬────┬─────┬────┘
  │   Next.js    │  │         { reply }              │    │     │
  │   App Router │  │                                ▼    ▼     ▼
  │              │  │   HTTP (internal only)   Redis  Claude/  observability
  │              │  └────────────────────────► (cache) Azure   (4100, Express)
  └───┬──────────┘      x-internal-api-key              OpenAI      │
      │                 ◄────────────────────                      ▼
      │             { encRequest / redirectTo }         writes chat_events
      ▼
  Supabase (hosted) ◄───────────────┐
      ▲                             │
      │                       ┌─────┴────┐
      └───────────────────────┤ payment  │
                               │ (4200,   │
                               │ Express) │
                               └────┬─────┘
                                    │
                                    ▼
                                CCAvenue (external gateway -- redirects the
                                customer's browser back to web's public
                                /api/ccavenue/callback, never talks to
                                payment directly)
```

- **`web`** (repo root) owns everything about *who can ask what*: auth, onboarding,
  subscription/entitlement checks, the admin panel, and persisting chat history. It never talks to
  an LLM SDK directly, and never talks to CCAvenue or writes `coupon_codes` directly either — both
  the answer pipeline and the payment/coupon flow are delegated to their own services over HTTP.
- **`services/orchestrator`** owns everything about *how a question becomes an answer*. For every
  student question it runs a 4-stage pipeline before ever spending an LLM call:
  1. **Syllabus scope gate** — a keyword-overlap check against the subscribed board/grade/subject's
     syllabus (skipped for short/conversational messages and mid-conversation follow-ups, since
     those legitimately share no keywords with the syllabus on their own). Out-of-scope questions
     get the fixed reply "Please restrict your questions to your syllabus" without calling anything
     else. Tokenization is Unicode-aware (`\p{L}`/`\p{N}`/`\p{M}` property escapes, not `a-z0-9`) so
     this works for Bengali/Hindi syllabi and questions, not just English — a naive ASCII split
     would silently tokenize non-Latin scripts to nothing (and Bengali/Devanagari conjuncts need
     `\p{M}` specifically, since the combining vowel signs/virama that build a word are category
     Mark, not Letter — omitting it fractures every multi-syllable word at each vowel sign).
  2. **Redis cache (L1)** — exact/near-exact match on the normalized question, scoped by
     board+grade+subject+medium. A hit refreshes its own TTL (`GETEX`, not `GET`) — a sliding
     expiration, so a genuinely popular question stays cached as long as it keeps getting asked
     instead of expiring on a fixed clock from whenever it was first written. When an admin rejects
     or deletes the matching answer-bank entry at `/admin/answer-bank`, the web app calls
     `POST /v1/cache/invalidate` on the orchestrator to evict that Redis key immediately, so a
     demoted answer can't keep being served from cache until its TTL happens to run out.
  3. **Postgres full-text answer bank (L2)** — `answered_questions` table
     (`supabase/migrations/0005_answer_bank.sql`), searched with Postgres full-text search
     (`ts_rank`, BM25-style lexical ranking) rather than vector/semantic search: a
     topically-similar-but-substantively-different question (e.g. "derivative of x²" vs. "integral
     of x²") must never confidently return the wrong cached answer, which is a real risk with
     embedding similarity but not with keyword matching.
  4. **LLM (L3)** — only reached on a miss at both prior stages. The reply is then run through a
     cheap, deterministic **validation gate** (`answerValidation.ts` — no extra LLM call) before
     being written back:
     - Empty replies, an echoed syllabus-rejection, or something that reads like a clarifying
       question asked back at the student aren't stored at all.
     - A short or hedging answer ("I'm not sure...") is stored as **pending review** — kept, but
       not yet servable to other students until an admin confirms it.
     - Everything else is **auto-approved** and immediately written through to both Redis and the
       answer bank, so the next ask of the same question is a cache hit instead of another LLM
       call.

     Admins can review, promote, demote, or delete any answer-bank entry at `/admin/answer-bank`;
     see `0006_answer_bank_validation.sql` for the full state machine
     (`auto_approved` / `pending_review` / `admin_approved` / `rejected`).

     Cache/database lookups only apply to the *opening* message of a topic, not follow-ups
     ("explain more", "why?") — those depend on conversation context a scope-only lookup key can't
     capture, so they go straight to the LLM and are never written back into cache/db.

  Staff (admin/superadmin) chat bypasses the gate/cache/database stages — no board/grade/syllabus,
  straight to the LLM, same as before — but is still reported to observability, since a staff LLM
  call still costs real tokens.

  The response carries a `source: "cache" | "database" | "llm" | "rejected"` field.

  This is a small stateless Express service with a single endpoint (`POST /v1/chat`) gated by a
  shared-secret header, and isn't published to the host or the internet — only `web` can reach it,
  over the Docker Compose network.
- **`services/observability`** owns *how usage gets recorded and priced*. After every `/v1/chat`
  request, the orchestrator reports the outcome — `POST /v1/events`, fire-and-forget, never blocks
  or affects the student's reply — and this service writes one row to the `chat_events` table:
  - **`source: "llm"`** — token counts (prompt/completion) and a computed USD cost, using built-in
    Anthropic pricing (overridable, and required for Azure OpenAI, via `LLM_PRICING_JSON` — see
    `services/observability/src/pricing.ts`). A model with no configured rate still gets its tokens
    recorded, just with a null cost, rather than a silently wrong number.
  - **`source: "cache" | "database" | "rejected"`** — just the occurrence; no LLM was called, so
    there's nothing to price.

  `/admin/observability` reads this table directly (RLS + `is_admin()`, same pattern as the
  catalog and answer-bank pages) for two consolidated views — total LLM cost/tokens by user, and
  total database-hit count — plus a per-user drilldown to the individual query that consumed a
  given number of tokens. Like the orchestrator, it's shared-secret gated and not published to the
  host.
- **`services/payment`** owns everything about *turning a pending subscription into an active
  one*: the CCAvenue integration (request encryption, callback decryption) and one-time coupon-code
  generation/redemption. Also shared-secret gated and not published to the host — but with one
  difference from the other two internal services: it **refuses to start at all** if
  `PAYMENT_SHARED_SECRET` isn't set (the orchestrator/observability instead warn and accept
  unauthenticated requests), since this service handles real money and free-access grants rather
  than chat/analytics traffic. It also independently re-derives everything security-sensitive
  (the amount to charge, whether a subscription is really `pending_payment` and really belongs to
  the caller, whether a coupon is really unused) from its own Supabase connection rather than
  trusting anything `web` relays to it — `web` only does a cheap ownership check before handing off.
  See "Payments (CCAvenue) and coupon codes" below for the full request/response flow, including why
  `web` still has to keep one real (public) route in this flow even though the service itself has
  no public ingress.

This split means the orchestration/prompt/pipeline layer, the usage-accounting layer, and the
payment layer can each be redeployed, scaled, or replaced (e.g. swapping in a real observability
backend, or a different payment gateway, later) without touching the web app or each other.

## How it works

1. **Sign up** — email/password or "Continue with Google" via Supabase Auth (`/signup`, `/login`).
   See "Authentication" below for OAuth setup, password reset, and the native-password expiry
   policy.
2. **Onboarding** (`/onboarding`) — pick a board (e.g. CBSE, ICSE, West Bengal Board), a grade,
   the subjects offered for that board+grade, and a medium of instruction (English / Hindi /
   Bengali). This creates a `pending_payment` subscription.
3. **Payment** (`/subscribe`) — CCAvenue's hosted checkout (a full-page redirect, not an in-page
   modal). A one-time discount code can be entered on the same page first to reduce the price (or,
   at 100% off, skip payment entirely) before checking out for whatever remains. Either way the
   subscription ends up `active` server-side. See "Payments (CCAvenue) and coupon codes" below.
4. **Dashboard** (`/dashboard`) — left panel lists the subscribed subjects; selecting one scopes
   the right-hand chat panel to that subject, and opens a syllabus panel listing every chapter and
   topic for that subject. Every message is answered by Claude, constrained by a system prompt
   built from the syllabus topics stored for that board/grade/subject, in the subscribed medium.
   Clicking a topic drops its LLM-generated summary and a "Relevant Exercises" button straight into
   the chat, as a message bubble in the same conversation — not a separate panel or modal — so a
   student can immediately ask the tutor a follow-up about it without leaving the thread. See
   "Topic summaries and relevant exercises" below.
5. **Admin panel** (`/admin`) — lists every user with their board/grade/medium/subjects/status and
   lets an admin promote/demote admins and cancel subscriptions. `/admin/catalog` manages boards,
   grades, subjects, which subjects each board/grade offers, and the syllabus topics themselves.
   `/admin/answer-bank` is the review queue for the orchestrator's auto-populated answer bank —
   approve, reject, or delete entries other students' questions get matched against.
   `/admin/observability` shows total LLM cost/token usage by user, total database-hit count, and
   a per-user drilldown into individual queries and the tokens/cost each one consumed.
   `/admin/coupons` generates and revokes one-time discount codes, each with its own percentage off.
   `/admin/authorization` (superadmin only) controls which of these pages each individual admin
   can access — see "Per-page admin authorization" below.

## Data model & security

See `supabase/migrations/` for the full schema:

- `0001_init_schema.sql` — `profiles`, `boards`, `grades`, `subjects`, `board_grade_subjects`,
  `syllabus_topics`, `subscriptions`, `subscription_subjects`, `chat_messages`.
- `0002_rls_policies.sql` — Row Level Security. Users can only read their own profile,
  subscriptions, and chat history; the catalog tables are readable by any signed-in user and
  writable only by admins (`profiles.role = 'admin'`). Subscription **activation** and all
  **chat message writes** happen only from trusted server code using the Supabase service-role
  key, never directly from the browser — this is what stops a user from marking their own
  subscription paid or forging an assistant reply.
- `0003_seed_catalog.sql` — CBSE / ICSE / West Bengal Board, Grades 6–12, and the six subjects
  (Mathematics, Physics, Chemistry, Biology, English, Geography), with a representative sample
  syllabus for Grade 9 (all subjects, all three boards) and Grade 10 (Math/Physics/Chemistry/
  Biology) to demonstrate that Q&A scoping genuinely differs per board. **This sample syllabus is
  illustrative, not an authoritative reproduction of any board's official syllabus** — extend and
  correct it via `/admin/catalog` for every grade/board/subject you actually offer before going
  to production.
- `0004_superadmin_and_staff_access.sql` — adds the `superadmin` role tier and its DB-level
  role-change guard.
- `0005_answer_bank.sql` — the orchestrator's Postgres full-text answer bank (`answered_questions`
  table + `search_answer_bank`/`bump_answer_bank_hit` RPCs). `EXECUTE` on both RPCs is revoked from
  `public` and granted only to `service_role` — a student can never read or search this table
  directly, only through the orchestrator's scoped, ranked lookup.
- `0006_answer_bank_validation.sql` — adds `validation_status` (`auto_approved` / `pending_review` /
  `admin_approved` / `rejected`) to `answered_questions`; `search_answer_bank` only ever returns
  `auto_approved`/`admin_approved` rows. Also adds admin-only RLS policies (`is_admin()`) so
  `/admin/answer-bank` can read/update/delete entries through the ordinary session — the same
  pattern as the syllabus catalog tables. There is still no insert policy: every row originates from
  the orchestrator's service-role key, never directly from a client.
- `0007_chat_events.sql` — the `chat_events` table `services/observability` writes to: one row per
  question, tagged with `source` (`cache`/`database`/`llm`/`rejected`), token counts + `cost_usd`
  when `source = 'llm'`, and a link to the matching `answered_questions` row when `source =
  'database'`. Admin-only RLS (`is_admin()`), no insert policy — every row originates from the
  observability service's service-role key.
- `0008_admin_page_permissions.sql` — `admin_page_permissions` (`user_id`, `page`), one row per
  admin page an admin has been explicitly granted. RLS: a user can read their own rows (to render
  their own nav); only a superadmin can read everyone's or write at all. The migration grandfathers
  every existing `admin`-role user in with full access to every page that existed at the time, so
  applying it never silently locks anyone out.
- `0009_syllabus_topics_medium.sql` — adds `medium` to `syllabus_topics`, so the same board/grade/
  subject can have a genuinely separate syllabus per medium instead of one shared across all of
  them (see "Medium-scoped syllabus storage" below). Existing rows are backfilled to `English`
  (what the seed data was authored in); the unique constraint and scope index both grow the new
  column.
- `0010_topic_exercises.sql` — **superseded, see 0012.** Originally added a `topic_exercises` table
  for hand-curated, admin-authored practice questions. Kept in the migration history for the
  record; the feature it supported was replaced before shipping.
- `0011_password_lifecycle.sql` — adds `profiles.password_changed_at`; updates
  `handle_new_tutorops_user()` to also coalesce Google's `'name'` metadata key (not just the app's
  own `'full_name'`) and to stamp `password_changed_at` at signup when a password was set; adds an
  `auth.users` update trigger that re-stamps it on every later password change. See
  "Authentication" below.
- `0012_drop_topic_exercises.sql` — drops `topic_exercises` (0010). Hand-curated exercises turned
  out to be the wrong shape for this: see "Topic summaries and relevant exercises" below for what
  replaced it.
- `0013_topic_summaries_and_exercise_search.sql` — adds `topic_summaries` (one generated summary
  per topic, RLS enabled with zero client-facing policies — service-role only, same lockdown as
  `answered_questions`) and `search_topic_exercises`, a new RPC alongside the existing
  `search_answer_bank`: returns several ranked `(question, answer)` matches for a chapter+topic
  query instead of the single best match for one exact question, without touching the signature
  the chat pipeline already depends on.
- `0024_chapter_documents_rag.sql` — enables the `vector` extension (pgvector) and adds
  `chapter_documents` (admin-authored, same lockdown as `answered_questions`) and
  `chapter_document_chunks` (chunked + embedded, `hnsw`/cosine index) plus a `match_chapter_chunks`
  RPC, service-role only. See "Chapter notes (semantic retrieval)" below. Worth noting for anyone
  adding a future `security definer` RPC in this project specifically: `revoke execute ... from
  public` alone was **not** enough to lock this function down — this Supabase project's default
  privileges turned out to grant `EXECUTE` directly to `anon`/`authenticated` on function creation
  (confirmed via `pg_proc.proacl`), which is a distinct grant from `PUBLIC`'s and survives a
  `PUBLIC`-only revoke; the fix was revoking from `public, anon, authenticated` explicitly. Neither
  `search_answer_bank` nor `search_topic_exercises` needed this (checked directly against
  `pg_proc.proacl` too), so this may be specific to when/how this project's defaults were set up —
  don't assume `revoke ... from public` is sufficient for a new function without checking.
- `0025_chapter_chunk_metadata.sql` — adds nullable `field_type` and `citation` columns to
  `chapter_document_chunks`, populated only by the pre-chunked JSON bulk-import path (see "Chapter
  notes" below); a chunk from the original paste-and-auto-chunk path leaves both null. Same
  return-type-change constraint as before: `match_chapter_chunks` needed an explicit `drop function`
  (not `create or replace`) to add the two columns to its return table, so the `revoke`/`grant`
  lockdown pair was reapplied afterward and reverified against `pg_proc.proacl`.
- `0026_topic_summary_review.sql` — adds an admin-review gate to `topic_summaries`:
  `validation_status` (`pending_review`/`approved`/`rejected`, defaulting existing rows to
  `approved` so this doesn't retroactively hide already-live content) and `updated_at`, plus
  admin-only select/update/delete RLS policies (the table previously had zero client-facing
  policies at all). Also extends `chat_events`'s `source` check constraint with `chapter_notes`,
  and registers the new `topic_summaries` admin page permission with the usual grandfathering. See
  "Topic summary review" below.

### Medium-scoped syllabus storage

A board's official syllabus isn't always a mechanical translation across mediums of instruction —
West Bengal Board's Bengali-medium Grade 9 Mathematics syllabus, for example, is authored in
Bengali and isn't guaranteed to line up chapter-for-chapter with an English-medium version of the
"same" course. `syllabus_topics` is therefore scoped by `(board, grade, subject, medium)`, not just
`(board, grade, subject)` — `/admin/catalog` has a medium selector alongside board/grade/subject,
and `/api/chat` fetches only the topics matching the student's subscribed medium. Enter each
medium's syllabus straight from its own authoritative source document rather than translating one
canonical version — Postgres `text` columns are UTF-8, so this needs no encoding-specific handling,
just picking the right medium before pasting content in.

Syllabus content is stored one row per chapter/topic line item, not as one large blob per subject —
the orchestrator's relevance filter and chapter-list scope boundary both operate per row (see
`services/orchestrator/src/syllabusFilter.ts`), so a single giant row would defeat the token-cost
optimization those rely on. Entering dozens of rows one at a time through the single-topic form is
tedious, so `/admin/catalog` also has a **bulk add** option: paste a syllabus with one chapter name
per un-indented line and its topics indented underneath (bullets like `-`, `*`, `•` are stripped
automatically) — close to how these documents are already structured in the official source — and
it's parsed into individual rows in one submit, appended after whatever's already stored. Re-pasting
the same lines is safe; duplicates are silently skipped rather than erroring or duplicating rows.

**A student sees a completely empty syllabus panel whenever their subscribed medium has zero
`syllabus_topics` rows for that board/grade/subject** — this reads exactly like a bug (the panel
genuinely does render "nothing") but is almost always a data gap, not one: syllabus content has to
be entered separately per medium (see above), so a subject entered under, say, English medium is
invisible to a Bengali-medium subscriber of the *same* board/grade/subject until someone pastes or
adds it under Bengali medium too — confirmed via a real case where a WBBSE Grade 9 English subject
had topics only under English medium while the only subscribed student for that board/grade was on
Bengali medium. Whether the Bengali-medium content should be identical to the English-medium one or
genuinely different is a per-subject judgment call (a literature subject taught *about* English is
plausibly the same chapter list either way; a subject taught *in* the local language typically isn't
— see the Mathematics example above) — not something to assume either way without asking.

**Removing a syllabus topic cascades (`ON DELETE CASCADE`) to every chapter document attached to it
via `topic_id`, and their embedded chunks along with them** (`0024_chapter_documents_rag.sql`) —
correct referential integrity, but silent: nothing in the original flow warned an admin that editing
the syllabus (e.g. replacing one generic topic with several specific ones) would quietly delete
already-imported Chapter Notes content tied to the topic being removed. `/admin/catalog` now counts
attached chapter documents per topic (a service-role read, since `chapter_documents` has zero
client-facing RLS policies same as `answered_questions`) and shows a `📎 N` badge next to any topic
that has some; removing one of those routes through `ConfirmSubmitButton` (the same reusable
client-component confirm() wrapper the Users page uses for deleting a user) with a message naming
the exact count, rather than the plain button used everywhere else. A topic with nothing attached
skips the confirm entirely — no reason to add friction to routine cleanup that has nothing at stake.

### English-subject language toggle (native medium vs. English)

Every rule above assumes a student wants explanations in their own subscribed medium — true for a
Bengali-medium student learning Mathematics, but not necessarily true for the same student learning
*English*: English is the language being learned, so sometimes they want the tutor to reply in
Bengali to explain it, and sometimes they deliberately want English replies for immersion practice.
The chat header shows a two-way toggle (subscribed medium vs. English) whenever the open subject is
English (`subjects.code = 'ENG'`) and the student's medium isn't already English — nothing to switch
to otherwise, so the toggle is simply absent for every other subject and for English-medium students.

The toggle is client-side UI state only (unpersisted, reset to native whenever the student switches
subjects and back — `ChatPanel` remounts per subject via its `key` in `dashboard-shell.tsx`) and sends
a `preferEnglish` boolean alongside each `/api/chat` request; the server is what actually decides
whether to honor it, re-checking the subject code and medium itself rather than trusting the client's
own gating. When honored, it overrides the single `medium` value threaded through the whole
4-stage pipeline (`services/orchestrator/src/server.ts`) — the Redis cache key, the answer-bank FTS
scope, the chapter-notes RAG retrieval scope (`match_chapter_chunks`), the syllabus topics fetched for
the chapter-list boundary, and rule 1 of the LLM system prompt ("Respond ONLY in ...") — so toggling to
English is a single well-understood lever rather than a parallel code path, and a Bengali student
toggled to English automatically gets any English-medium syllabus topics or chapter notes entered for
this subject, not just an English-language reply layered on top of Bengali-medium content.

### Topic summaries and relevant exercises

Selecting a subject opens a syllabus panel (desktop only) listing every chapter and topic for that
board/grade/subject/medium — direct client-side Supabase queries against `syllabus_topics` (same
pattern the chat panel uses for message history), since that table is already readable by any
authenticated user under RLS. Staff accounts skip this panel entirely — they aren't scoped to one
board/grade, which is what the panel is keyed on.

Clicking a topic drops a message bubble (`TopicSummaryMessage`) straight into the chat timeline,
not a separate panel or modal — a student can ask the tutor a follow-up about it without leaving
the conversation. `ChatPanel` maintains a unified `TimelineEntry[]` of real `chat_messages` rows
interleaved with these topic entries (never persisted — purely local, so reloading the page drops
them but keeps the real conversation), rather than two disconnected message lists. The clickable
chapter/topic list itself lives in `topic-list.tsx` (`TopicList`), shared by two different frames:
`SyllabusPanel` (a persistent desktop sidebar, `hidden lg:block`) and a mobile-only `Topics` tab in
`DashboardShell` (the tab button is `lg:hidden`, since desktop already has the sidebar) — without
this, topic browsing, summaries, and "Relevant Exercises" would all have been entirely unreachable
below the `lg` breakpoint, i.e. on every phone. Either path lifts the click up to `DashboardShell`
(`topicClick: { clickId, topic }`, a fresh `clickId` even for the same topic clicked twice, so it
always drops a new bubble the same way sending a duplicate message would) via a single
`handleSelectTopic` that also switches the active main tab to `Chat` — necessary because a topic
click on `Topics` (mobile) or while the desktop `Practice` tab is active would otherwise drop the
resulting bubble into a panel the student isn't currently looking at, with no visible feedback that
anything happened. It shows two things, both LLM-backed and unlike the syllabus topics themselves,
generated rather than hand-entered:

- **Summary.** `GET /api/topics/[id]/summary` resolves the topic's board/grade/subject names
  server-side, then proxies to the orchestrator's `/v1/topic-summary`, which checks four sources in
  order before ever calling the LLM: admin-authored chapter notes, the Redis cache, the
  `topic_summaries` database, and only then generates fresh — see "Topic summary review" below for
  the full lookup order and why an LLM-generated summary needs admin approval before it's reused.
- **Relevant Exercises**, a separate button shown once the summary loads. `GET
  /api/topics/[id]/exercises` proxies to `/v1/topic-exercises`, which searches the existing answer
  bank (`search_topic_exercises` — see the migration list above) for an exact `topic_id` match. A
  hit returns whatever's already there; a miss generates `EXERCISE_GENERATION_COUNT` (5) fresh
  question+solution pairs, runs each solution through the same `validateAnswerForStorage` heuristic
  the chat pipeline already uses (filtering out anything that reads as hedging or a question asked
  back rather than an answer), and attempts to store the ones that pass into `answered_questions`,
  tagged with the topic's ID — so a later "relevant exercises" click on this same topic, by anyone,
  can hit them too. `topic_id` on `answered_questions` (`0015_answer_bank_topic_id.sql`) is
  nullable and set only by this flow — an ordinary chat-answered question has no syllabus topic
  concept, only the board/grade/subject/medium scope `search_answer_bank` already uses — and is
  what makes this an *exact* lookup rather than the full-text ranking every other answer-bank
  lookup in this pipeline uses. That distinction matters here specifically because nothing else on
  the row identifies which topic an exercise came from: without `topic_id`, "relevant exercises for
  topic A" and "relevant exercises for topic B" would only be told apart by how closely each row's
  `question` text happens to rank against topic A's or B's chapter+topic name — the same ranking
  approach `search_answer_bank` uses for chat questions, which is appropriate there (a genuinely
  fuzzy "does this row answer roughly the same question" lookup) but wrong here, where the two
  topics are unambiguous and conflating them means one topic's "Relevant Exercises" can surface
  another topic's questions, or fail to resurface its own. The student always sees every exercise
  that passed validation regardless of whether the store actually succeeds (a write failure never
  costs them the exercises they just asked for), but before each individual write,
  `findAnswerInBank` (the same single-best-match full-text lookup `/v1/chat` uses, unrelated to the
  topic_id matching above) checks whether that specific question already exists anywhere in the
  bank — since the topic-level search only misses when *nothing* is banked for this exact topic
  yet, not when one particular generated question happens to duplicate something banked under a
  *different* topic — so a near-duplicate is skipped rather than written twice. Any write failure
  (e.g. the orchestrator's Supabase connection isn't configured) is logged rather than silently
  dropped, the same fix applied to the chat pipeline's own answer-bank write.

Both endpoints are entirely orchestrator-owned (its existing service-role Supabase connection), the
same division of responsibility as the rest of the pipeline: the web app's role is resolving
context and proxying, never talking to an LLM or writing to these tables directly. Both report to
observability the same way `/v1/chat` does (`source: "database"` on a hit, `"llm"` on a
generate-and-store), tagged with a descriptive `question` string (`topic-summary: ...` /
`topic-exercises: ...`) so they're distinguishable from ordinary chat questions in the admin
observability dashboard.

### Topic summary review

`/v1/topic-summary` checks four sources, in order, before ever calling the LLM — each a fallback
for the one before it:

1. **Chapter notes (RAG).** If an admin has authored or imported chapter content for this exact
   topic (`chapter_documents`, the same store chat grounding reads from — see "Chapter notes"
   below), that content *is* the summary. `getStoredChapterSummary` looks it up by a plain
   `topic_id` equality match, not a semantic search — the topic is already known exactly (the
   student clicked it), so there's nothing to search for, and this skips spending a Voyage
   embedding call on every single topic click. Already curated by a human, so it's shown as-is with
   no review gate and never touches the LLM.
2. **Cache (Redis).** A summary generated earlier and already admin-approved — see step 3 for why a
   pending or rejected summary never reaches the cache.
3. **Database (`topic_summaries`).** A summary generated earlier. Only a row with
   `validation_status = 'approved'` counts as a hit here and gets promoted into the cache — a
   `pending_review` row is still *returned to this one request* (no reason to regenerate identical
   content, or leave the student with nothing, while it awaits review) but is deliberately kept out
   of the cache and not treated as a hit for a *later* lookup, mirroring exactly how the answer bank
   keeps a `pending_review` answer out of both `search_answer_bank` and the Redis cache until an
   admin confirms it. A `rejected` row is treated as a miss and falls through to step 4, so a
   rejected topic self-heals on the next click instead of staying empty until someone notices.
4. **LLM.** Generates fresh and upserts into `topic_summaries` as `pending_review` — unlike
   answer-bank entries, there's no auto-approve heuristic here (see
   `0026_topic_summary_review.sql`): a single summary per topic is reused by *every* student who
   opens it, so it's worth a human's confirmation every time, not just when the LLM's own output
   looks shaky the way a one-off chat answer does. Returned to this request but, same as a pending
   database hit, not cached.

**`/admin/topic-summaries`** is the review queue this backs — pending-review by default, with
Approved/Rejected/All filters. Approve promotes a row so it starts serving from cache/database on
the next click; Reject demotes it (and evicts any Redis entry — `POST
/v1/topic-summary-cache/invalidate`, mirroring the existing `/v1/cache/invalidate` used by the
answer bank's own reject/delete) so the topic regenerates instead of continuing to serve rejected
text; Delete removes the row outright. `topic_summaries` previously had RLS enabled with zero
policies at all (only the orchestrator's service-role connection ever touched it) — `0026` added
admin-only select/update/delete policies, but this page still reads/writes through the service-role
client for consistency with every sibling admin page, and there's still no insert policy, since a
row only ever originates from the orchestrator's LLM-generation path.

A `chapter_notes` chat-event source (`chat_events`'s `source` check constraint, extended by
`0026_topic_summary_review.sql`) and a matching `ChatEventSource` addition across the web app,
orchestrator, and observability service let step 1 hits show up distinctly in
`/admin/observability` rather than being folded into `database`.

### Chapter notes (semantic retrieval / RAG)

The answer bank and topic summaries above both work by *matching a whole question*, which is the
right model for MCQ/formula-style content where wording tends to overlap. Prose doesn't fit that
shape — an English-medium literature chapter has real content (plot, characters, themes) that a
student might ask about in any of a hundred different phrasings, and full-text search on a
paraphrase ("why was he upset") won't match text that says "he was angry" the way keyword overlap
does for a repeated formula. This feature adds proper semantic retrieval on top of admin-authored
chapter content, so a chat reply can be grounded in the real text instead of the LLM's own
(unverifiable) general knowledge of it — see the earlier "Do you have the context of the book..."
conversation in this app's own history for exactly the failure mode this exists to avoid: this
codebase's author has no reliable way to verify a specific textbook's content from training data
alone, and neither does the tutor LLM at chat time without something to ground it in.

- **Two tables, deliberately split** (`0024_chapter_documents_rag.sql`): `chapter_documents` holds
  the raw admin-authored text (one row per document; a topic can have more than one — e.g. "Chapter
  summary" and "Character notes" as separate documents) and is what `/admin/chapter-notes` actually
  edits/deletes, same trust model as the answer bank's bulk import (real, curated content, not
  LLM-generated). `chapter_document_chunks` is entirely derived — split into retrieval-sized pieces
  with an embedding vector each, regenerated wholesale (delete-then-reinsert for that
  `document_id`) on every save rather than diffed, since a chapter document is at most a few dozen
  chunks and diffing isn't worth the complexity. Only the orchestrator's own Supabase connection
  ever reads/writes the chunks table, same as `topic_summaries`; the web app's admin action writes
  `chapter_documents` directly (service-role client) but always goes through the orchestrator's
  `POST /v1/chapter-documents/embed` for the derived chunks, since that service holds the only
  Voyage credentials in the app (same reasoning it's the only place holding `ANTHROPIC_API_KEY`).
- **Voyage AI, not a first-party Anthropic embedding model** (`services/orchestrator/src/
  voyageClient.ts`) — Anthropic doesn't offer one, and Voyage is Anthropic's own recommended
  embeddings partner. `voyage-4` at its default 1024-dimension output (a deliberate middle ground:
  `voyage-4-large` for best quality or `voyage-4-lite` for lowest cost/latency were the alternatives)
  handles this app's English/Hindi/Bengali multilingual content in one model. No official Voyage
  Node/TypeScript SDK exists (only Python), so this is a plain `fetch` against their HTTP API — the
  one external call in this codebase that isn't through an SDK. Fails open at every step (missing
  key, network error, malformed response), same philosophy as `cache.ts`/`answerBank.ts`: a document
  save or a chat reply must never fail just because embedding did.
- **Retry with backoff on transient Voyage failures** (`embed`'s own retry loop, `MAX_ATTEMPTS = 4`,
  exponential backoff starting at 1s, honoring a `Retry-After` header on a 429 over its own schedule
  when Voyage sends one) — added after observing the actual failure pattern in production: a
  multi-chapter bulk import calls Voyage once per chapter, back to back with no gap, and the last
  chapter or two in the sequence would occasionally fail to embed while the earlier ones succeeded —
  the classic signature of a requests-per-minute limit (or an occasional transient network blip)
  being tripped partway through a tight sequential loop, not anything wrong with that specific
  chapter's content. Only retries what's actually worth retrying — HTTP 429 and 5xx, or a
  network-level exception — never a 4xx like a bad request or a bad key, which would just fail the
  same way again and only delay surfacing a real problem.
- **Paragraph-based chunking** (`chapterDocuments.ts`'s `chunkText`, `TARGET_CHUNK_CHARS = 1500`) —
  greedily merges consecutive paragraphs up to the target size rather than a fixed character
  window, so a chunk boundary lands between thoughts instead of mid-sentence; a single paragraph
  longer than the target (rare) is hard-split on its own. No overlap between chunks — the added
  complexity wasn't judged worth it for how this app actually uses chunks (a handful stitched into
  a prompt, not reconstructing the original document), unlike RAG setups that need to reassemble
  contiguous ranges.
- **`match_chapter_chunks`** (the RPC) filters on `board_id`/`grade_id`/`subject_id`/`medium`
  equality (denormalized onto `chapter_document_chunks` straight from the parent topic, not derived
  via a join at query time — same reasoning `answered_questions` stores those columns directly)
  before/alongside the `hnsw` vector index's cosine-distance ordering, and converts pgvector's `<=>`
  distance (0 = identical) to a `1 - distance` similarity score, so `chapterRag.ts` can apply a
  min-similarity threshold (`MIN_SIMILARITY = 0.5`) the same way `answerBank.ts` applies
  `MIN_RANK` to `ts_rank` — an irrelevant retrieval match is worse than none, since it can distract
  the model into answering the excerpt instead of the actual question, rather than just being
  useless the way a low `ts_rank` match already was.
- **Wired into `/v1/chat`'s stage 4, not a new short-circuiting stage.** Cache/answer-bank
  (stages 2-3) *replace* the LLM call on a hit; retrieval only ever *augments* the prompt the LLM is
  about to see, so it runs once the pipeline has already fallen through to a real LLM call, for any
  text student question reaching that point — including a follow-up ("explain more"), unlike the
  fresh-question-only cache/database stages, since semantic matching doesn't need an exact repeat
  the way an exact-key cache lookup does. Retrieved chunks are appended to `buildTutorSystemPrompt`
  as reference material to *consult*, explicitly framed as optional ("use it if it actually helps
  ... ignore it if it doesn't apply") rather than a rule to obey the way the syllabus chapter-list
  boundary is — a weak match should be silently ignored by the model, not forced into the answer.
  Skipped entirely for an image-only message (nothing to embed) and in staff mode (unrestricted, no
  single subject's chapter notes to ground it in).
- **`/admin/chapter-notes`** (new admin page, `chapter_notes` permission — `0024`'s migration
  grandfathers existing plain admins into it the same way `0008`/`0019` did for earlier new pages)
  scopes a new document the same way bulk import scopes a paste: board/grade/subject/medium driving
  a client-fetched topic dropdown — except the topic here is *required*, not optional, since a
  chapter document is always about exactly one chapter (unlike a book/exam-paper paste that can span
  several). Editing an existing document doesn't let the scope change — the topic is looked up
  fresh from the existing row server-side (not trusted from a hidden form field) rather than
  re-submitted, so a tampered request can't silently move a document's embeddings into the wrong
  scope, and so the edit form itself only needs a title and content field.
- **Bulk import from pre-chunked JSON** (`ImportChunksForm`, `importChapterChunksJson`,
  `chapterDocuments.ts`'s `embedAndStorePrechunkedDocument`, `POST /v1/chapter-documents/
  import-chunks`) — a second way to populate chapter documents, alongside the single-document paste
  form above, for content prepared *offline* with real structural boundaries already decided (one
  chunk per chapter overview, plot summary, character list, individual vocabulary word, etc.),
  optionally each with its own citation string — rather than one long block of text for this app's
  own naive paragraph-based `chunkText()` to re-split. The uploaded file is a single top-level
  `chunks` array (numeric `chapter_number`, string `chapter_title`/`text`, optional `field_type`/
  `citation` per entry). **Scoped to a whole book, not one topic** — board/grade/subject/medium plus
  a free-text "book" field (a `syllabus_topics.chapter` value, e.g. `"Prose and Poetry"`, offered via
  a `<datalist>` of names already used in that scope but not restricted to them, since the very
  first import for a brand-new book has nothing to suggest yet). Each distinct `chapter_title` found
  in the file is matched (trimmed, case-insensitive) against the `topic` values already entered
  under that book; a title with no match gets a brand-new `syllabus_topics` row created for it on the
  spot (`sort_order` continuing that board/grade/subject/medium's existing sequence, same pattern
  `bulkAddSyllabusTopics` in `/admin/catalog` uses) rather than requiring the admin to pre-create
  every topic by hand first. Each chapter's `chapter_documents` row is then found-or-created by
  `(topic_id, title)` under its own matched/created topic — not one topic shared by the whole file —
  so re-uploading a corrected file updates those same chapters in place rather than duplicating them,
  **and** so a student clicking one specific topic in the syllabus panel gets that topic's own chapter
  notes, not the whole book's content concatenated under whichever topic happened to be picked. The
  two `field_type`/`citation` columns this adds to `chapter_document_chunks`
  (`0025_chapter_chunk_metadata.sql`) are null for anything created through the plain paste form,
  which every reader treats as "no extra metadata," not an error. **Important asymmetry to flag to
  admins:** re-saving one of these chapters through the plain Edit form re-chunks it with the naive
  splitter and silently discards its field_type/citation metadata — updating a JSON-imported chapter
  means re-running this import with a corrected file, not editing it through the other form.
- **Chat-pipeline grounding tightened for retrieved chapter content.** `findRelevantChapterChunks`
  now returns each chunk's `fieldType`/`citation` alongside its text, and `buildTutorSystemPrompt`
  labels each reference chunk with its field type (e.g. `[vocabulary]`) and appends its citation
  (`(Source: ...)`) when present, falling back to naming the chapter/topic when a chunk has none (the
  plain-paste path). A new rule 6 in the system prompt asks the model to ground its answer in
  provided reference material rather than filling gaps with outside knowledge when the material
  covers the question, say plainly what it can't confirm when it only partly does, never quote long
  passages/poem lines/dialogue verbatim from it (paraphrase instead), and name the source when it
  relies on a specific piece. `MIN_SIMILARITY` (the retrieval-layer floor below which a match is
  dropped before ever reaching the model) was raised from an initial `0.5` to `0.55`, matching the
  low end of a starting-point range worth tuning against real usage rather than a value derived from
  this app's own data. These changes were adopted from a set of general RAG grounding/guardrail
  notes provided for this feature; the output-layer checks those notes also describe (a
  citation-presence regex check and a verbatim-overlap check on the LLM's *reply*, both after
  generation) were deliberately not built here — they'd add a regenerate-on-failure loop (real
  latency/cost on every reference-augmented reply) beyond what's been asked for so far, and are worth
  revisiting if hallucination in practice turns out to need them.
- **Few-shot examples, anchoring rule 6.** Three short example exchanges (partial-grounding honesty,
  plain refusal when the material doesn't cover the question, declining a verbatim quote in favor of
  paraphrase) are appended right after the retrieved reference material, only when there *is* any —
  same reasoning as `referenceSection` itself: nothing to anchor, and no reason to pay the token cost,
  on the vast majority of chat messages that have no chapter-notes match at all. Written deliberately
  generic (no character names, titles, or story specifics — "that scene," "that poem," "Chapter 2")
  since this prompt serves every subject and board this app has, not one dedicated book; the source
  guardrail notes' own examples name specific "Bliss" chapters and characters, which would read as
  bizarre and out of place on, say, a physics question. A worked example anchors a behavior rule far
  more reliably than the rule's own prose alone — this is the one item from those notes' "few-shot
  examples" checklist entry that was a straightforward, clearly-net-positive addition rather than a
  judgment call, so it was added directly rather than left as a follow-up.

### Mobile navigation

Most students use this on a phone, so `DashboardShell` is two genuinely different navigation
structures below and above the `lg` breakpoint (Tailwind's default `1024px`), not one desktop
layout patched to still render on mobile:

- **Desktop (`lg:` and up)**: unchanged from the original design — a persistent, collapsible
  subjects sidebar (`aside`, `hidden lg:block`, collapsed to a 56px icon strip by default once a
  subject is active), `SyllabusPanel` as a second persistent sidebar for topic browsing, and a
  `Chat`/`Practice` tab strip (`hidden ... lg:flex`) above the main content.
- **Mobile (below `lg`)**: a single fixed **bottom navigation bar** (`<nav>`, `flex lg:hidden`,
  `pb-[env(safe-area-inset-bottom)]` to clear the iOS home-indicator gesture area) with up to four
  destinations — `Subjects`, `Topics`, `Chat`, `Practice` (`Topics`/`Practice` only shown for
  students, not staff, same `boardId && gradeId && medium` gate used throughout) — each a
  full-screen view in the main content area. This replaces two earlier, narrower mobile patches
  (a horizontally scrollable subject-chip row, and a `Topics` tab folded into the same top strip
  desktop uses) with one native-feeling mobile nav surface instead of two competing ones squeezed
  into a desktop-shaped layout.

Both structures are driven by the same `mainTab` state (`"subjects" | "topics" | "chat" |
"practice"`) and the same three content panels (`TopicList`, `ChatPanel`, `PracticePanel`), which
all stay mounted and toggle via CSS `display` rather than conditional rendering — switching tabs,
on either layout, never discards a panel's local state (the chat timeline's ephemeral topic
bubbles, or an in-progress Practice search). `subjects` and `topics` are values `mainTab` only ever
takes on mobile — desktop has no UI that sets them, since it reaches the same content through its
own sidebars instead. Selecting a subject or a topic always jumps to the `Chat` tab afterward
(`handleSelectSubject`/`handleSelectTopic`), since that's where the result actually appears; without
it, e.g. picking a topic while on `Practice` would drop the resulting summary bubble into a panel
the student isn't looking at, with no visible feedback that anything happened.

The chat input row (`ChatPanel`) has two more mobile-specific fixes: the message `<input>` is
`text-base` (16px) below `sm`, not `text-sm` — iOS Safari auto-zooms the entire page on focusing any
input/textarea under 16px, and a chat box gets refocused constantly, so this was a real recurring
bug, not a font-size preference. The Send button is icon-only below `sm` (`➤`, with an `aria-label`
since the visual "Send" text is hidden there) rather than a full text label, which was a third
element competing for width alongside the attach button and the input itself on a narrow screen;
the label reappears at `sm:` and up.

### Answer bank tags — search by source ("Ganit Prakash", "WBJEE 2023")

`topic_id` scopes an entry to one syllabus topic, but a lot of real content doesn't map cleanly to
a single topic at all — a textbook's exercise set or a past exam paper usually spans several. Tags
(`answered_questions.tags`, `0016_answer_bank_tags.sql` — a plain `text[]` with a GIN index, not a
normalized tags table, since these are open-ended admin-assigned labels rather than a controlled
vocabulary needing rename-once-updates-everywhere semantics) are a second, independent axis: free-form
provenance labels a student can search by directly, e.g. "show me exercises from Ganit Prakash" or
"questions from WBJEE 2023."

- **Admin: editing, tagging, topic linkage, and bulk import** (`/admin/answer-bank`). Every entry —
  however it originated — has an "Edit question/answer" disclosure (`EditAnswerForm`, the one client
  component on this otherwise server-actions-only page) with a form pre-filled from the current
  text; submitting it calls `editAnswer` in `actions.ts`, which updates `question`/`answer` (answer
  can be left blank, same as bulk import's optional `A:` line) and evicts the matching Redis cache
  entry the same way `rejectAnswer` does — otherwise a stale cached answer under the old question or
  old wording would keep being served until its TTL expired on its own. `validation_status` is left
  untouched by an edit; approving/rejecting is still its own separate action, so fixing a typo
  doesn't silently change a row's review state. `editAnswer` takes `(scope, prevState, formData)`
  rather than the `(scope, formData)` every other row-level action here uses, specifically so
  `EditAnswerForm` can drive it through `useActionState` and see when a save actually lands — needed
  to close the `<details>` afterward, since its open/closed state is native DOM state a server
  re-render can't touch on its own; without that it stays open across the post-save refresh and
  reads as a second edit window popping up instead of the row just updating. The edit form also
  understands the same inline-image placement bulk import does, since an edit is the only way to fix
  a row that never went through the bulk-import parser at all -- e.g. one where an admin typed an
  `IMG:` line directly into a plain edit before this existed, which just saves as inert text with no
  processing (`editAnswer` is a separate code path from `parseBlock`/`importParsedRows`, and always
  has been). Its two textareas display `[IMAGE 1]`, `[IMAGE 2]`, … (`markersToPlaceholders`,
  `src/lib/imageMarker.ts`) in place of this row's real, invisible `IMAGE_MARKER` characters, numbered
  by the row's plain `image_urls` order (labeled the same way next to each thumbnail further down the
  page, so which placeholder is which image is never a guessing game) -- a textarea can neither
  display nor let someone type that PUA character directly, and "[IMAGE N]" always refers to an
  *existing* image regardless of whether it already had a marker or was just trailing from the old
  flat `addImage` flow, so any previously-attached image becomes repositionable this way, not only
  ones added after this feature existed. A brand-new image still uses the exact bulk-import `IMG:
  filename.png` syntax, resolved against a second file picker this form now also has. Both reference
  kinds resolve back to `IMAGE_MARKER` in a single combined-regex pass
  (`COMBINED_IMAGE_REF_PATTERN`, `IMAGE_PLACEHOLDER_PATTERN.source` joined with `IMAGE_LINE_PATTERN
  .source`) rather than two separate ones, specifically so the two forms interleaved in the same
  field resolve in their true left-to-right order instead of "all placeholders first, then all new
  images" -- the same ordering bug that would otherwise reproduce inside a single edit. An existing
  image never mentioned by any `[IMAGE N]` in the saved text is preserved as a trailing extra rather
  than dropped; deletion stays the separate `removeImage` button's job alone, never an implicit
  side effect of editing the text. Every entry can
  also have tags added or removed inline (`addTag`/`removeTag` in `actions.ts`, a plain
  read-modify-write against the `tags` array; fine for an admin-only tool with no meaningful
  concurrent-edit risk). The row list also shows each entry's syllabus topic when it has one (joined
  from `syllabus_topics` via `topic_id`), and the filter row now has `?board=`/`?grade=`/`?subject=`/
  `?medium=`/`?topic=` alongside the existing `?status=`/`?tag=` — the topic dropdown only appears
  once all four scope fields are chosen, since a topic name isn't unique across the whole catalog.
  All filters compose (`buildHref` in `page.tsx` merges the current set with whatever a status pill,
  tag chip, or filter-form submit overrides). A **bulk import** section (collapsed `<details>`,
  `BulkImportForm`, a client component using `useActionState` for flash feedback — same pattern as
  `SetPasswordForm`) accepts the same `Q: ... / A: ... / ---` block format the orchestrator's
  exercise generation uses — `A:` itself is optional, for a question whose entire answer is a
  diagram or handwritten working rather than text. A diagram doesn't have to be attached
  afterward the normal per-row way (see "Answer bank images" above) either: an `IMG:
  filename.png[, filename2.png]` line placed *anywhere* in a block (one or more filenames,
  comma-separated) marks which of the files picked in a second, multi-select file input belong
  to that question, and — this is the part that isn't just "attach it to the row somewhere" —
  **exactly where** in the question/answer text it renders: right after one sub-part's solution
  and before the next, for instance, in a single long answer covering several sub-parts each with
  their own diagram. Matched by filename against whatever was actually selected, not by upload
  order or position, so there's no fragile anchoring to get wrong the way the earlier
  spreadsheet-embedded-image attempt had. A reference to a filename that wasn't actually
  selected (a typo, or a file left out of the picker) doesn't fail the import; that question
  still goes in, its `IMG:` line's marker (see next paragraph) is removed since there's nothing to
  place there, and the unmatched reference comes back in the result so it can be fixed by
  hand — a board/grade/subject/medium selection, an *optional* topic (its own
  dropdown, populated client-side once all four scope fields are picked — left unset by default,
  since a book chapter or exam paper usually spans several topics, but assignable when a specific
  question genuinely belongs to one), and a comma-separated tag list applied to every question in
  that paste. Each parsed question is checked against `search_answer_bank` (the same RPC the chat
  pipeline and exercise generation use for their own dedup, callable here too since the admin client
  authenticates as `service_role`) before being written, so re-importing the same source a second
  time skips whatever's already banked instead of duplicating it — and the form reports back exactly
  how many of the parsed questions were imported vs. skipped as duplicates, or a specific error if
  none could be parsed at all (no more silent no-ops on a malformed paste). Those dedup checks run
  with bounded concurrency (`mapWithConcurrency`, 8 in flight at a time) rather than one at a time —
  a plain sequential loop was, by far, the slowest part of importing a source with hundreds of
  questions (one Postgres round trip per row, back to back), and a bare `Promise.all` over the whole
  batch would just as clumsily open as many concurrent connections as there are rows. Row IDs are
  generated client-side (`crypto.randomUUID()`) before the insert rather than left to the column's
  own default, so any matched image can be uploaded straight to its final `${id}/${uuid}` storage
  path (same convention `addImage` uses) and included in the very same insert — no separate update
  pass, and no window where a freshly-imported row is briefly imageless. Bulk-imported rows still
  skip `validateAnswerForStorage` entirely (that heuristic exists to catch an LLM-generated answer
  hedging or reading like a question asked back — neither applies to hand-sourced content) and are
  stored `admin_approved` immediately. `parseImportBlocks` normalizes `\r\n`/`\r` to `\n` before
  splitting on the `---` separator — pasting from a Windows-originated source (or through some
  clipboard managers/editors) can leave CRLF line endings, and a stray `\r` sitting right before the
  separator's newline used to stop the split from matching there at all, silently swallowing every
  subsequent block into the answer of whatever came before it (the same fix was applied to the
  orchestrator's identical, deliberately-duplicated `parseGeneratedExercises` in `exerciseParser.ts`,
  which it's kept in sync with). The content itself can be supplied two ways — typed/pasted into the
  `bulkText` textarea, or as an uploaded `.txt` file (`textFile`, preferred over the textarea when
  both are present) carrying the exact same `Q:`/`A:`/`---`/`IMG:` format — hundreds of entries are
  easier to author, review, and fix in a real text editor than in a browser `<textarea>`, and both
  sources run through the identical `parseImportBlocks`. This form previously also accepted a direct
  PDF upload (extracting a PDF's text layer with `unpdf` and feeding it through a PDF-specific block
  splitter), but that path was removed — text (typed, pasted, or as a `.txt` file) is the one
  supported source now. Raising `next.config.ts`'s `experimental.serverActions.bodySizeLimit` from
  Next's 1MB default to `24mb` stays in place regardless, since a `.txt` file up to
  `MAX_TEXT_FILE_BYTES` plus several diagram images can still add up past the default — and that
  default turned out to already be silently under the *existing* 4MB single-image-upload cap too,
  since nothing this size had been sent through a Server Action before.
- **Answer-similarity check on top of `search_answer_bank`'s dedup** (`answerSimilarity`,
  `MIN_ANSWER_SIMILARITY = 0.5`) — `search_answer_bank`'s own matching is scoped entirely to the
  `question` column's `tsvector`, which is the right call for its primary use (the chat pipeline
  matching a student's live question against banked ones, where there's no answer text to compare
  against yet). Bulk-imported MCQ blocks broke that assumption: a block is often headed by a
  generic, per-chapter-recurring line like "১১. বহু বিকল্পীয় প্রশ্ন (M.C.Q.)" with everything that
  actually distinguishes the question pushed down into the answer's sub-parts, so two *different*
  chapters that happen to number their MCQ section the same way collided as a false-positive
  full-text match on `question` alone — confirmed against real data where "Koshe Dekhi 7.3" and
  "Koshe Dekhi 7.4" both used "১১. বহু বিকল্পীয় প্রশ্ন (M.C.Q.)" verbatim as their heading with
  entirely unrelated answers underneath. Rather than touch `search_answer_bank` itself (it's shared
  with the chat pipeline, where question-only matching is correct), the fix lives entirely in
  `importParsedRows`: a question-text match is no longer trusted on its own — `answerSimilarity`
  additionally compares the matched row's `answer` (already returned by `search_answer_bank`,
  previously read only for truthiness) against the candidate's `answer` via Jaccard similarity
  (intersection over union of each answer's lowercased, Unicode-aware word-token set — the same
  `[^\p{L}\p{N}]+` splitting used elsewhere in this codebase for non-Latin-script tokenizing), and
  only counts it as a real duplicate above the 0.5 threshold. Calibrated against the real colliding
  rows above: the two genuinely different MCQ answer sets scored 0.28 (shared boilerplate like
  "উত্তর: (a)/(b)/(c)/(d)" alone accounts for most of that), while a true or lightly-reworded
  duplicate scored 1.0 — 0.5 sits with clear room on both sides.
- **Inline image placement within one answer** (`IMAGE_MARKER`, `src/lib/imageMarker.ts` — a single
  Unicode Private Use Area code point, guaranteed never to occur in real document text, so splitting
  on it can never misfire on genuine content; kept in its own tiny file rather than `actions.ts`
  itself specifically because a `"use server"` file can only export async Server Actions, not a
  plain constant). `parseBlock` replaces each `IMG:` line with one `IMAGE_MARKER` per filename
  listed, in place, instead of deleting the line outright — so a question with several sub-parts,
  each with its own diagram, can have each `IMG:` line sit right after the sub-part it belongs to,
  and the marker preserves that exact position all the way through to storage and rendering. Before
  any upload happens, an unresolvable reference (no matching file in the picker, wrong type, too
  big) has its marker stripped from the row's `question`/`answer` right away (`stripMarkersAt`, a
  single pass removing a given set of marker *ordinals* — removing several one at a time would shift
  the ordinal numbering out from under later removals) so a typo never leaves a dangling marker with
  nothing behind it. The remaining, resolved filenames upload concurrently (same `mapWithConcurrency`
  as the dedup checks) but are written into `image_urls` **by index**, not pushed — completion order
  isn't submission order, and a multi-image row needs its images landing in the same order their
  markers appear in the text regardless of which upload happens to finish first. Rendering
  (`text-with-inline-images.tsx`, imported by both this admin list and the student-facing Practice
  panel) splits the stored text on `IMAGE_MARKER` and interleaves each `image_urls` entry, in order,
  right after the segment whose marker it replaced; any images beyond the marker count found (the
  common case for a row that predates this feature, or one built up entirely through the normal
  per-row `addImage` action, which never inserts a marker at all) render as a trailing block after
  everything else — the exact old flat-list behavior, so this is a strict superset rather than a
  breaking change for existing content. `splitInlineImages` recovers which of a row's flat
  `image_urls` belong to the question vs. the answer without needing to store anything extra: markers
  are written in question-then-answer order by the parser, so counting markers in `question` alone
  gives the split point. The one accepted rough edge: a genuine mid-upload failure (as opposed to the
  synchronously-detected "no matching file" case, which is handled precisely) can shift which image
  ends up paired with which later marker in that same row, since the final `image_urls` array is
  compacted after the fact — judged acceptable given how rare an actual upload failure is compared to
  a typo'd filename.
- **`GET /api/answer-bank/tags` and `GET /api/answer-bank/search`** both accept an optional `topicId`
  alongside `tag`, so a lookup can be tag-only, topic-only, or both combined (e.g. "Ganit Prakash
  exercises for this specific topic") — `search` requires at least one of the two, since neither
  would mean "everything ever banked for this subject," an unbounded dump with no real use case here.
  Both resolve the student's board/grade/medium from their active subscription and verify the
  requested subject is actually part of it (`src/lib/studentScope.ts`, the same entitlement check
  `/api/chat` applies) before querying — `answered_questions` has zero client-facing RLS policies, so
  without this a student could otherwise read any board/grade/subject's tagged content, not just
  their own. Only `auto_approved`/`admin_approved` entries are ever returned.
- **Refine Relevant Exercises by tag, inline in chat** (`TopicSummaryMessage`). Once a topic's
  exercises load, if any of them have been tagged (an admin has to have added a tag to a specific
  topic-scoped entry for this to show anything — see admin tagging above), tag chips appear to
  narrow the list further via the combined `topicId` + `tag` search above, without leaving the
  conversation. This is a lightweight refinement on top of the existing per-topic flow, not a
  replacement for the Practice panel below.
- **Practice panel** (`PracticePanel`, a `Chat` / `Practice` tab next to the chat timeline, plus the
  mobile-only `Topics` tab described above — all three stay mounted and toggle via CSS display
  rather than conditional rendering, so switching tabs never discards any panel's state, e.g. an
  in-progress chat or a half-built search). The dedicated browse/search surface for the answer bank:
  tag chips (via the `tags` endpoint), and results that update automatically as soon as a tag is
  picked — no separate submit step, since this is a facet filter, not a form. Unlike `SyllabusPanel`,
  this tab renders identically on mobile and desktop, since it lives in the main content area rather
  than a sidebar. `SyllabusPanel`'s previous standalone tag search box (an earlier, disconnected
  version of this) was removed in favor of this single, more capable surface. **Topic-based
  filtering was later removed from this panel entirely** (it originally also had a topic dropdown,
  combinable with the tag filter, backed by `topicId` on `/api/answer-bank/search`) — topic browsing
  still exists via `SyllabusPanel`/the mobile `Topics` tab, which drop a summary bubble into the chat
  timeline instead; that API route's own `topicId` parameter is untouched and still used by that flow
  and by the chat bubble's own tag refinement below, this panel just no longer sends it. Practice is
  deliberately read-only — no LLM call happens here — so each result has an **"Explain further in
  chat"** button for the case
  where a student doesn't follow the banked solution: it switches to the Chat tab and immediately
  sends a composed message asking for a more detailed, step-by-step explanation of that specific
  question and its banked answer (`ChatPanel`'s `practiceQuestionClick` prop, carried down from
  `dashboard-shell.tsx`, the same fresh-id-per-click shape as `topicClick` — `performSend`, shared
  with the ordinary Send button, is a `useCallback` so this effect can list it as a dependency rather
  than reach for a function declared later in the component). No manual Send step: two earlier
  versions of this either showed a separate, non-editable preview card above an empty input (read as
  a confusing second text box, and didn't render the question's LaTeX) or seeded the input for the
  student to edit and send themselves (which, left untouched, just re-asked the identical
  already-answered question). Sending straight away with an explicit "explain in detail" framing
  avoids both — no `/api/chat` or orchestrator changes needed either way, since the endpoint just
  answers whatever message text it's given.
- **Tag picker: collapsed behind a filter input, not a chip cloud.** A subject with a few hundred
  banked questions can easily accumulate 50+ tags (e.g. one per chapter/exercise — "Koshe Dekhi
  7.1" through "Koshe Dekhi 21"); rendering every one as an always-visible chip (the original
  design) meant that block alone could push actual results below the fold on a phone-width screen,
  with no bound on how much worse it gets as the bank grows. The chip grid now stays collapsed
  behind a text input (`tagListOpen`, `tagFilter` state) until focused — focusing with no text shows
  every tag (so browsing is still just one tap away), and typing narrows the list live
  (case-insensitive substring match), so the common case — a student who already knows the chapter
  tag they want — is a few keystrokes instead of hunting through rows of chips. While collapsed, the
  same input doubles as a "currently selected tag" readout (combobox-style: its displayed value is
  the selected tag when closed, the raw typed filter when open) with an inline ✕ to clear it.
  Closing happens via the input's own `onBlur`, *except* from a chip click — chip buttons call
  `onMouseDown={(e) => e.preventDefault()}` to stop the browser's default focus-shift-on-click from
  blurring the input (and closing the dropdown) a moment before the click's own handler even runs;
  `selectTag` closes it deliberately afterward instead, plus blurs the input itself so tapping a
  chip also dismisses the on-screen keyboard on mobile. Both this and the topic dropdown share the
  same underlying `/api/answer-bank/tags` endpoint and facet-filter behavior from before — this
  changes only how the tag list is *displayed*, not how filtering works.
- **Re-fetches on two different kinds of "coming back to this tab,"** not just when a filter
  changes — since Chat/Practice/Topics stay mounted the whole time (see above), a search's `results`
  would otherwise sit in memory unchanged indefinitely, including after an admin edits that exact
  content on `/admin/answer-bank`. Neither is a timer or a manual refresh button:
  1. Switching **in-app** tabs (Chat → Practice) within the same browser tab. `dashboard-shell.tsx`
     passes `active={mainTab === "practice"}` down; a `wasActiveRef`-guarded effect re-runs the
     current search only on the false→true transition (not on every render while already active,
     which the filter-change effect already covers).
  2. Switching **browser** tabs/windows and back — e.g. editing a question on `/admin/answer-bank`
     in a separate browser tab, then returning to the one already showing Practice. That's a
     different browser tab entirely, so no in-app React state (including #1 above) ever sees it
     happen; only `visibilitychange`/`window focus` listeners fire on that return trip. Also fetches
     with `cache: "no-store"`, ruling out a stale cached response for an identical GET URL as a
     contributing factor on top of both of these.
- **Not yet built**: natural-language tag querying from inside the chat box itself (typing "show me
  WBJEE 2023 questions" as an ordinary message and having it get detected and routed to a tag search
  instead of the tutor). The Practice panel above is the dedicated-UI foundation; chat-based querying
  would need new intent-detection logic in `/v1/chat` to distinguish a tag lookup from a real
  syllabus question, which is a separate, larger piece of work.

Both list surfaces over `answered_questions` are paginated rather than capped at a fixed row count,
using the same range-fetch pattern in each case: fetch `PAGE_SIZE + 1` rows via `.range()`, display
only the first `PAGE_SIZE`, and treat the presence of that extra row as "there's more" — no separate
`count: "exact"` query, since the table only ever grows and an exact count would go stale immediately
anyway.

- **Admin Answer Bank list** (`/admin/answer-bank`, `PAGE_SIZE = 25`). A `?page=` param drives
  `.range()`; Prev/Next links go through the same `buildHref` every other filter link uses, so
  paging preserves the active status/tag/board/grade/subject/medium/topic filters, while changing
  any filter (a status pill, a tag chip, the filter form, or Clear filters) resets back to page 1 by
  passing `page: null` through `buildHref`'s overrides.
- **Practice panel search** (`SEARCH_LIMIT = 20` in `/api/answer-bank/search`). An `?offset=` query
  param drives the same `.range()` pattern server-side; the client (`practice-panel.tsx`) tracks
  `hasMore` from the response and shows a "Load more" button that appends to the existing results
  rather than replacing them. A `requestIdRef` counter (incremented per request, compared after the
  fetch resolves) discards a stale response if the topic/tag filter changes while a request — initial
  or "Load more" — is still in flight, the same race-guard pattern used elsewhere for rapidly-changing
  filters.

### Answer bank images — diagrams/figures that go with a question

Some banked questions (typically bulk-imported textbook exercises) inherently include a figure —
a geometry diagram, a graph, a table laid out as an image, sometimes several of them (a multi-page
solution, more than one figure for the same problem) — that can't be captured as plain text. A
plain `<textarea>` (the Bulk Import box) can't hold an image at all, so this is a separate,
per-row action rather than something the bulk-paste format tries to carry: `answered_questions` has
an `image_urls text[]` column (`0017_answer_bank_image.sql`, widened from a single nullable
`image_url` to an array in `0023_answer_bank_multiple_images.sql` — array order is display order,
oldest-appended-first), backed by a public Supabase Storage bucket (`answer-bank-images`) rather
than inline/base64 storage — unlike chat's transient per-message images (never persisted), a banked
entry's images need to persist and be served repeatedly to every student who hits this question,
not just shown once in a single exchange. The bucket is public (no `storage.objects` policy needed)
since only the service-role admin client ever writes to it and any student who can already see this
admin-approved question should be able to see its figures.

- **Admin** (`/admin/answer-bank`): each row shows every attached image with its own "Remove"
  button, plus a file input + "Add image"/"Add another image" button (`addImage`/`removeImage` in
  `actions.ts`). Each upload gets its own storage key — `${rowId}/${randomUUID()}`, effectively a
  "folder" per row — rather than one fixed path, which is what lets a row hold more than one image
  instead of each upload replacing the last; `addImage` reads the row's current `image_urls`,
  appends the new public URL, and writes the array back (same read-then-write pattern as `addTag`).
  `removeImage` takes the specific image's URL, recovers its storage key from the URL, deletes that
  one object, and removes just that URL from the array. `deleteAnswer` cleans up every image for a
  row (`storage.list()` + `remove()` over its "folder") when the row itself is deleted, so nothing's
  orphaned in storage. Same minimal-feedback philosophy as `addTag`: an invalid file (wrong type,
  over 4MB) silently no-ops rather than wiring up a dedicated error-message flow for one row-level
  control.
- **Practice panel**: `/api/answer-bank/search` now selects `image_urls` alongside `question`/
  `answer`, and each result renders every image (if any) after the question and answer text, not
  between them.
- **Not wired into "Relevant Exercises" in chat.** That flow goes through the orchestrator's
  `/v1/topic-exercises` endpoint, which can return either banked entries *or* freshly LLM-generated
  ones in the same response — the LLM-generated half can never have an image, and plumbing
  `image_urls` through the orchestrator's types, `TopicExercisesResponse`, the web app's proxy
  route, and `topic-summary-message.tsx` for the banked-only half wasn't judged worth it yet. The
  Practice panel is the one place banked images reliably show up today.

### Math rendering

Claude routinely answers in LaTeX (`\( \sqrt{25} \)`, `\[ \frac{1}{3} \]`, `$...$`, `$$...$$`) since
that's how an LLM naturally writes math — rendered as plain text that shows up as literal
backslashes and braces instead of the notation it's meant to be. `src/components/math-text.tsx`
(`MathText`) splits a string on those four delimiter styles and renders each math segment with
[KaTeX](https://katex.org/), leaving everything else as plain text; chat message bubbles
(`chat-panel.tsx`), topic summaries/exercises (`topic-summary-message.tsx`), the Practice panel's
search results (`practice-panel.tsx`), and the admin Answer Bank list (`admin/answer-bank/page.tsx`)
all render their content through it instead of directly interpolating the raw string.
`katex.renderToString`'s output is inserted via `dangerouslySetInnerHTML` — the standard, intended
way to use KaTeX; it does not permit arbitrary HTML injection through its LaTeX parser, so this is
safe even though the string being rendered is LLM-generated. `throwOnError: false` renders a parse
error inline (in red) rather than crashing the message it's in.

Bulk-imported textbook content (e.g. Ganit Prakash) is frequently transcribed as plain-text
pseudo-math rather than LaTeX — caret exponents like `x^(1/a)` — which the LaTeX-delimiter pass
never touches, since there's no `\( \)`/`$ $` around it. `MathText` also runs a second, narrower
pass over whatever's left outside actual LaTeX segments, matching that one specific caret-exponent
convention and rendering it as a raised `<sup>` directly (no KaTeX involved for this case) — this
isn't a general math-notation parser, just that one common pattern. Unicode superscripts already
present in imported text (`kᵃ`, `k⁰`, ...) render fine on their own and simply don't match either
pass.

### Image / screenshot questions (vision, not OCR)

Students and staff can attach a screenshot or photo to a chat message — e.g. a textbook question or
their own handwritten working — via the paperclip button next to the chat input
(`src/app/dashboard/chat-panel.tsx`), or scan one directly with a device camera via the adjacent 📷
button. Both feed the exact same `handleImagePick` → `selectedImage` state and send path; the only
difference is which hidden `<input type="file">` triggers it — the camera one adds
`capture="environment"`, which on most mobile browsers opens the rear camera directly instead of the
general photo/file picker (desktop browsers without camera-capture support just fall back to an
ordinary file dialog). Kept as a second, separate input rather than adding `capture` to the existing
one: on mobile, `capture` typically forces camera-only with no gallery fallback, so "scan a new
photo" and "attach an existing file" need to stay independent entry points. There's no separate OCR
pass: the image is sent to the LLM
directly as an image content block (Anthropic's `image`/`base64` source, or OpenAI/Azure's
`image_url` data URI in `azureOpenAIProvider.ts`), and the model reads whatever text, diagram, or
handwriting is in it as part of answering — simpler and higher-quality than OCR-then-prompt, since
the model reasons over the actual image rather than a lossy text transcription of it. A typed
caption is optional; an image with no caption is still a complete question.

A few deliberate scope decisions:

- **Images are never persisted.** There's no Supabase Storage bucket for them — the browser reads
  the file as a base64 data URL (`FileReader`, no upload step) and sends it straight through to
  `/api/chat` → the orchestrator → the LLM for that one exchange only. `chat_messages.content`
  (`NOT NULL`) stores the typed caption, or the placeholder `"[Image]"` when the message was
  image-only, so history stays legible — but the image itself is gone once you leave the page. The
  attached thumbnail is shown inline in the timeline only for the rest of that browser session
  (`previewImageUrl` on the client-side `TimelineEntry`, never written to the database); reloading
  the page keeps the caption/placeholder text but loses the picture.
- **Image-bearing questions skip the cache and answer bank.** Both are keyed on the message's text
  (`services/orchestrator/src/server.ts`); an image's content isn't represented in that text, so a
  text-only lookup key would risk serving (or writing back) an answer that doesn't actually match
  what's in the picture. Every image question goes straight to stage 4 (the LLM) and is never
  cached or written into the answer bank, the same way a follow-up question in an existing
  conversation already bypasses those stages.
- **Size and type caps**, enforced independently at the browser (`chat-panel.tsx`), the Next.js API
  route (`src/app/api/chat/route.ts`), and the orchestrator (`server.ts`) — a request that skips the
  browser check (e.g. a direct API call) is still rejected server-side: JPEG/PNG/GIF/WebP only, and
  roughly 4.3MB decoded (6,000,000 base64 characters, accounting for base64's ~37% size overhead).
  The orchestrator's Express JSON body limit was raised from `1mb` to `8mb` to fit a base64-encoded
  image alongside the rest of a chat request (history, syllabus topics, etc).

### Authentication

Three additions on top of Supabase Auth's default email/password:

- **Google sign-in.** Both `/login` and `/signup` have a "Continue with Google" button
  (`src/components/google-signin-button.tsx`) alongside the native form — additive, not a
  replacement, since not every student has a personal Google account. `src/app/auth/callback/route.ts`
  is the single landing spot for every flow that redirects back with a `code` to exchange for a
  session: Google OAuth and the password-recovery email link both go through it, distinguished only
  by a `?next=` query param (`/dashboard` vs `/reset-password`).

  **Setup required in two places**, since this app doesn't have its own Google OAuth client:
  1. Google Cloud Console → APIs & Services → Credentials → create an OAuth Client ID (Web
     application). Add `https://<your-project-ref>.supabase.co/auth/v1/callback` as an authorized
     redirect URI.
  2. Supabase Dashboard → Authentication → Providers → Google → paste that Client ID/Secret in and
     enable the provider. Also add your app's own origin(s) (e.g. `http://localhost:3000`, your
     production domain) to Authentication → URL Configuration → Redirect URLs, or the callback
     route's redirect will be rejected.

  Google's OAuth payload doesn't populate `raw_user_meta_data ->> 'full_name'` the way the app's
  own signup form does — it uses `'name'` instead — so `handle_new_tutorops_user()`
  (`0011_password_lifecycle.sql`) coalesces both.

- **Password reset.** "Forgot password?" on `/login` → `/forgot-password` (enter email, calls
  `resetPasswordForEmail`) → emailed link → `/auth/callback?next=/reset-password` → `/reset-password`
  (set a new password via `updateUser`). The forgot-password confirmation message is identical
  whether or not the email is actually registered, so the form can't be used to enumerate accounts —
  but that protection is Supabase's own (it silently returns no error for an unregistered email
  specifically to prevent this), not something this app additionally has to paper over. So an actual
  `error` from `resetPasswordForEmail` is never "no such account," only a genuine failure (a dropped
  connection, the project's redirect-URL allowlist, an email-sending rate limit) -- worth telling the
  user honestly rather than claiming success on top of it, which previously left "the email never
  arrived" with no way to tell a real failure apart from normal delivery delay. One real failure mode
  observed here in local dev: `resetPasswordForEmail` (a *fresh* outbound connection, unlike a
  request that reuses one already open) failing with `AuthRetryableFetchError: fetch failed` /
  `status: 0` -- Node's `fetch()` letting the OS resolve Supabase's hostname to an IPv6 address that
  the local network advertises but doesn't actually route, on a network where other, already-connected
  traffic to the same host kept working fine. `src/instrumentation.ts` (+ `instrumentation-node.ts`,
  split out because Next's bundler flags a Node-only `node:dns` import inside a file it also builds
  for the Edge runtime, even guarded by a runtime check -- see that file's own comment) calls
  `dns.setDefaultResultOrder("ipv4first")` once at server startup so every outbound fetch, this one
  included, prefers the route that's actually known to work.

- **Password expiry (native accounts only).** `profiles.password_changed_at` is stamped by two
  triggers in `0011_password_lifecycle.sql`: once at signup (only if the account was created with a
  password — null for a Google-only signup) and again on every subsequent password change, so
  application code never has to remember to update it manually. `isPasswordExpired()` /
  `requireFreshPassword()` (`src/lib/auth.ts`) treat a null `password_changed_at` as "not
  applicable" rather than "expired" — a Google-only account has no password with this app to expire.
  The expiry window is a constant, `PASSWORD_EXPIRY_DAYS = 90`, in the same file. `requireAdmin()`
  and `requireSuperAdmin()` call `requireFreshPassword()` (so every admin page is covered), and
  `/dashboard` calls it directly; an expired native account is redirected to `/change-password`,
  which reuses the same form and action as `/reset-password` (the underlying operation is
  identical, just reached from an active session instead of a recovery link).

- **Admin-facing controls.** Both `/admin` (a Password column: `active` / `expired` / `Google
  only`) and `/admin/users/[id]` (a Password panel with the last-changed date and status) surface
  this rather than it being purely self-service. `password_changed_at` alone can't distinguish "no
  password at all" from "has one but predates the 0011 tracking migration" — both are null — so
  "does this account have a password" is answered by whether it has an `"email"` row in
  `auth.identities`. That can't be read through `admin.auth.admin.listUsers()` /
  `getUserById()` directly — neither reliably populates the `identities` field on the objects they
  return, silently making every account look Google-only regardless of the real data — so
  `get_users_with_email_identity()` (`0014_email_identity_check.sql`, `security definer`,
  `service_role`-only) queries `auth.identities` directly instead.

  From the detail page an admin can:
  - **Send a password reset email** on the user's behalf (`sendPasswordResetEmail` — same
    `resetPasswordForEmail` call the self-service form uses, looking up the target's email via the
    service-role client rather than trusting a submitted one).
  - **Set a password directly** (`setUserPassword`, via `admin.auth.admin.updateUserById`) — works
    even on a Google-only account, since Supabase allows attaching a password to any account
    regardless of how it originally signed up; doing so is what gives that account an `"email"`
    identity and turns on the rest of this panel.
  - **Toggle expiry** with a checkbox (`setAccountExpired`) once a password exists: checking it
    back-dates `password_changed_at` past the expiry window (e.g. after a suspected compromise);
    unchecking it sets `password_changed_at` to now, the same effect a real password change would
    have.

  All three are gated by `requireAdminPage("users")`, same as every other action on that page.

### Signup-source tracking

Every promotion channel (referral, WhatsApp/Telegram groups, paid ads, SEO landing pages, ...) can
tag its links with standard query params, and the app remembers which one actually produced each
signup — visible per-user as a Source column on `/admin`.

- `src/proxy.ts` captures `?utm_source=` (or `?ref=` as a shorter alternative for informal links,
  e.g. a reseller's own code) and `?utm_campaign=` the first time either appears on any page, and
  stores them in cookies (`to_signup_source` / `to_signup_campaign`, 30-day expiry) — **first-touch**
  attribution, so a later click (e.g. a friend's referral link after someone already arrived from an
  ad) doesn't overwrite credit for whichever channel brought them here originally.
- **Native (email/password) signup** forwards the cookies into `supabase.auth.signUp()`'s
  `options.data`, the same mechanism `full_name` already uses — they land in `raw_user_meta_data`
  and `handle_new_tutorops_user()` (`0022_signup_source.sql`) persists them onto the new
  `profiles.signup_source` / `signup_campaign` columns at insert time.
- **Google sign-in** has no equivalent hook — `signInWithOAuth()` doesn't accept custom metadata the
  way `signUp()` does — so `src/app/auth/callback/route.ts` instead patches the profile row after
  the code exchange, but only when the account was created in the last minute (`data.user.created_at`)
  *and* `signup_source` is still null. Both guards exist for the same reason: this callback route is
  reused on every subsequent Google login too, and without them a returning user who later clicks a
  promo link would have their original signup silently reattributed to that later click.
- Both columns are nullable and stay null for any account that predates this feature or arrived with
  no tracking params at all — there's no backfill.

### User management (CRUD)

`/admin` (the Users page) covers the full lifecycle of an account, not just viewing it:

- **Create** — "Add a new user" creates the account directly (email + password, `email_confirm:
  true`) rather than sending an invite email, since the app has no transactional email configured.
  Only a superadmin can create it with a staff role (`admin`/`superadmin`) from this form; a plain
  admin can only create ordinary `user` accounts, mirroring the restriction on `setUserRole` below.
- **Read** — the users table (this page) and the per-user detail page (`/admin/users/[id]`), which
  also shows every subscription for that user.
- **Update** — "Edit profile" on the detail page changes `full_name` and email (email lives on
  `auth.users`, so this goes through the service-role client). Role changes are still their own
  control (superadmin-only, DB-enforced — see `0004_superadmin_and_staff_access.sql`), and an
  active subscription can be cancelled from the same page. A `pending_payment` one instead gets
  an **"Activate without payment"** button (`activateSubscriptionWithoutPayment`) — the admin-side
  counterpart to `/api/ccavenue/callback`'s activation, setting the same `status`/`activated_at`
  fields but skipping the CCAvenue response entirely rather than mimicking it.
  `ccavenue_tracking_id` is deliberately left null, so a subscription activated this way stays
  distinguishable in the data from one that was actually paid for (see "Payments (CCAvenue)" below
  for the self-service equivalent of this same escape hatch — a coupon code).
- **Delete** — the detail page's "Danger zone" permanently deletes the auth user, which cascades
  (`on delete cascade`) to their profile, subscriptions, subscription subjects, chat history, and
  admin page permissions. Gated so an admin can't delete themselves or another staff account —
  deleting a staff account requires a superadmin, same restriction as creating one.

All four operations are enforced server-side in `src/app/admin/actions.ts`, not just hidden in the
UI — the same defense-in-depth pattern as the rest of the admin panel.

### Per-page admin authorization

Role (`user`/`admin`/`superadmin`) still governs the big things — subscription/payment bypass,
whether `/admin` is reachable at all, and role changes themselves (superadmin-only, DB-enforced —
see `0004_superadmin_and_staff_access.sql`). Layered on top, `/admin/authorization` (superadmin
only) controls a finer thing: **which individual admin pages a given admin can see** — Users,
Catalog, Answer bank, Observability, Coupons — independent of their role. A brand-new admin starts with
every page granted (matches what "admin" meant before this existed); a superadmin can then narrow
it per person from `/admin/authorization`. Superadmins themselves always have every page and can't
be restricted here.

This is enforced with the same defense-in-depth pattern used for role changes: `requireAdminPage()`
(`src/lib/auth.ts`) gates both the page component (what renders) and every server action the page
calls (what a crafted request could otherwise reach) — hiding a nav link is a UX nicety, not the
security boundary. An admin who lands on a page they've been unauthorized from — e.g. a link they
had bookmarked before a superadmin revoked it — is redirected to `/admin/no-access` rather than
back into another permission check, which avoids a redirect loop for an admin with zero page
grants.

### Payments (CCAvenue) and coupon codes

All payment and coupon business logic lives in `services/payment` — a fourth internal Express
service, alongside the orchestrator and observability. `web` never talks to CCAvenue, never touches
the AES encryption, and never writes `coupon_codes` or flips a subscription to `active` directly;
it only authenticates the caller and does a cheap ownership check (does this session's user really
have a `pending_payment` subscription, or a page they're allowed to be on) before handing off over
HTTP (`src/lib/paymentClient.ts`, modeled on `orchestratorClient.ts`).

- **CCAvenue is redirect-based, not an in-page modal.** Razorpay's checkout.js (the gateway this
  replaced) opens a JS modal in the current page and calls back with a signature to verify
  client-side-initiated. CCAvenue's classic integration instead redirects the whole browser to a
  hosted checkout page and POSTs back with the result — so `CCAvenueCheckout`
  (`src/app/subscribe/ccavenue-checkout.tsx`) doesn't open anything; it fetches an encrypted
  request blob from `/api/ccavenue/initiate`, writes it into a hidden form via refs (not React
  state, to avoid any render-timing race with the submit), and calls `form.submit()` to navigate
  away entirely.
- **The encryption *is* the integrity check.** `services/payment/src/ccavenue.ts` implements
  CCAvenue's documented scheme: the working key is MD5-hashed into an AES-128 key, paired with a
  fixed (CCAvenue-specified, not this app's choice) 16-byte IV. `POST /v1/payment/initiate` (called
  by `web`'s `/api/ccavenue/initiate` proxy route) re-fetches the subscription through the
  service's own Supabase connection — never trusting the amount or status `web` relayed — builds
  the request string (`merchant_id`, `order_id`, `amount`, `redirect_url`, `cancel_url`, ...), and
  encrypts it. `merchant_id` and the working key never leave this service, only the resulting
  ciphertext and the (non-secret) `access_code` go back to the browser.
- **`web` still owns one real public route in this flow.** `services/payment` has no public
  ingress of its own (same internal-only pattern as the orchestrator) — but CCAvenue can only
  redirect a customer's *browser* to a real public URL, so `POST /api/ccavenue/callback` in `web`
  still exists as a thin proxy: it forwards the raw encrypted response to
  `POST /v1/payment/callback`, which decrypts it, checks `order_status` (a clean decrypt plus
  `order_status === "Success"` is the whole check — no separate signature verification needed, the
  same way Razorpay's HMAC check isn't needed here), activates the subscription, and returns
  `{ redirectTo }` for `web` to turn into an actual HTTP redirect to `/dashboard` or
  `/subscribe?error=...`.
- **No separate order-id column.** Razorpay minted its own order id server-side and the app had to
  remember it (`razorpay_order_id`). CCAvenue instead takes whatever `order_id` *we* send — so
  `initiatePayment` just uses the subscription's own `id`, and the callback looks the subscription
  up directly with no extra lookup column needed. Only `ccavenue_tracking_id` (CCAvenue's own
  transaction reference, for audit/support) is stored, replacing the old `razorpay_payment_id`
  (`0019_ccavenue_and_coupons.sql`).
- **Fails closed, unlike the orchestrator/observability services.** `services/payment` refuses to
  start at all if `PAYMENT_SHARED_SECRET` is unset (`process.exit(1)`), rather than warning and
  accepting unauthenticated requests — money and free-access grants warrant a stricter default than
  chat/analytics traffic gets.
- **Not verified against a live CCAvenue sandbox.** This was implemented from CCAvenue's documented
  integration scheme, without the ability to test against their actual test environment from here —
  test the full flow with CCAvenue's sandbox credentials (`CCAVENUE_ENV=test` in
  `services/payment/.env.local`) before relying on it.

**Coupon codes** are a separate, self-service **percentage discount** on the subscription price —
a 100%-off code reproduces the same end state as the admin's existing
`activateSubscriptionWithoutPayment` (see "User management (CRUD)" above), just gated by knowing a
valid code instead of admin access; anything less than 100% reduces the price and the student still
pays the remainder through CCAvenue. Generation, revocation, and redemption are all
`services/payment` endpoints (`services/payment/src/coupons.ts`); `web`'s `/admin/coupons` and
`/subscribe` pages only handle auth/authorization and call through `paymentClient.ts`, the same
split as the CCAvenue flow above.

- `/admin/coupons` generates codes in a chosen batch size with a chosen **discount percentage**
  (`generateCouponCodes` in `src/app/admin/coupons/actions.ts` → `POST /v1/coupons/generate`) —
  `discount_percent` (1–100, `supabase/migrations/0021_coupon_discount_percent.sql`) is shared
  across the whole batch. Codes are 12 characters from a 32-symbol alphabet that excludes
  visually-ambiguous characters (no `0`/`O`, `1`/`I`/`L`, or `U`), grouped as `XXXX-XXXX-XXXX` for
  readability, with enough entropy (60 bits) that no collision-retry logic is needed. An unused code
  can be revoked (deleted via `POST /v1/coupons/revoke`); a used one is kept as a permanent record
  of which student it discounted, the same way the answer bank never hard-deletes a rejected entry.
  The admin page itself still reads the `coupon_codes` list directly through the session client for
  display (RLS + `is_admin()`, same pattern as the catalog/answer-bank pages) — only the writes go
  through the service.
- On `/subscribe`, a "Have a discount code?" field (`CouponForm` / `redeemCoupon` in
  `src/app/subscribe/actions.ts` → `POST /v1/coupons/redeem`) claims the code, then either activates
  the subscription outright (100% off) or reduces `amount_paise` by the coupon's `discount_percent`
  and leaves it `pending_payment` — `CCAvenueCheckout`'s next `/v1/payment/initiate` call reads
  `amount_paise` fresh, so it automatically charges the discounted amount with no separate "apply
  discount at checkout" step needed. A subscription can only have one coupon applied to it ever
  (`coupon_codes.subscription_id` being already set on any row is the guard against stacking two
  codes on the same subscription). **Single-use overall**, not per-student: once any one student
  redeems a code, it's permanently spent for everyone. Claiming is atomic
  (`update ... where used_by is null`, returning the updated row or nothing) — a race between two
  simultaneous redemption attempts for the same code can't both succeed.
- `coupon_codes` has no student-facing RLS policy at all (admin-only, `is_admin()`-gated) — there's
  no client-side path to redeem a code even in principle; `services/payment` is the only thing that
  ever writes `used_by`/`used_at`/`subscription_id`/`amount_paise` on those tables.
- Codes have an **optional expiry** (`expires_at`, nullable — `supabase/migrations/0020_coupon_expiry.sql`).
  Leaving the "Expires" date blank when generating a batch keeps "valid forever until redeemed
  or revoked" behavior; setting one applies to every code in that batch. Redemption checks it twice: an
  upfront read (`"That coupon code has expired."`) and again inside the atomic claim itself
  (`... .or('expires_at.is.null,expires_at.gt.<now>')`), so a request that straddles the exact expiry
  moment can't sneak through between the two checks. The admin list shows a third status, **Expired**,
  for codes that are unused but past their `expires_at` (distinct from Used/Unused).

## Local setup

You can run this either with Docker Compose (one command, all services) or by running the web app,
orchestrator, and observability service as three separate `npm run dev` processes. Either way,
steps 1–3 below (Supabase) are the same.

### 1. Install dependencies

```bash
npm install
cd services/orchestrator && npm install && cd ../..
cd services/observability && npm install && cd ../..
```

(Not needed if you're only going to run via Docker Compose — the images install their own
dependencies during `docker compose build`.)

### 2. Create a Supabase project

Create a project at [supabase.com](https://supabase.com) (or run one locally with the Supabase
CLI), then run the migrations against it, in order:

```bash
# via the Supabase CLI, from the project root
supabase link --project-ref <your-project-ref>
supabase db push
```

(Or paste the contents of each file in `supabase/migrations/`, in numeric order, into the
Supabase SQL editor.)

### 3. Promote yourself to admin

Sign up through the app once, then in the Supabase SQL editor:

```sql
update public.profiles set role = 'admin' where id = '<your-auth-user-id>';
```

### 4. Configure environment variables

There are **four** env files — one per service:

```bash
cp .env.example .env.local
cp services/orchestrator/.env.example services/orchestrator/.env.local
cp services/observability/.env.example services/observability/.env.local
cp services/payment/.env.example services/payment/.env.local
```

**Root `.env.local`** (the web app):

- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` —
  Supabase dashboard → Project Settings → API.
- `ORCHESTRATOR_URL` — leave as `http://orchestrator:4000` for Docker Compose; use
  `http://localhost:4000` if running the orchestrator directly with `npm run dev` instead.
- `ORCHESTRATOR_SHARED_SECRET` — any random string; must exactly match the same variable in
  `services/orchestrator/.env.local`.
- `PAYMENT_URL` — leave as `http://payment:4200` for Docker Compose; use `http://localhost:4200` if
  running the payment service directly with `npm run dev` instead.
- `PAYMENT_SHARED_SECRET` — any random string; must exactly match the same variable in
  `services/payment/.env.local`. Unlike `ORCHESTRATOR_SHARED_SECRET`, this one isn't optional in
  practice — the payment service refuses to start without its own copy of it set.

**`services/orchestrator/.env.local`** (the orchestration service):

- `ORCHESTRATOR_SHARED_SECRET` — same value as above.
- `REDIS_URL` — leave as `redis://redis:6379` for Docker Compose (a `redis` service is included in
  `docker-compose.yml`); use `redis://localhost:6379` against a locally installed Redis if running
  the orchestrator directly with `npm run dev`. Optional in the sense that the pipeline fails open
  (caching is just skipped) if unset or unreachable — but every question then costs at least a
  database lookup. `CACHE_TTL_SECONDS` optionally overrides the default 7-day cache lifetime.
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — same Supabase project as the web app (Project
  Settings → API). Used only to query/populate the `answered_questions` full-text answer bank; the
  service-role key is required since that table's RLS has no client-facing policies.
- `OBSERVABILITY_URL` — leave as `http://observability:4100` for Docker Compose; use
  `http://localhost:4100` if running the observability service directly with `npm run dev` instead.
  `OBSERVABILITY_SHARED_SECRET` — any random string; must exactly match the same variable in
  `services/observability/.env.local`. Both are optional in the sense that reporting fails open
  (usage just goes unrecorded) if unset — the chat pipeline itself is unaffected either way.
- `LLM_PROVIDER` — `anthropic` (default) or `azure-openai`. Only fill in the section for
  whichever one you pick:
  - **Anthropic**: `ANTHROPIC_API_KEY` from [console.anthropic.com](https://console.anthropic.com).
    `ANTHROPIC_MODEL` is optional and defaults to Anthropic's current flagship model.
  - **Azure OpenAI**: `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_ENDPOINT` from your Azure OpenAI
    resource's Keys and Endpoint page, `AZURE_OPENAI_CHAT_DEPLOYMENT` (the deployment name you
    gave the model in Azure AI Foundry, e.g. `gpt-4o`), and `AZURE_OPENAI_API_VERSION` (e.g.
    `2024-08-01-preview`).

**`services/observability/.env.local`** (the usage/cost tracking service):

- `OBSERVABILITY_SHARED_SECRET` — same value as above.
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — same Supabase project again. Used only to write to
  `chat_events`; the service-role key is required since that table has no client-facing insert
  policy.
- `LLM_PRICING_JSON` — optional. Anthropic model pricing is built in; set this to update a rate,
  add pricing for Azure OpenAI (which varies by region/agreement and has no built-in default), or
  reflect a promotional/negotiated rate. See `services/observability/src/pricing.ts` for the
  built-in table and the exact JSON shape.

**`services/payment/.env.local`** (the payment/coupon service):

- `PAYMENT_SHARED_SECRET` — same value as above. **Required** — this service calls `process.exit(1)`
  at startup if it's missing, unlike the orchestrator/observability's warn-and-continue.
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — same Supabase project again. Used to read/write
  `subscriptions` and `coupon_codes`; the service-role key is required since neither table has a
  client-facing write policy for these operations.
- `CCAVENUE_MERCHANT_ID` / `CCAVENUE_ACCESS_CODE` / `CCAVENUE_WORKING_KEY` — CCAvenue dashboard →
  Business Settings → API Keys.
- `CCAVENUE_ENV` — `test` (default) uses CCAvenue's sandbox at `test.ccavenue.com`; set to
  `production` only once you're using live merchant credentials.

### 5. Run it

**Option A — Docker Compose** (builds and runs all five containers, including Redis):

```bash
docker compose --env-file .env.local up --build
```

The `--env-file .env.local` flag is required (not just `docker compose up --build`) — Compose only
auto-loads a file literally named `.env` for `${...}` substitution in `docker-compose.yml`, and two
values (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) are needed *at build time* to
pass through as Docker build args: Next.js inlines `NEXT_PUBLIC_*` vars into the client-side JS
bundle when it compiles, so setting them only in the running container (which is what plain
`env_file:`/`environment:` does) is too late — the bundle's already been built without them, and
you'd hit `Uncaught Error: Missing NEXT_PUBLIC_SUPABASE_URL environment variable` in the browser.
If you forget the flag, the build now fails immediately with a clear message rather than silently
producing a broken image.

Open [http://localhost:3000](http://localhost:3000). None of the orchestrator, observability, or
payment services are published to your host — they're only reachable from other containers over the
Compose network — so you won't see them on `localhost:4000`/`4100`/`4200`; that's intentional. To
check one directly: `docker compose exec orchestrator wget -qO- localhost:4000/health` (swap
`orchestrator`/`4000` for `observability`/`4100` or `payment`/`4200` for the other two).

The orchestrator's `/health` response includes non-secret configuration presence for its three
optional dependencies (`answerBank`, `cache`, `observability` — each `{ configured: boolean }`,
plus `answerBank.supabaseUrl` so you can eyeball whether it's pointed at the right Supabase
project), specifically so a "the tutor answers fine but nothing shows up in the Answer Bank /
Observability admin pages" report can be diagnosed with one request instead of digging through
container logs — LLM calls don't depend on any of these three, so generation succeeding is no
signal that storage/caching/reporting are actually configured. The observability service's own
`/health` reports the same thing for *its* Supabase connection (`storage: { supabaseUrl,
configured }`) — a separate service with its own env file, so the orchestrator reporting
`observability.configured: true` only means it can *reach* the service, not that the service can
actually write to Postgres; check both independently.

If you ever change `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY`, you must rebuild
(`--build`), not just restart — a plain `docker compose up` without `--build` reuses the existing
image with the old values baked in.

**Option B — four `npm run dev` processes** (no Docker), one per terminal:

```bash
# terminal 1
cd services/orchestrator && npm run dev

# terminal 2
cd services/observability && npm run dev

# terminal 3
cd services/payment && npm run dev

# terminal 4 (repo root)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Make sure `ORCHESTRATOR_URL` and `PAYMENT_URL`
in the root `.env.local` are `http://localhost:4000` and `http://localhost:4200`, and
`OBSERVABILITY_URL` in `services/orchestrator/.env.local` is `http://localhost:4100`, for this mode
(no Redis running this way either, unless you start one yourself — the pipeline's L1 cache is
optional and fails open if unreachable).

### Corporate network / TLS interception

**Symptom:** every outbound HTTPS call from inside a container fails — not just Supabase.
`next/font/google` fails to fetch at build time, login/signup fails with a bare `"fetch failed"`,
and running `wget`/`curl` for *any* HTTPS URL (not just this app's dependencies —
`https://example.com` fails identically) from inside a container comes back with something like
`certificate verify failed` / `Connection reset by peer`.

**Cause:** something upstream of the container — a corporate proxy, antivirus (Kaspersky, ESET,
Zscaler, Netskope, Fortinet, and similar are common culprits), or a VPN client's "SSL inspection"
feature — is intercepting all outbound HTTPS and re-signing it with its own private certificate
authority. The container's default trust store has never heard of that CA, so every TLS handshake
it makes fails verification. This isn't fixable in application code, and disabling TLS verification
(`NODE_TLS_REJECT_UNAUTHORIZED=0`) isn't the right fix either — that would remove protection against
an actual MITM, not just this one. The container needs to be told to trust the intercepting CA.

**Fix:**
1. Find and export the intercepting root CA. Either:
   - Open any HTTPS site in a browser on the same machine → padlock → certificate details →
     Certification Path tab → select the **top-most (root)** entry → View Certificate → Details →
     "Copy to File" → export as Base-64 encoded X.509 (.CER); or
   - Windows Certificate Manager (`certmgr.msc`) → Trusted Root Certification Authorities →
     Certificates → look for anything that isn't a standard public CA (Microsoft, DigiCert,
     GlobalSign, ...) — usually your company's name or an antivirus vendor's — and export the same
     way.
2. Save it as `certs/corporate-ca.pem` in the project root (already gitignored via `*.pem` — never
   commit this, it's specific to your machine/network).
3. Copy `docker-compose.override.yml.example` to `docker-compose.override.yml` (also gitignored —
   `docker compose` picks it up automatically alongside `docker-compose.yml`, no flag needed). It
   mounts the cert into every service and sets `NODE_EXTRA_CA_CERTS` so each one trusts it.
4. `docker compose --env-file .env.local up --build` again.

If you're not behind anything like this, you'll never need any of the above — it's not part of the
default setup.

## Pricing

Pricing is subject-count based (`PRICE_PER_SUBJECT_INR` in `src/lib/pricing.ts`) and computed
server-side when a subscription is created — the client never supplies the amount charged.

## Notes for going to production

- Replace/extend the seeded sample syllabus with the real, complete syllabus for every board and
  grade you offer, via `/admin/catalog`.
- **Test the CCAvenue integration against their sandbox before going live** (`CCAVENUE_ENV=test`) —
  it was implemented from CCAvenue's documented encryption scheme without access to a live sandbox
  from here. Confirm a full pay → redirect → activate round trip, and a cancelled/failed payment
  round trip, both land on the right `/subscribe?error=...` or `/dashboard` outcome.
- Consider adding a reconciliation path for an abandoned payment: CCAvenue's classic redirect
  integration activates a subscription only when the customer's browser makes it back to
  `/api/ccavenue/callback` — if they close the tab after paying but before the redirect completes,
  the subscription stays `pending_payment` with no automatic recovery, same gap the old Razorpay
  integration had. The admin's "Activate without payment" button
  (`activateSubscriptionWithoutPayment`) is the only manual recovery today.
- Configure Supabase Auth email templates / SMTP for production-grade signup emails.
- **Always set `ORCHESTRATOR_SHARED_SECRET`, `OBSERVABILITY_SHARED_SECRET`, and
  `PAYMENT_SHARED_SECRET`** in every env file in production. Without them, the orchestrator and
  observability services accept requests from anyone who can reach them on the network — fine for a
  moment of local experimentation, not for a real deployment. (`services/payment` won't even start
  without its copy, so this one enforces itself.)
- If you're on Azure OpenAI, set `LLM_PRICING_JSON` in `services/observability/.env.local` —
  without it, token counts are still recorded but cost stays unpriced (shown as unpriced in
  `/admin/observability`, never silently reported as $0).
- Whatever you deploy `docker-compose.yml` to (a VM, ECS, Kubernetes, etc.), keep the same
  topology: only `web` should be internet-facing; `orchestrator`, `observability`, and `payment`
  should stay on a private/internal network, reachable only from `web` (and `orchestrator` in
  observability's case).
