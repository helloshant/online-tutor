# TutorOps — Online Tutor SaaS

A chatops-style tutoring platform. Students subscribe to a board, grade, medium, and a set of
subjects; pay via Razorpay; then chat with an LLM tutor that stays confined to the subscribed
subject and that grade/board's syllabus, always answering in the chosen language. Admins get a
panel to see every user's selections and manage the underlying board/grade/subject/syllabus
catalog.

Built with Next.js (App Router), Supabase (Postgres + Auth + Row Level Security), Razorpay, and a
separate LLM orchestration service (Anthropic Claude by default, or Azure OpenAI) with a
cache/knowledge-base pipeline in front of the LLM.

## Architecture

Four containers:

```
 ┌──────────────┐   HTTP (internal only)   ┌──────────────────┐
 │   web (3000) │ ───────────────────────► │ orchestrator      │
 │   Next.js    │  x-internal-api-key      │ (4000, Express)   │
 │   App Router │ ◄─────────────────────── │                    │
 └──────┬───────┘        { reply }         └───┬────┬─────┬─────┘
        │                                       │    │     │
        ▼                                       ▼    ▼     ▼
   Supabase (hosted)                   Redis   Claude/   observability
   + Razorpay                         (cache)  Azure     (4100, Express)
        ▲                                      OpenAI         │
        │                                                     ▼
        └─────────────────────────── writes chat_events ──────┘
                                      (token usage, cost, hit counts)
```

- **`web`** (repo root) owns everything about *who can ask what*: auth, onboarding, Razorpay
  payment, subscription/entitlement checks, the admin panel, and persisting chat history. It never
  talks to an LLM SDK directly.
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

This split means the orchestration/prompt/pipeline layer and the usage-accounting layer can each be
redeployed, scaled, or replaced (e.g. swapping in a real observability backend later) without
touching the web app or each other.

## How it works

1. **Sign up** — email/password or "Continue with Google" via Supabase Auth (`/signup`, `/login`).
   See "Authentication" below for OAuth setup, password reset, and the native-password expiry
   policy.
2. **Onboarding** (`/onboarding`) — pick a board (e.g. CBSE, ICSE, West Bengal Board), a grade,
   the subjects offered for that board+grade, and a medium of instruction (English / Hindi /
   Bengali). This creates a `pending_payment` subscription.
3. **Payment** (`/subscribe`) — Razorpay Checkout. On success the payment signature is verified
   server-side and the subscription is flipped to `active`.
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
them but keeps the real conversation), rather than two disconnected message lists. `SyllabusPanel`
itself is now just the clickable chapter/topic list; the click is lifted up to `DashboardShell`
(`topicClick: { clickId, topic }`, a fresh `clickId` even for the same topic clicked twice, so it
always drops a new bubble the same way sending a duplicate message would) and passed down into
`ChatPanel` as a prop, since the two are siblings with no direct connection otherwise. It shows two
things, both LLM-backed and unlike the syllabus topics themselves, generated rather than
hand-entered:

- **Summary.** `GET /api/topics/[id]/summary` resolves the topic's board/grade/subject names
  server-side, then proxies to the orchestrator's `/v1/topic-summary`, which checks
  `topic_summaries` for an existing row before calling the LLM. A summary is generated once per
  topic and reused by every student who clicks it after that — the bubble never regenerates one
  that already exists.
- **Relevant Exercises**, a separate button shown once the summary loads. `GET
  /api/topics/[id]/exercises` proxies to `/v1/topic-exercises`, which searches the existing answer
  bank (`search_topic_exercises` — see the migration list above) using the chapter+topic name as
  the query. A hit returns whatever's already there; a miss generates
  `EXERCISE_GENERATION_COUNT` (5) fresh question+solution pairs, runs each solution through the
  same `validateAnswerForStorage` heuristic the chat pipeline already uses (filtering out anything
  that reads as hedging or a question asked back rather than an answer), and stores the ones that
  pass into `answered_questions` — so a later "relevant exercises" click on this topic, or even an
  organic chat question that happens to match one of these, can hit them too.

Both endpoints are entirely orchestrator-owned (its existing service-role Supabase connection), the
same division of responsibility as the rest of the pipeline: the web app's role is resolving
context and proxying, never talking to an LLM or writing to these tables directly. Both report to
observability the same way `/v1/chat` does (`source: "database"` on a hit, `"llm"` on a
generate-and-store), tagged with a descriptive `question` string (`topic-summary: ...` /
`topic-exercises: ...`) so they're distinguishable from ordinary chat questions in the admin
observability dashboard.

### Math rendering

