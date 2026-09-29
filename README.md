# ORBIT

ORBIT is the internship, SIWES and learning operations platform for the Ilorin Innovation Hub (IIH): streams, weekly tasks, submissions, points, levels, badges, leaderboard, community feed, SIWES daily logs and weekly summaries, attendance, admissions, reports and exports.

Since 2026-09-29 the portal **runs itself**: the only routine human activity is interns doing intern work. Staff roles and screens still exist, and a person who acts first always wins. See [How ORBIT runs itself](#how-orbit-runs-itself).

## Run ORBIT at your organisation

ORBIT is open source under the [GNU AGPL-3.0](LICENSE). Any organisation running an internship, SIWES, NYSC or volunteer programme can deploy its own copy for free on a Convex project and any static host. **[SELF_HOSTING.md](SELF_HOSTING.md)** walks through it: clone, configure, one bootstrap command for the first admin, then make it yours (name, letterhead, signature, colours). Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md); report security problems privately as described in [SECURITY.md](SECURITY.md).

The rest of this README describes how ORBIT is built and how IIH operates its own deployment.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript 5.5, Vite 7 (SPA), React Router 7, Tailwind CSS 3.4 (`iih` brand tokens), Lucide |
| Backend | Convex: schema, functions, storage, crons and HTTP routes all live in `convex/` |
| Auth | Opaque bearer tokens held in the `sessions` table (not Convex Auth, not JWT) |
| Email | ZeptoMail SMTP via nodemailer, from a Convex action; queued in `emailQueue` with a claim lease |
| Hosting | Netlify site `your-netlify-site` at `orbit2.iih.ng`: static build, security headers, one redirect. No Netlify functions |
| Agent runner | Python + shell (`scripts/agent/`) on the agent's Mac mini, calling Claude and Codex |
| Tests | Vitest + React Testing Library, Playwright, Python `unittest` |
| Errors | Sentry, optional (`VITE_SENTRY_DSN`) |

Every read and write goes through a named Convex query, mutation or action. As of 2026-09-29 `convex/` has 40 function modules, 37 files in `convex/lib/`, 45 tables, 21 crons and 10 HTTP paths (`convex/http.ts`: Zoho OAuth, the ICS feed, authenticated file serving, public application intake). There is no Supabase anywhere in the codebase; the migration is complete.

## Setup

Prerequisites: Node 20+ and a Convex project (a new install starts at [SELF_HOSTING.md](SELF_HOSTING.md)). The Convex CLI is the `convex` package already in `dependencies`.

```bash
git clone https://github.com/temikeezy/orbit-platform.git orbit && cd orbit
npm install
cp .env.example .env.local        # set VITE_CONVEX_URL (and optionally VITE_SENTRY_DSN)
npm run convex:push               # push convex/ to the dev deployment (your-dev-deployment)
npm run dev
```

- `VITE_CONVEX_URL` and `VITE_SENTRY_DSN` are baked in at **build** time; changing them later does nothing until the next build. `src/lib/convex.ts` throws at load if `VITE_CONVEX_URL` is unset, deliberately.
- Backend secrets (SMTP, Zoho OAuth, the MCP roster) are set with `npx convex env set KEY value`. They are not in the repo or `.env.local`.
- The `convex:*` scripts wrap the CLI with `CONVEX_DEPLOY_KEY` unset; a stale key in the shell otherwise overrides the logged-in session and fails with a misleading error.

## Testing

```bash
npm run typecheck     # four tsc runs: app, e2e, convex, node
npm test              # vitest: unit, component, integration
npm run test:coverage
npm run lint
npm run build
npm run test:e2e      # Playwright, 20 specs; needs an app pointed at a real Convex deployment
python3 -m unittest discover -s scripts/agent -p 'test_*.py'   # agent runner tests
```

Vitest specs live in `src/test/`, Playwright specs in `e2e/`. Exporting `ORBIT_TEST_MCP_SECRET` (dev deployment) un-skips the integration tests that need a live backend, and Playwright cannot start without it. `src/test/unit/convex-authz-surface.test.ts` fails the build if any public Convex function skips token resolution outside its named allowlist. CI (`.github/workflows/`) runs lint, typecheck, tests with coverage and build on every push and PR; e2e has its own workflow.

