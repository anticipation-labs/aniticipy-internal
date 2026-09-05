# Canopy

Shared context store. One Cloudflare Worker on one origin serves the HTTP API,
a stateless MCP endpoint at `/mcp`, and a full single-page app (TypeScript + Vite,
served via the ASSETS binding). Live at `https://www.anticipy.ai/internal/`;
`anticipy-internal.omar-114.workers.dev` remains available as the direct Worker origin.

- `shared/` — Zod contract, vocabulary, D1 row types (imported by `src/` and `web/`)
- `src/` — Worker: `index.ts` (router), `routes.ts` (Hono HTTP), `mcp.ts` (MCP tools),
  `consumer.ts` (the gate — replay-safe, hash-deduped, change-typed), `db.ts`, `tools/`
- `web/` — Full SPA with screens: My Work (default dashboard), Feed, Docs, Roadmap,
  Triage, Search, Settings, and a Get Started guide. Built to `web/dist`.
- `migrations/` — D1 SQL (`0001_init` … `0010_triage_resolve`)
- `plugins/canopy/` + `.claude-plugin/marketplace.json` — the Canopy **plugin** and the marketplace
  that distributes it (see **Install the Canopy plugin**). Bundles the three skills — `canopy`
  (umbrella + `query` reference), `load-context` (read/orient), `record-session` (session-end batch
  writer) — under `plugins/canopy/skills/`, plus the auto-wired MCP server.
- `.claude/skills/` — symlinks into `plugins/canopy/skills/` so this repo's own sessions load the
  bundled skills directly (single source of truth; nothing to keep in sync)

## Read side

FTS5 full-text search: `query()` ranks by bm25 + authority flag, assembles full bodies for
top hits, and returns ranked pointers for the rest. Backs `GET /search` and MCP `query`.
`get_doc` fetches a single doc with all its versions; `get_feed` streams the activity feed;
`get_roadmap` merges live GitHub progress at read time (degrades gracefully if token absent).

## Write side (agents stage, humans confirm)

Every agent write flows through the gate in `src/consumer.ts` — replay ledger
(`processed_items`), content-hash dedupe, change-typing (new/edit/rewrite), and
out-of-vocab or low-confidence entries route to `needs_triage`. HTTP confirm routes
(promote, ratify, reject, assign, discard) are session-cookie-only — never MCP tools.

MCP write tools: `append_feed`, `propose_doc_update`, `propose_milestone`, `set_focus`, and
`record_session` (the session-end batch writer — a whole `IngestPayload` through the same gate).

## The living loop (the skills)

Canopy stays current because agents continuously feed it and humans curate it. Three skills under
`.claude/skills/` drive that loop — **this is the root of how the context system stays alive**, not a
side feature:

1. **Orient — `load-context`** (auto-fires, read-only). Before an agent works an existing area it pulls
   the relevant context via `query` (assembled bodies + ranked pointers, each authority-flagged), so it
   builds on what's already there instead of guessing.