Claude routinely answers in LaTeX (`\( \sqrt{25} \)`, `\[ \frac{1}{3} \]`, `$...$`, `$$...$$`) since
that's how an LLM naturally writes math — rendered as plain text that shows up as literal
backslashes and braces instead of the notation it's meant to be. `src/components/math-text.tsx`
(`MathText`) splits a string on those four delimiter styles and renders each math segment with
[KaTeX](https://katex.org/), leaving everything else as plain text; both chat message bubbles
(`chat-panel.tsx`) and topic summaries/exercises (`topic-summary-message.tsx`) render their content
through it instead of directly interpolating the raw string. `katex.renderToString`'s output is
inserted via `dangerouslySetInnerHTML` — the standard, intended way to use KaTeX; it does not permit
arbitrary HTML injection through its LaTeX parser, so this is safe even though the string being
rendered is LLM-generated. `throwOnError: false` renders a parse error inline (in red) rather than
crashing the message it's in.

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
  whether or not the email is actually registered, so the form can't be used to enumerate accounts.

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
  counterpart to `/api/razorpay/verify`'s activation, setting the same `status`/`activated_at`
  fields but skipping the signature check entirely rather than mimicking it.
  `razorpay_payment_id` is deliberately left null, so a subscription activated this way stays
  distinguishable in the data from one that was actually paid for.
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
Catalog, Answer bank, Observability — independent of their role. A brand-new admin starts with
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

There are **three** env files — one per service:

```bash
cp .env.example .env.local
cp services/orchestrator/.env.example services/orchestrator/.env.local
cp services/observability/.env.example services/observability/.env.local
```

**Root `.env.local`** (the web app):

- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` —
  Supabase dashboard → Project Settings → API.
- `ORCHESTRATOR_URL` — leave as `http://orchestrator:4000` for Docker Compose; use
  `http://localhost:4000` if running the orchestrator directly with `npm run dev` instead.
- `ORCHESTRATOR_SHARED_SECRET` — any random string; must exactly match the same variable in
  `services/orchestrator/.env.local`.
- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` — Razorpay dashboard → Settings → API Keys. Use test
  mode keys for local development.

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

### 5. Run it

**Option A — Docker Compose** (builds and runs all four containers, including Redis):

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

Open [http://localhost:3000](http://localhost:3000). Neither the orchestrator nor the observability
service is published to your host — they're only reachable from other containers over the Compose
network — so you won't see them on `localhost:4000`/`localhost:4100`; that's intentional. To check
one directly: `docker compose exec orchestrator wget -qO- localhost:4000/health` (swap
`orchestrator`/`4000` for `observability`/`4100` for the other one).

If you ever change `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY`, you must rebuild
(`--build`), not just restart — a plain `docker compose up` without `--build` reuses the existing
image with the old values baked in.

**Option B — three `npm run dev` processes** (no Docker), one per terminal:

```bash
# terminal 1
cd services/orchestrator && npm run dev

# terminal 2
cd services/observability && npm run dev

# terminal 3 (repo root)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Make sure `ORCHESTRATOR_URL` in the root
`.env.local` is `http://localhost:4000`, and `OBSERVABILITY_URL` in
`services/orchestrator/.env.local` is `http://localhost:4100`, for this mode.

## Pricing

Pricing is subject-count based (`PRICE_PER_SUBJECT_INR` in `src/lib/pricing.ts`) and computed
server-side when a subscription is created — the client never supplies the amount charged.

## Notes for going to production

- Replace/extend the seeded sample syllabus with the real, complete syllabus for every board and
  grade you offer, via `/admin/catalog`.
- Set up Razorpay webhooks if you want to handle payment failures/refunds beyond the
  checkout-success flow already implemented in `src/app/api/razorpay/verify/route.ts`.
- Configure Supabase Auth email templates / SMTP for production-grade signup emails.
- **Always set `ORCHESTRATOR_SHARED_SECRET` and `OBSERVABILITY_SHARED_SECRET`** in every env file
  in production. Without them, the orchestrator and observability service accept requests from
  anyone who can reach them on the network — fine for a moment of local experimentation, not for a
  real deployment.
- If you're on Azure OpenAI, set `LLM_PRICING_JSON` in `services/observability/.env.local` —
  without it, token counts are still recorded but cost stays unpriced (shown as unpriced in
  `/admin/observability`, never silently reported as $0).
- Whatever you deploy `docker-compose.yml` to (a VM, ECS, Kubernetes, etc.), keep the same
  topology: only `web` should be internet-facing; `orchestrator` and `observability` should stay on
  a private/internal network, reachable only from `web` and `orchestrator` respectively.