## Deploying

Neither half deploys on `git push`.

- **Backend:** `npm run convex:deploy` (production, `your-prod-deployment`) or `npm run convex:push` (dev).
- **Frontend:** push to GitHub, then trigger a build through the Netlify REST API. The local `netlify` CLI authenticates as a different account and misreports site config. A build can come back `error: Skipped` with no commit; retrigger once.

Exact commands and traps are in [CLAUDE.md](CLAUDE.md).

## How ORBIT runs itself

The work is split by what can run where:

- **The runner** (`scripts/agent/cycle.sh`, launchd agent `ng.iih.orbit-agent`, every 8 hours) makes the model calls, because the Claude Code and Codex subscriptions only work on that Mac: marking submissions (`assess.py`), screening applications (`admit.py`), reviewing daily logs (`logbook.py`), writing each stream's weekly tasks (`tasks.py`), answering intern messages (`support.py`), plus a weekly verified data backup.
- **Convex crons** (`convex/crons.ts`) hold every rule, timer and fallback: admitting screened applications, settling stale marks and logbooks, seeding fallback tasks, rolling cohorts over. A Mac outage delays work but never strands it.

Every decision is attributed to the ORBIT Agent account (`orbit.agent@iih.ng`); audit actions are prefixed `agent.`. All agent automation is internal Convex functions, so it adds no public surface. Design, reviews and verification: [docs/AUTOMATION_LOG.md](docs/AUTOMATION_LOG.md). Per-role evidence: [docs/USER_STORY_MATRIX.md](docs/USER_STORY_MATRIX.md). Task rules: docs/TASK_PROGRAMME.md (IIH-internal, not published).

Known dependency: everything model-driven needs that Mac to stay on and logged in. Follow-ups are in [ROADMAP.md](ROADMAP.md) and `STATUS.md` (IIH-internal, not published).

## Architecture notes

- **Authorisation is function-level.** Convex has no row-level security. Every public function that touches non-public data takes `token` and resolves it with `requireUser` / `requireAdmin` / `requireModerator` (`convex/lib/auth.ts`). Sessions last 7 days; the client keeps the token in `localStorage` (`orbit_auth_token_v2`). Sign-in is by password, magic link, or Zoho SSO for `iih.ng` staff. Full model: [SECURITY.md](SECURITY.md).
- **Programme clock.** Tasks belong to streams, so ORBIT resolves one platform clock from the active cohort with the latest `startDate` (ties broken by `createdAt`). The server refuses to create, publish or assign tasks before that start. The default deadline is the cohort cadence's weekly due instant (Thursday 23:59 WAT unless overridden).
- **Email.** `email.processQueue` drains `emailQueue` every 2 minutes from a `'use node'` action. All ORBIT mail, including tests and drafts, goes through ZeptoMail as `noreply@orbit2.iih.ng`; see CLAUDE.md before sending any.

## Roles

| Role | Access |
|---|---|
| `intern` | Streams, tasks and submissions, community feed, SIWES logbook where assigned |
| `moderator` | Can review submissions, manage tasks and review SIWES logs for their streams (the ORBIT Agent does all of this by default) |
| `admin` | Users, settings, streams, cohorts, departments, assignments, reports |
| `super_admin` | Admin plus protected operations (granting `super_admin`, MCP credential wiring) |

## Manuals

One manual per role (admin, supervisor, intern), built from `docs/manual/content.py`. `npm run manual:publish` builds all three, renders PDFs with headless Chrome, writes PDF and HTML to `public/manuals/` and regenerates `src/data/manuals.json`; then deploy the frontend. The `/orientation` page shows them to every role. Screenshots come from `npm run capture:manual` (dev only). See [docs/manual/README.md](docs/manual/README.md).

## Documentation

[DOCS_INDEX.md](DOCS_INDEX.md) lists every document. Start with [CLAUDE.md](CLAUDE.md) (operating model, deploy path, traps) and [SECURITY.md](SECURITY.md). docs/CONVEX_MIGRATION.md (IIH-internal, not published) is the migration log and worth reading before assuming a pattern in `convex/` is arbitrary.

Never commit credentials: `.gitignore` blocks `.env.local`, `*.secrets` and `ADMIN_CREDENTIALS.md`.
