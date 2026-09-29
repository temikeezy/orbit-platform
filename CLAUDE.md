# CLAUDE.md — ORBIT operating notes

Fast-path version of `docs/CONVEX_MIGRATION.md` (IIH-internal, not published), `SECURITY.md` and `docs/AUTOMATION_LOG.md`. Where this file disagrees with them, they are more likely right — fix this file. Current state and open follow-ups: `STATUS.md` (IIH-internal, not published).

## What ORBIT is

React 18 + TypeScript + Vite SPA on Convex, deployed to Netlify. No Supabase anywhere: a mention outside `docs/CONVEX_MIGRATION.md` (IIH-internal, not published) or the archived `SECURITY_IMPLEMENTATION_SUMMARY.md` (IIH-internal, not published) is stale — fix it.

| Convex deployment | Role |
|---|---|
| `your-prod-deployment` (`eu-west-1`) | Production |
| `your-dev-deployment` (`eu-west-1`) | Dev |

Netlify site `your-netlify-site`, domain `orbit2.iih.ng`. One site; per-context env vars (`production` / `deploy-preview` / `branch-deploy`) pick the Convex deployment — deliberately no second site.

`convex/` is the whole backend (measured 2026-09-29): 40 function modules plus `schema.ts`/`crons.ts`/`http.ts`, 37 files in `convex/lib/`, 45 tables, 21 crons, 15 `http.route(` calls (10 paths; OPTIONS preflights loop over the auth paths). 196 public and 128 internal functions. Recount before quoting these; they drift.

## The portal runs itself

Founder direction 2026-09-29: no person operates ORBIT; the only human activity is interns doing intern work. Staff roles and screens still work, and a person acting first always wins. Design, reviews and verification: `docs/AUTOMATION_LOG.md`; per-role evidence: `docs/USER_STORY_MATRIX.md`.

**The split.** Model calls run on the agent's Mac mini, because the Claude Code and Codex/ChatGPT subscriptions can only be used there. Every rule, timer and fallback runs in Convex crons, so a Mac outage delays work but never strands it.