2. **Work** — the agent does the task.
3. **Record — `record-session`** (explicit: "record this session"). At the end it observes what actually
   shipped (`git`/`gh`), reads the affected docs back from Canopy for a true base, and stages **one**
   reconciled batch through the `record_session` MCP tool (same gate as `POST /ingest`, reachable over
   the agent's bearer).

The gate reconciles every write — drops no-ops (content-hash), tags each doc change `new`/`edit`/`rewrite`,
and routes out-of-vocab or low-confidence entries to Triage. A human then promotes / ratifies / rejects /
assigns / discards. **Staging + confirmation is what keeps the store trustworthy as it grows**: nothing
goes live unreviewed, and nothing rots, because every session writes back what it learned.

`canopy` is the umbrella skill (the map, plus the full `query` reference in `references/querying.md`);
`load-context` and `record-session` are the two halves it composes — kept separate because one must
auto-fire and the other must never. They live in this repo so they version with the tools they wrap.
To use them from another machine or repo, install the **Canopy plugin** (below) — it bundles all three
skills and auto-wires the MCP server in one step, so there's nothing to copy by hand.

## Develop

- `npm test` — Vitest against a real Miniflare D1
- `npm run typecheck` — type-check worker + web
- `npm run dev` — build web, then `wrangler dev`
- `npm run deploy` — build web, then `wrangler deploy`
- `npm run db:create` / `db:migrate:local` / `db:migrate:remote` — D1 provisioning + migrations

## Deploy on Cloudflare

Canopy runs as a single Cloudflare Worker: `src/index.ts` behind an `[assets]` binding that serves
the built `web/dist` first and falls through to the Worker for `/ingest`, `/feed`, `/mcp` and the
rest. State lives in **D1**; there is no other datastore and no container.

Everything is declared in `wrangler.toml` — the D1 binding, the `[vars]`, the `[observability]`
switch, and the six-hourly `[triggers]` cron that refreshes the milestone progress cache.

**One-time setup**

1. `npx wrangler login` — authenticate against the target Cloudflare account.
2. `npm run db:create` — provision the D1 database, then paste the returned `database_id`
   into `wrangler.toml`. (Already done for the Anticipy account; the id is committed.)
3. `npm run db:migrate:remote` — apply `migrations/` to the remote D1.
4. Set the secrets (below).

**Every deploy**

Cloudflare Builds deploys `main` from `anticipation-labs/aniticipy-internal`.
It runs `npm run build:web` and then `npx wrangler deploy`. `npm run deploy`
is the manual fallback; it builds `web/dist` before invoking Wrangler.

The two narrowly scoped routes in `wrangler.toml` attach only `/internal` and
`/internal/*` on `www.anticipy.ai`; the rest of the main site stays on its own
Worker. Canopy strips the public base path internally, keeps its session and
OAuth cookies scoped to `/internal`, and continues to work at the root of its
`workers.dev` origin.

`npm run dev` runs the same thing locally against Miniflare with a local SQLite, so nothing
touches production D1 until you deploy.

**Vars** (plain text, in `wrangler.toml`): `GITHUB_ORG` gates who may sign in, `GITHUB_REPO` is the
repo whose issues/PRs drive roadmap progress, `ADMIN_LOGINS` is the comma-separated list of logins
allowed to run admin actions such as the server-side backfill.

## Auth & secrets

Auth gates all data routes (session cookie) and `/mcp` (per-person bearer token), allowing
only active members of the GitHub org named by the `GITHUB_ORG` var (default `anticipation-labs`;
see `DEFAULT_ORG` in `src/auth/github.ts`). Set these Wrangler secrets:

- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` — the organization-owned GitHub
  OAuth App whose callback is `https://www.anticipy.ai/internal/auth/callback`.
- `COOKIE_SECRET` — a long random string used to sign the session cookie.

Production: `wrangler secret put GITHUB_CLIENT_ID` (and the others).
Local dev: copy `.dev.vars.example` to `.dev.vars` (git-ignored) and fill it in.

Mint an MCP token from a logged-in session: `POST /auth/mcp-token` → `{ "token": "canopy_mcp_..." }`
(shown once; or use the web app → Settings → MCP access tokens).

## Install the Canopy plugin (skills + MCP in one step)

The three skills and the MCP wiring ship as a Claude Code **plugin**, distributed from this repo as a
marketplace. Anyone on the team gets both in two commands inside Claude Code:

```text
/plugin marketplace add anticipation-labs/canopy
/plugin install canopy@canopy
```

The plugin's MCP config reads your **personal** bearer from `$CANOPY_MCP_TOKEN`, so export it in the
shell that launches Claude Code (e.g. add it to your shell profile), then restart:

```bash
export CANOPY_MCP_TOKEN=canopy_mcp_...   # your token, minted above — per person, never stored in the plugin
```

That auto-wires the `canopy` MCP server (`query` / `get_doc` / `record_session` …) and loads the
`canopy`, `load-context`, and `record-session` skills — no manual `claude mcp add`, no copying skill
folders. (The single-server manual path still works:
`claude mcp add --transport http canopy https://www.anticipy.ai/internal/mcp --header "Authorization: Bearer canopy_mcp_..."`.
The direct `https://anticipy-internal.omar-114.workers.dev/mcp` endpoint remains valid.)

> **Maintainers:** the plugin is at `plugins/canopy/`; the marketplace manifest at
> `.claude-plugin/marketplace.json`. Validate either with `claude plugin validate <path>`. The real
> skill files live under `plugins/canopy/skills/`; the in-repo `.claude/skills/*` entries are symlinks
> into that bundle, so there is a single source of truth and the two can never drift — edit the files
> under `plugins/canopy/skills/`.
