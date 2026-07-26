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

Three containers:

```
 ┌──────────────┐   HTTP (internal only)   ┌──────────────────┐
 │   web (3000) │ ───────────────────────► │ orchestrator      │
 │   Next.js    │  x-internal-api-key      │ (4000, Express)   │
 │   App Router │ ◄─────────────────────── │                    │
 └──────┬───────┘        { reply }         └───┬────────┬───────┘
        │                                       │        │
        ▼                                       ▼        ▼
   Supabase (hosted)                   Redis (cache)  Anthropic Claude /
   + Razorpay                          + Supabase       Azure OpenAI
                                        (answer bank)
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
     else.
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

  Staff (admin/superadmin) chat bypasses this whole pipeline — no board/grade/syllabus, no
  gate/cache/database, straight to the LLM, same as before.

  The response optionally carries a `source: "cache" | "database" | "llm" | "rejected"` field for
  observability.

  This is a small stateless Express service with a single endpoint (`POST /v1/chat`) gated by a
  shared-secret header, and isn't published to the host or the internet — only `web` can reach it,
  over the Docker Compose network.

This split means the orchestration/prompt/pipeline layer can be redeployed, scaled, or have its LLM
provider swapped without touching the web app, and vice versa.

## How it works

1. **Sign up** — email/password via Supabase Auth (`/signup`, `/login`).
2. **Onboarding** (`/onboarding`) — pick a board (e.g. CBSE, ICSE, West Bengal Board), a grade,
   the subjects offered for that board+grade, and a medium of instruction (English / Hindi /
   Bengali). This creates a `pending_payment` subscription.
3. **Payment** (`/subscribe`) — Razorpay Checkout. On success the payment signature is verified
   server-side and the subscription is flipped to `active`.
4. **Dashboard** (`/dashboard`) — left panel lists the subscribed subjects; selecting one scopes
   the right-hand chat panel to that subject. Every message is answered by Claude, constrained by
   a system prompt built from the syllabus topics stored for that board/grade/subject, in the
   subscribed medium.
5. **Admin panel** (`/admin`) — lists every user with their board/grade/medium/subjects/status and
   lets an admin promote/demote admins and cancel subscriptions. `/admin/catalog` manages boards,
   grades, subjects, which subjects each board/grade offers, and the syllabus topics themselves.
   `/admin/answer-bank` is the review queue for the orchestrator's auto-populated answer bank —
   approve, reject, or delete entries other students' questions get matched against.

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

## Local setup

You can run this either with Docker Compose (one command, both services) or by running the web
app and the orchestrator as two separate `npm run dev` processes. Either way, steps 1–3 below
(Supabase) are the same.

### 1. Install dependencies

```bash
npm install
cd services/orchestrator && npm install && cd ../..
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

There are **two** env files — one per service:

```bash
cp .env.example .env.local
cp services/orchestrator/.env.example services/orchestrator/.env.local
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
- `LLM_PROVIDER` — `anthropic` (default) or `azure-openai`. Only fill in the section for
  whichever one you pick:
  - **Anthropic**: `ANTHROPIC_API_KEY` from [console.anthropic.com](https://console.anthropic.com).
    `ANTHROPIC_MODEL` is optional and defaults to Anthropic's current flagship model.
  - **Azure OpenAI**: `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_ENDPOINT` from your Azure OpenAI
    resource's Keys and Endpoint page, `AZURE_OPENAI_CHAT_DEPLOYMENT` (the deployment name you
    gave the model in Azure AI Foundry, e.g. `gpt-4o`), and `AZURE_OPENAI_API_VERSION` (e.g.
    `2024-08-01-preview`).

### 5. Run it

**Option A — Docker Compose** (builds and runs all three containers, including Redis):

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

Open [http://localhost:3000](http://localhost:3000). The orchestrator isn't published to your host
— it's only reachable from the `web` container over the Compose network — so you won't see it on
`localhost:4000`; that's intentional. To check it directly: `docker compose exec orchestrator wget
-qO- localhost:4000/health`.

If you ever change `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY`, you must rebuild
(`--build`), not just restart — a plain `docker compose up` without `--build` reuses the existing
image with the old values baked in.

**Option B — two `npm run dev` processes** (no Docker), one per terminal:

```bash
# terminal 1
cd services/orchestrator && npm run dev

# terminal 2 (repo root)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Make sure `ORCHESTRATOR_URL` in the root
`.env.local` is `http://localhost:4000` for this mode.

## Pricing

Pricing is subject-count based (`PRICE_PER_SUBJECT_INR` in `src/lib/pricing.ts`) and computed
server-side when a subscription is created — the client never supplies the amount charged.

## Notes for going to production

- Replace/extend the seeded sample syllabus with the real, complete syllabus for every board and
  grade you offer, via `/admin/catalog`.
- Set up Razorpay webhooks if you want to handle payment failures/refunds beyond the
  checkout-success flow already implemented in `src/app/api/razorpay/verify/route.ts`.
- Configure Supabase Auth email templates / SMTP for production-grade signup emails.
- **Always set `ORCHESTRATOR_SHARED_SECRET`** in both env files in production. Without it the
  orchestrator accepts requests from anyone who can reach it on the network — fine for a moment of
  local experimentation, not for a real deployment.
- Whatever you deploy `docker-compose.yml` to (a VM, ECS, Kubernetes, etc.), keep the same
  topology: only `web` should be internet-facing; `orchestrator` should stay on a private/internal
  network, reachable only from `web`.
