# ORBIT Roadmap

Last updated: 29 September 2026.

## Shipped

- **Foundation:** auth and roles, admin dashboard, streams, tasks, submissions, review, points, levels, badges, leaderboard, feed, messaging, notifications, email queue, bulk import.
- **ORBIT 2.0 SIWES and logbook:** cohorts, departments, tracks, intern profiles, daily logs, weekly summaries, attendance, supervisor review, exports, reports, reminders (including the daily SIWES logbook reminder cron).
- **Applications:** public intake with passport photo and SIWES form upload, review queue, and conversion of approved applicants to accounts.
- **Task programme rules:** nothing created or assigned before the programme starts; cadence-derived deadline default; task points bounded 1 to 20.
- **The portal runs itself (2026-09-29).** No person operates it; staff roles and screens remain and a person acting first wins. The runner on the agent's Mac (`scripts/agent/cycle.sh`, every 8 hours) makes the model calls, and Convex crons hold every rule, timer and fallback:
  - marking by two independent models with a tie-break, and a settle-by-timeout fallback for work that cannot be marked;
  - admissions screening and admission on a fixed timetable, placing interns by least-loaded first choice;
  - daily-log review, and weekly summary sign-off;
  - fresh weekly tasks written per stream, vetted by a second model, priced by complexity, with the fixed bank as a Saturday fallback;
  - an agent helpdesk answering intern messages;
  - cohort rollover, and a weekly verified data backup.

  Design, reviews and verification: `docs/AUTOMATION_LOG.md`; per-role evidence: `docs/USER_STORY_MATRIX.md`.
- **Work editing:** interns can edit submitted-not-marked work, and resubmit returned work after the deadline.
- **Manuals:** one per role, published from `npm run manual:publish` and shown on `/orientation`.
- **Test coverage:** 20 Playwright specs (last full run against dev: 202 passed, 2 skipped by design) and 75 vitest files.

## Follow-ups, in priority order

1. **Single point of failure.** Model work depends on the Mac staying on and logged in to both subscriptions. The fallbacks keep the portal moving but at lower quality (timeouts settle marks at full points, unscreened applicants admit after 7 days). Add an external liveness alert on the `UNHEALTHY` and `BACKUP_FAILED` flags, and free disk (about 92% full).
2. **Held applicants are never told.** A two-screener `hold` is never admitted and never notified. Decide what they hear and when.
3. **Triage the error reports.** About 756 are untriaged, mostly a masked "Server Error" from expired sessions. Distinguish expiry from real faults, and give expiry a clear message and re-sign-in.
4. **Quality badge.** Its 80-or-above threshold predates the 1 to 20 scale and is unreachable for scored work; see `docs/TASK_PROGRAMME.md` (IIH-internal, not published).
5. **Event Orbit gate.** The Event Stream setting is stored but nothing enforces level 3 access; see `LEVELS_SYSTEM.md`.
6. **Flaky test.** `TaskProposalsPage` fails roughly one run in three.
7. **Validation with real data.** Check CSV and logbook exports against a real university SIWES logbook expectation, and confirm the department-shadowing workflow with IIH operations.
8. **Confirm cohort data** as each cohort rolls over: dates, supervisors, department contacts, Ilorin Monday attendance capacity.

## Open source and ORBIT Cloud

ORBIT is open source under the **AGPL-3.0** (2026). Any organisation can download, run and modify it for free; [SELF_HOSTING.md](SELF_HOSTING.md) covers installation. Anyone who runs a modified ORBIT as a service for others must publish their changes under the same licence.

**Planned: ORBIT Cloud, a paid hosted edition run by Ilorin Innovation Hub**, for organisations that want ORBIT without operating it. Direction, not a commitment:

- Hosting, upgrades, backups and monitoring handled for you.
- The automated agent (marking, admissions screening, logbook review, weekly tasks, helpdesk) run as a managed service, with no machine of your own to keep online.
- Multi-organisation tenancy, per-organisation branding, timezone and programme configuration.
- Support and onboarding.

The open-source core stays complete and self-hostable: ORBIT Cloud adds operations and convenience, not features withheld from the AGPL edition. Contributions are accepted on terms that let IIH include them in the paid edition (see [CONTRIBUTING.md](CONTRIBUTING.md#licensing-of-contributions)).

**Adoption work that serves both editions:** configurable timezone (currently fixed to WAT), tracks and programme types managed from the admin screens rather than code, translations, pluggable mail and SSO providers beyond ZeptoMail and Zoho, and an installer that replaces the manual steps in SELF_HOSTING.md.

## Later

- Mobile table and card views for admin SIWES reports and review queues.
- Configurable notification preferences and delivery logs for tasks, deadlines, SIWES, attendance and review alerts. The 48-hour deadline reminder is independent of task duration.
- Configurable weekend and holiday logging expectations per cohort.
- Dashboard analytics: cohort health, late logs, sign-off speed, attendance exceptions, workload.
- Automated monthly management report packs.
- Community affordances: cohort groups, role badges, stream presence, recognition moments.
- A focused pass on remaining lint warnings.
