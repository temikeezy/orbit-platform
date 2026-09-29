# ORBIT — agent handoff

Written for Codex (or any agent) picking this work up mid-flight. Read this
before touching anything; it exists because several hours were lost to problems
that are invisible unless you know about them.

Companion documents: `CLAUDE.md` (topology, conventions, the self-running
portal), `docs/AUTOMATION_LOG.md` (the agent runner: design, reviews,
verification), `STATUS.md` (IIH-internal, not published) (current state and follow-ups),
`docs/HARDENING_CHANGE_NOTES.md` (IIH-internal, not published) (dated log of the hardening pass),
`docs/PROD_VERIFICATION_2026-08-11.md` (IIH-internal, not published) (what the live deployment looked like).

---

## The state

The `hardening/ci-gates` production-readiness pass is merged into `main`, and
work has continued there since. Merging deploys **nothing**: a push does not
reliably start a Netlify build and Convex never watches git, so production
changes only through the steps under "Before deploying anything".

Since 2026-09-29 the portal runs itself: an agent runner on the Mac mini
(`scripts/agent/cycle.sh`, launchd `ng.iih.orbit-agent`, every 8h) does the
model work — marking, admissions screening, logbook review, task writing,
intern support — and Convex crons settle whatever it cannot judge or a Mac
outage delays. All of that automation is **internal functions only**; the
public-surface count is unchanged. See `CLAUDE.md`. Dry-run against dev:
`ORBIT_AGENT_DEPLOYMENT=dev python3 scripts/agent/assess.py --dry` (likewise
`admit`, `logbook`, `tasks`); Python tests:
`python3 -m unittest discover -s scripts/agent -p 'test_*.py'`.

Local gates all pass:

```bash
export VITE_CONVEX_URL=https://your-dev-deployment.eu-west-1.convex.cloud
npm run typecheck && npm run lint && npm run test && npm run build
```

`npm ci` must keep working from a clean checkout — it once did not and nothing
noticed. Vitest is 75 files (657 pass, 191 skip without
`ORBIT_TEST_MCP_SECRET`).

---

## Three traps that will waste your time

**1. A stale `vite preview` server silently serves an old bundle.**
`playwright.config.ts` sets `reuseExistingServer: !process.env.CI`, so if a
preview server is already on port 5173, Playwright will NOT rebuild — it will
happily test a bundle from hours ago. This cost about an hour: several frontend
fixes were "verified" against code that was not theirs. Before any e2e run that
is meant to prove a frontend change:

```bash
lsof -ti:5173 | xargs -r kill -9
```

**2. `CONVEX_DEPLOY_KEY` must be UNSET for the CLI to work here.**
The ambient key here is rejected, so every Convex command needs
`env -u CONVEX_DEPLOY_KEY` (every `convex:*` script wraps it). Prod is `your-prod-deployment`, dev is
`your-dev-deployment`.

**3. The `netlify` CLI authenticates as the wrong account.**
It fails quietly and prints `netlify.toml`'s build environment as the site's
configuration. Use the REST API with the PAT at
`~/.config/netlify/streams-deploy-token`. Site is `your-netlify-site`,
id `your-netlify-site-id`, account slug `your-netlify-account`.

---

## Running the e2e suite

```bash
export ORBIT_TEST_MCP_SECRET=$(env -u CONVEX_DEPLOY_KEY npx convex env get MCP_SERVER_SECRET)
export E2E_CONVEX_URL=https://your-dev-deployment.eu-west-1.convex.cloud
export VITE_CONVEX_URL=$E2E_CONVEX_URL
lsof -ti:5173 | xargs -r kill -9
npx playwright test --reporter=line --retries=1
```

The suite is 20 specs. The last full run against dev: 202 passed, 2 skipped
by design, 0 failed. It writes to the **shared** dev deployment under
`fullyParallel`, so some contention is inherent: rerun a lone failure in
isolation before treating it as a regression.

Constraints that are easy to violate and expensive to discover:

- Streams, tasks, cohorts and departments **have no delete**. Fixtures must use
  fixed-name upsert, never timestamped names, or every run leaks a permanent
  row. Only users cascade-delete.
- `destroyUser` refuses stream/task authors, so author fixture content with the
  MCP token as `e2e/support/scaffold.ts` does.
- Sign-in is limited to 15 per account per 15 minutes. Never authenticate
  through the UI; use `storageStateFor(role)`.
- Force empty states with **filters**, not by deleting data.
- The scaffold uses five 20-point level tasks (task points are bounded 1..20).
  Their ids are cached in `node_modules/.cache/orbit-e2e/scaffold-tasks.json`
  because `tasks.listForUser` caps staff at 2000 rows.
- There is ONE intern fixture per run: never assert on `totalPoints`; assert
  `reviewSubmission`'s `points.awarded`.

---

## Retention sweeps — landed, do not redo

All registered in `convex/crons.ts`: `emailQueue.sweepTerminal` (terminal
`sent`/`failed` rows after 30 days, bounded pages via
`by_status_and_sent_at`/`by_status_and_failed_at`; rows predating
`sentAt`/`failedAt` are invisible to those indexes, so they are **backfilled**
with the sweep's discovery time rather than deleted, preserving the promised
month), `notifications.sweepExpired` (read: a month, unread: six) and
`auth.sweepExpired` (sessions, magic links, OAuth state, exchange codes), all
six-hourly. `auditLogs` is a deliberate permanent record — do **not** prune it.