- **Runner:** `scripts/agent/cycle.sh`, launchd agent `ng.iih.orbit-agent` (plist beside it, copied by hand into `~/Library/LaunchAgents`), every 8h. The body is wrapped in `main()` so editing the file mid-cycle is safe (zsh reads scripts as it runs them; a plain edit once killed a cycle on "unmatched quote"). Steps: `assess.py` (marking, batch 12) → `admit.py` (admissions screening, 15) → `logbook.py` (daily-log review, 30) → `tasks.py` (weekly tasks for streams with no live task) → `support.py` (answers interns' messages to the ORBIT Agent) → weekly data backup → `agentOps.respondToMarkOutliers`.
- **Marking:** `evidence.py` classifies each submission (text / image / unreadable / unsupported / empty / no-quorum). Two readers (claude sonnet, codex `gpt-5.6-luna`); on disagreement opus breaks the tie; a mark is written only when two agree within 25% of the task's points. A unanimous zero returns the work for changes. Admissions screeners never see name, email, phone, matric or documents.
- **Convex side (all internal):** `agentFallback` settles set-aside marks (5 days; 14 for anything else; never `empty`), `agentAdmissions` is the ONLY admission path, `agentSupervision` settles logbooks and weekly summaries, `agentTasks` publishes tasks (`tasks.seedWeeklyProposals` is now the Saturday fallback), `agentCohorts` rolls cohorts over, `agentSupport` is the helpdesk. Cron comments in `convex/crons.ts` say why each is safe.
- **Model-call security:** every `claude -p` runs `--tools "" --strict-mcp-config` from an empty temp dir (image marking: `--tools Read`, confined to the image folder); codex runs `--sandbox read-only` from the same dir. Conversation text goes to models as JSON. Submissions are untrusted input.
- **Attribution:** every agent decision is by the ORBIT Agent account; audit actions are prefixed `agent.`.
- **Run / dry-run:** `ORBIT_AGENT_DEPLOYMENT=dev python3 scripts/agent/assess.py --dry` (same `--dry` for `admit`, `logbook`, `tasks`). Without the env var the runners hit prod. Python tests: `python3 -m unittest discover -s scripts/agent -p 'test_*.py'`.
- **Health:** logs in `~/.openclaw/workspace/logs/orbit-agent/` (`cycle.out.log`, `cycle.err.log`). Flags `UNHEALTHY` (every row failed on our side — expired CLI login or usage pool) and `BACKUP_FAILED`. The weekly `npx convex export --prod` lands in `~/orbit-backups` (owner-only, FileVault required, `unzip -t` verified, newest 4 kept); it holds live session tokens and personal data.
- **Rule: new automation is INTERNAL functions only.** It adds no public surface, so the auth invariant below stays at four exemptions. The runner calls them with deployment credentials via `npx convex run` (`--prod` unless `ORBIT_AGENT_DEPLOYMENT=dev`).

## Deploys are NOT `git push`

Neither half deploys on push.

**Frontend.** The Netlify site is GitHub-linked but pushes to `main` do not reliably build (`commit_ref: none` seen on historical deploys). Order: push to GitHub, THEN trigger a build:

```bash
curl -X POST -H "Authorization: Bearer $NETLIFY_PAT" \
  "https://api.netlify.com/api/v1/sites/<site-id>/builds"
```

A build can come back `error: Skipped` with no commit; retrigger once. The Netlify MCP deploy action also works if present. `VITE_CONVEX_URL` and `VITE_SENTRY_DSN` are baked in at build time — changing them in the UI does nothing until a build runs. Ids, PAT path and verification steps: the `deploy-orbit` skill.

**Backend.** `npm run convex:push` (dev) / `npm run convex:deploy` (prod). Both wrap the CLI in `env -u CONVEX_DEPLOY_KEY`: a stale key in a shell profile silently overrides the logged-in session and every command fails with a misleading "set CONVEX_DEPLOY_KEY to a new key". Fix = unset it, never mint one.

## The auth invariant

**Convex has no row-level security and cannot have any.** Authorization is function-level. Every public function touching non-public data takes `token: v.string()` and resolves it through `requireUser`/`requireAdmin`/`requireModerator` in `convex/lib/auth.ts`. Exactly 4 of the 196 public functions skip this: `levels.infoForPoints` and `levels.list` (public reference data), `mcp.authenticate` (runs before a token exists), `zoho.exchangeOAuthCode` (the exchange code is the credential).

Enforced mechanically by `src/test/unit/convex-authz-surface.test.ts`, which parses every module and fails if a public function declares no token, never resolves it, or makes it optional (following local helper indirection; the allowlist fails when an entry goes stale). A fifth exemption is a deliberate edit to that file. Details, including why role demotion does not revoke sessions: `SECURITY.md` — read it before writing or reviewing a public function.

`publicUser()` in `convex/lib/auth.ts` is the only user shape allowed to cross the wire (strips `passwordHash`, `tempPassword`). Never `return user`.

## `intake.ts` truncates, `input.ts` rejects — on purpose

- `convex/lib/input.ts` REJECTS: authenticated writes (logbook, posts, messages). The member sees why; silently cutting off saved work is worse.
- `convex/lib/intake.ts` TRUNCATES: only the public application form, where a stranger cannot cheaply be walked through field errors.

Pick by who is writing, not where the code sits. Do not unify them.

## Agent posts are made BY the agent

Platform-voice content (welcome, announcement, stream notice) is posted through the ORBIT Agent (`orbit.agent@iih.ng`), authenticated via `mcp.authenticate` with `MCP_SECRET_<NAME>`. Never from a human's account: the feed shows the author, and an announcement under a staff name reads as their personal opinion.

Conversely `posts.update` is author-only with no admin override: with no RLS, an admin-editable feed lets anyone holding an admin session rewrite the platform's voice with nothing in the row to show it. To change someone else's post use `posts.adminCorrectPostContent` — internal (deployment credentials, not a login), refuses non-`text` posts, writes an audit row with old and new content.

## All email goes through ZeptoMail — no exceptions

Every message, test and draft goes through the platform's ZeptoMail sender. Never Gmail, `gog`, `himalaya` or Mail.app, even for a draft the owner wants to see: a different sender means the wrong From, wrong DKIM and a different inbox folder, so it previews nothing real.

Ways to send, in order of preference:
1. **The queue** — `emailQueue` + `email.processQueue`: logged, retried, visible in Admin -> Email logs.
2. **`email.drainType`** — sends ONE queued type while the global `EMAIL_PAUSED` hold stays on.
3. **`email.sendOne` via `npx convex run --prod`** — one message, bypassing the queue; fine for a test to a known address.

`EMAIL_PAUSED` is NOT set on prod (verified 2026-09-29), and there is no allowlist or sink: mail flows live.

**Bulk assessment must pass `notify: false`.** `tasks.applyAssessment` defaults to notifying, scheduling a real `notifySubmissionReviewed` email per submission. The runner's bounded batch (12) notifies per mark on purpose; any manual `npx convex run` pass over more than a handful must pass `notify: false`, or a ~500-submission run queues ~500 live emails. Level-up and badge announcements are in-app only.

**Argument-length trap.** `npx convex run` puts arguments on the command line; a base64 attachment over ~1MB fails with `/usr/bin/env: Argument list too long` (no `--file` or stdin). For the 1-2MB manuals, talk to ZeptoMail SMTP directly with the deployment's own credentials (`SMTP_USER`, `SMTP_PASSWORD`, `SMTP_HOST`, `SMTP_PORT`, `EMAIL_FROM`, `EMAIL_FROM_NAME`): same sender and DKIM.

**Sender:** `noreply@orbit2.iih.ng`. That subdomain is ZeptoMail-verified; the apex `iih.ng` is not and is rejected with "553 Sender is not allowed to relay emails". Do not simplify to the apex.

## Tests

```bash
npm run typecheck    # four tsc invocations (app, e2e, convex, node) — all four run in CI
npm test             # vitest: 75 files; 191 tests skip without ORBIT_TEST_MCP_SECRET
npm run test:e2e     # playwright, 20 specs, needs an app pointed at a real Convex deployment
npm run lint && npm run build
```

Typecheck covers `convex/` via `tsconfig.convex.json`; a green frontend typecheck does not mean the backend compiles. Last full e2e run against dev: 202 passed, 2 skipped by design. e2e needs `ORBIT_TEST_MCP_SECRET` (dies in globalSetup without it); exporting it also un-skips the integration tests. The scaffold uses five 20-point level tasks (task points are bounded 1..20) with ids cached in `node_modules/.cache/orbit-e2e/scaffold-tasks.json`, and one shared intern fixture per run under `fullyParallel` — never assert on `totalPoints`; assert `reviewSubmission`'s `points.awarded`. More: `AGENTS.md`.

Manuals (admin, supervisor, intern): `npm run manual:publish` builds all three from `docs/manual/content.py` and publishes PDF + HTML to `public/manuals/`; `manual-sync.test.ts` guards drift.

## Traps

- **Netlify silently drops any redirect whose `from` starts with `/.netlify`** (rejected at parse time, no error). It hid the application-intake redirect for its whole life. Never use `/.netlify/...` as a `from`.
- **The `netlify` CLI here authenticates as a different account** and echoes `netlify.toml`'s `[build.environment]` as though it were the live config. Read Netlify env through the REST API with the PAT.
- **`VITE_CONVEX_URL` / `VITE_SENTRY_DSN` are build-time.** `src/lib/convex.ts` throws at load if `VITE_CONVEX_URL` is unset — deliberately.
- **Session tokens are Convex function arguments**, so they land in the invocation log and any log drain. Production dashboard read access equals session-hijack access; confirm no log drain on `your-prod-deployment`.
- **`git status` may show dirty state from other agents working the same tree.** Check `git diff`/`git status` before assuming a clean baseline; scope changes to your own files.

## Model policy — match the model to the job

- **Heavy reasoning (main model):** architecture, schema, the auth invariant, deployment and readiness calls, complex debugging — anything expensive to get wrong.
- **Lighter (`sonnet`/`haiku` subagents or inline edits):** routine implementation, repetitive edits, exploration, verification sweeps. Exploration is search, not reasoning.
- **Review passes:** Opus 5.5 subagents (`Agent` with `model: "opus"`) for anything security- or correctness-critical. Codex (`codex exec --sandbox read-only`) needs a tight leash and often fails anyway: left open it loads skills, re-reads this file and greps until its budget is gone, returning a transcript with no analysis. Forbid exploration ("do NOT load skills, do NOT grep, review only the diff below"), paste the diff inline, demand a fixed format with a "FINDINGS: none" escape, run it ONCE (it shares a weekly usage pool), and if it wanders say so and move on.
- **Verify what a review agent tells you.** Findings are confident, well cited and sometimes wrong or misframed — right about the symptom, wrong about the mechanism, which changes the fix. Check against the code before acting.
- **Verify the OUTPUT, not the operation.** `resetFeedForLaunch` returned `cleared: 6` yet `posts.feed` never filtered `isDummy`, so all six still rendered; a square logo with `w-auto` "cannot stretch" yet was 902x743 in a lopsided 1024 canvas, undersized and off-centre. Both checks answered a narrower question than the one asked. Look at what the user would look at.
- **Leave a written trail:** what changed, where, why, how verified. Nothing downstream is guaranteed to check.

## Where to look next

`SECURITY.md` (security model) · `docs/CONVEX_MIGRATION.md` (IIH-internal, not published) (migration log and every defect found; a pattern in `convex/` is usually not arbitrary) · `docs/AUTOMATION_LOG.md` (the self-running portal) · `MCP_CONNECTION_GUIDE.md` (agent auth) · `STATUS.md` (IIH-internal, not published) (state, follow-ups) · `docs/PROD_VERIFICATION_2026-08-11.md` (IIH-internal, not published) (point-in-time audit; re-run its checks).
