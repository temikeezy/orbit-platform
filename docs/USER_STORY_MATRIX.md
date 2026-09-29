# ORBIT user stories, by role — and how each is verified

As of 2026-09-29, after the move to an unattended portal (see `docs/AUTOMATION_LOG.md`). Evidence types:
- **E2E**: a Playwright spec against dev. The last full run was 202 passed, 2 skipped by design, 0 failed.
- **Unit**: vitest (unit, component or integration).
- **Prod**: observed on production on 2026-09-29, by reading the resulting records.

The ORBIT Agent is listed as a role because it now does the staff work. Staff screens still exist and still work, but nothing depends on a person using them.

## Public / applicant

| Story | Evidence |
|---|---|
| Apply at `/apply` (every programme type); a bot is refused by the honeypot | E2E `application-intake` |
| Get admitted without a person deciding: screened by two models, placed in a first-choice stream, account created, acceptance email (SIWES: with letter PDF) | Prod: 14 admitted, 14 converted, 14 `application_approved` sent; placement fixed and verified. Unit `admission-rules` |
| Split or unscreened applications still admitted on a timer; a two-screener hold never is | Unit `admission-rules` |
| Sign in by password or magic link (single-use); Zoho SSO; deactivated accounts refused | E2E `auth` |
| First-steps checklist completes itself | E2E `onboarding-first-steps` |

## Intern

| Story | Evidence |
|---|---|
| See home, streams, community, leaderboard, calendar, orientation | E2E `discovery`, `smoke` |
| Find this week's tasks in every stream, written by the agent | Prod: 60 tasks across 14 streams, due 2026-10-08, one digest per intern per stream |
| Accept, submit (text, link, file), get marked, earn points, level up, earn badges | E2E `task-flow` (level-up across five approvals), `uploads`. Prod: first agent marks |
| Edit a submission until it is marked, even after the deadline; resubmit returned work after the deadline | Unit `TaskDetailPage` (3 tests). Prod bundle verified |
| Be told when work cannot be read, and why; have it settled at full points if it stays unmarkable | Prod: 7 set-asides recorded with reasons. Unit `agent-fallback`, `auto-review` |
| Work that answers the wrong task is returned, not closed at 0 | Prod: corrected case `p978e4…` |
| Logbook: draft, submit, get reviewed; weekly summary signed off; attendance | E2E `logbook`, `programme-scoping`. Agent review: dry run on prod, live from the next cycle |
| Message the ORBIT Agent and get a grounded reply | Script-level test with a realistic message and an injection attempt; live in `cycle.sh` |
| Profile, settings, notification preferences, mark notifications read | E2E `profile-and-settings` |
| Post, like, comment, stream chat, join and leave streams | E2E `stream-social` |
| Messaging with staff | E2E `messaging` |

## ORBIT Agent (the staff work)

| Story | Evidence |
|---|---|
| Mark every evidence type with two readers plus a tie-break; never score what it could not read | Prod: first live cycle. Python `test_assess` (decision and evidence rules) |
| Respond to anomalies by withdrawing low marks and setting them aside | Prod: detect returns no flags today. Code reviewed (Fable) |
| Screen and admit applicants | Prod (see above). Python `test_admit` |
| Review daily logs and sign off weeks | Prod dry run. Python `test_logbook` |
| Write and vet the week's tasks | Prod: 60 published |
| Keep the cohort calendar | Unit `cohort-rollover` (11). Prod dry run: nothing due until 2026-10-16 |
| Answer intern messages | See the intern row |
| Back up production weekly (verified) | First backup taken and verified with `unzip -t` |
| Run without anyone: launchd every 8h; Convex timers settle anything the runner misses | launchd installed; a full cycle run on 2026-09-29 |

## Supervisor (moderator), admin, super admin — still available, no longer required

| Story | Evidence |
|---|---|
| Every staff route renders for the right roles and refuses the rest | E2E `smoke` (132 tests) |
| Review submissions and filters | E2E `submission-review`, `task-flow` |
| Author, edit and approve tasks; interns refused | E2E `task-authoring` (moderator approve/decline currently self-skips once its fixture exists) |
| Supervise logbooks; see only assigned interns | E2E `logbook`, `admin-siwes` |
| Streams, gamification, levels, badges, settings, email logs | E2E `admin-console` |
| Users: create, edit, deactivate, trash, restore, reset password, export, bulk import | E2E `admin-users`, `bulk-import` |
| Admissions search and pipeline, acceptance letters | E2E `admin-search`, `acceptance-letter`, `application-intake` |
| Every public function authenticates (mechanically enforced) | Unit `convex-authz-surface` |

## Known gaps

- The two `task-authoring` tests skip themselves once their fixtures exist, so the moderator approve/decline path runs only on a fresh dev.
- The agent's own decisions cannot be e2e-tested (they need the models). They are covered by pure-rule tests, reviewed code, dry runs on prod, and the live records above.
- `TaskProposalsPage` has a pre-existing flaky test (about 1 run in 3).
- 756 untriaged error reports, mostly expired sessions surfacing as "Server Error". This is a follow-up, not a blocker.