---

## Known-open, deliberately

- **`tempPassword` is still in `convex/schema.ts`.** Convex rejects a schema
  that drops a field while documents carry it. Nothing writes it now and
  sign-in clears rows that have one; a later deploy removes the field **and**
  `convex/auth.ts`'s reader in the same commit or it will not typecheck. Take
  a `convex export --prod` and confirm a zero count first.
- **`VITE_SENTRY_DSN` is not set on Netlify**, so all monitoring work is inert.
  Worse than inert: 64 `console.error` calls now route through `logError`, so
  until a DSN exists those errors reach nothing at all, where before they at
  least reached the browser console. `./scripts/enable-sentry.sh '<dsn>'` does
  the whole job once someone creates a Sentry project. No source maps are
  uploaded either, so the first traces will be minified.
- **`admin.setIpBlock` has no caller.** `blockedIps` finally has a writer and it
  is audited, but nothing in the UI invokes it, so the block list is still empty
  in practice.
- **Accessibility is started, not finished.** There is a skip link and focus
  management on route change. Still open: ~28 `aria-label`s across the whole
  tree, icon-only buttons, no focus trapping in dialogs, and several admin forms
  whose `<label>`s are siblings with no `htmlFor` — the e2e specs work around
  those by targeting position or placeholder and each carries a note saying so.
- **`mcp-server` is typechecked but not audited.** CI covers the root only, and
  `mcp-server` is a deployed runtime with its own advisories.
- **Dev data debris**, not fixable through the current API: ~5 orphaned
  duplicate "E2E Scaffold Department" rows and 170+ orphaned `submitted`
  submissions from runs that never tore down. Departments and submissions have
  no delete. This is why `e2e/submission-review.spec.ts` is intermittent.
- **Read-cap hits are still invisible.** The 2026-08-08 scale items are closed
  (indexed, clamped reads in `notifications.list`, `tasks.listSubmissions`,
  `badges.holders` and the deletion authorship report; remaining full-table
  scans are on tables small by construction, reasoning on `INDEXED_AUTHORSHIP`
  in `convex/users.ts`). Open: logging when a cap trips is **impossible** from
  `convex/` because `@sentry/react` is browser-only, so a capped read
  truncates silently until a backend sink exists.
- **Agent-era follow-ups** (full list in `STATUS.md` (IIH-internal, not published)): held applicants are
  never told; ~756 untriaged error reports (mostly masked "Server Error" from
  expired sessions); everything depends on the Mac staying on and logged in;
  the `TaskProposalsPage` test is flaky (~1 in 3).

---

## House style, which is not optional here

Comments explain **why**, and name the specific failure being prevented. They do
not restate what the line does. Look at `convex/lib/rateLimit.ts` or
`convex/lib/intake.ts` for the register. A comment that says "sets the timeout"
is worse than no comment; one that says "below the claim lease, because a send
that outlives its claim gets resent by the next drain" is the point.

Two conventions that look like bugs and are not:

- `convex/lib/intake.ts` **truncates**; `convex/lib/input.ts` **rejects**. They
  disagree on purpose — a public applicant cannot be round-tripped through
  field-level errors cheaply, while silently slicing a member's logbook entry
  destroys work they believe they saved. Do not reconcile them.
- Role demotion deliberately does **not** revoke browser sessions, because
  `requireAdmin` re-reads roles on every call. MCP demotion *does* revoke.

**The single most important invariant:** Convex has no row-level security and
cannot have any. Authorization is entirely function-level — every public
function takes `token: v.string()` and resolves it through
`requireUser`/`requireAdmin`/`requireModerator` in `convex/lib/auth.ts`. Exactly
four of the 196 public functions intentionally skip it (enforced by
`src/test/unit/convex-authz-surface.test.ts`): `levels.infoForPoints` and
`levels.list` (public reference data — `list` declares an optional `token` it
never resolves; that argument is vestigial, not a check, so do not flag it as a
fifth anomaly), `mcp.authenticate` (runs before a token exists), and
`zoho.exchangeOAuthCode` (the exchange code is itself the credential). If a
function forgets its check, nothing else catches it.

---

## Before deploying anything

1. Re-run the checks in `docs/PROD_VERIFICATION_2026-08-11.md` (IIH-internal, not published).
2. `npm run convex:export -- --prod --include-file-storage` — the runner's
   weekly export is data-only and the admin backup panel backs nothing up.
3. Backend: `npm run convex:deploy` from this repo with `CONVEX_DEPLOY_KEY`
   unset (the old detour via a second machine is dead — a stale key in the
   mini's profile masqueraded as an auth failure). Frontend: push to GitHub,
   THEN trigger a build through the Netlify API, **not** `git push` alone
   (historical deploys carry `commit_ref: none`). A build that returns
   `error: Skipped` with no commit: retrigger once. See the `deploy-orbit`
   skill.
4. Verify by fetching the served bundle and grepping it. A green deploy has
   never been evidence that it contains what you think.
