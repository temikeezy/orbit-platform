# ORBIT 2.0 — SIWES/Logbook Implementation Report

Implements the hybrid SIWES internship layer described in `ORBIT_2_0_REQUIREMENTS.md`:
cohorts, IIH departments, intern SIWES profiles, daily logs, weekly summaries with
sign-off, attendance for physical days, supervisor review, exports, notifications,
and admin configuration — layered on top of the existing streams/tasks/points app
without changing existing flows.

## Database (Supabase)

Three migrations (also applied to the production project):

| File | Contents |
|---|---|
| `supabase/migrations/20260722000001_create_siwes_logbook_schema.sql` | 8 new tables (`orbit_cohorts`, `orbit_departments`, `orbit_intern_profiles`, `orbit_daily_logs`, `orbit_weekly_summaries`, `orbit_attendance_records`, `orbit_supervisor_notes`, `orbit_logbook_exports`), constraints, indexes, `updated_at` triggers, RLS (deny-all for `anon`; token-helper policies for `authenticated`), notification/email type CHECK extensions (`NOT VALID`), department seeds |
| `supabase/migrations/20260722000002_create_siwes_core_functions.sql` | Token-validated SECURITY DEFINER RPCs for cohorts, departments, intern profiles, daily logs, weekly summaries, attendance + internal helpers (`orbit_siwes_require_user`, `orbit_siwes_can_review`, `orbit_siwes_notify`) with client EXECUTE revoked |
| `supabase/migrations/20260722000003_create_siwes_review_functions.sql` | Review actions (approve / request changes / reopen / sign off), private supervisor notes, review queue, My Orbit status, logbook export (with audit row), cohort compliance report, reminder fan-out |

Security model: the browser client runs as `anon` (custom JWT auth), so all SIWES
access goes through SECURITY DEFINER RPCs that validate `p_token` against
`orbit_users` and enforce role rules in-function. Direct `anon` table access is
fully denied by RLS (verified live: 0 rows on every SIWES table as `anon`; all
RPCs return `Not authenticated` for missing/invalid tokens). Interns cannot
review or sign off their own records — enforced server-side even for admins.

## Frontend

- **Types** — `src/types/database.ts`: all SIWES types + missing fields on existing types.
- **API** — `src/lib/api/`: `siwesRpc.ts` (shared caller), `cohorts.ts`, `departments.ts`, `internProfiles.ts`, `logbook.ts`, `attendance.ts`, `siwesReview.ts`.
- **Intern Logbook** — `src/pages/LogbookPage.tsx` (+ `src/components/logbook/`: `DailyLogForm`, `WeeklySummaryComposer`, `AttendanceCard`, `LogbookPrintView`, `SiwesStatusCard`). Tabs: Today / History / Weekly / Attendance / Export (print view).
- **Supervisor review** — `src/pages/ReviewDashboardPage.tsx` (+ `src/components/review/`: `ReviewActionModal`, `DailyLogDetail`, `InternDetailDrawer`) at `/review` for moderators/admins.
- **Admin** — `SiwesManagementPage` (Cohorts / Departments / Interns / Reports with CSV export and "Send reminders now") wired as a new **SIWES** tab in the admin dashboard (+ `CohortFormModal`, `DepartmentFormModal`, `InternAssignmentModal`).
- **Wiring** — `/logbook` + `/review` routes, "Logbook" nav item for interns, "Review Logbooks" menu entry for reviewers, SIWES status card on My Orbit.

## Notifications

In-app notification + queued email on: log submitted (→ reviewer), approved /
changes requested (→ intern), weekly summary submitted / signed off, daily-log
and physical-day reminders (`orbit_siwes_send_reminders`, admin-triggered from
Reports; suitable for pg_cron/scheduled invocation with an admin token).

## Tests

- `src/test/unit/siwes-api.test.ts` — envelope/token handling, payload mapping.
- `src/test/integration/siwes-role-access.test.ts` — unauthenticated/intern/supervisor/admin access surfaces.
- `src/test/integration/logbook-flow.test.ts` — draft → submit → review, weekly sign-off, attendance check-in/out.
- Repaired the previously broken test environment (Node ≥22 ships an unusable
  `localStorage` stub that shadowed jsdom's; `src/test/setup.ts` now installs a
  functional in-memory Storage shim).

## Checks

| Check | Before | After |
|---|---|---|
| `npm run typecheck` | 106 errors | **0 errors** |
| `npm test` | 128/128 failing (broken env) | **128/128 passing** |
| `npm run lint` | 24 warnings | 0 errors, 24 pre-existing `react-hooks/exhaustive-deps` warnings (unchanged) |
| `npm run build` | failing (missing Rollup native dep) | **passing** (fixed via `npm install`) |

Baseline fixes included removing dead `.auth(token)` chains (method does not
exist in supabase-js v2), aligning page-local interfaces, and correcting stray
identifiers — minimal diffs, no behavior redesign.

## Deployment status

- **Database: deployed.** All three migrations applied to the production
  Supabase project via MCP. Verified live: seeds present, anon RLS deny-all,
  RPC token gating, internal helpers not client-callable. Security advisors
  show only the pre-existing, by-design warning classes (anon-callable
  SECURITY DEFINER RPCs; GraphQL schema visibility with RLS enforced).
  Note: production policies use `get_current_user_id()` (present live);
  the repo migration files were aligned to the same helper.
- **Frontend: pending authorized deploy.** The implementation is merged to
  `main` (GitHub CI: Lint, Typecheck & Test — passing) and `npm run build`
  produces a clean production bundle. Production (`orbit2.iih.ng` — the
  deployment domain) is served by the Netlify site `your-netlify-site`. The live site did
  not deploy the ORBIT 2.0 commits automatically, so the build hook or deploy
  connection needs attention. Deploy from the authorized IIH/ORBIT Netlify
  identity by either running a production deploy of the latest `main` build or
  repairing/re-enabling GitHub auto-deploys for `main`. Do not use unrelated
  personal Netlify identities for production deployment.

## Known risks / follow-ups

- Reminder fan-out is admin-triggered; for full automation schedule it (pg_cron
  or an external scheduler) with a service credential.
- Weekly "missing logs" logic assumes Monday-Friday logging; adjust per cohort
  if weekend logging becomes expected.
- The production database schema is managed both by this repo's migration files
  and by dashboard/MCP applications; the repo files are the source of truth for
  fresh environments, but drift should be reconciled periodically.
- Positive-path RPC flows are covered by mocked tests and locked-down live
  negative tests; a staff end-to-end pass (create cohort → assign intern →
  log → review → sign off → export) is recommended after deploy.
