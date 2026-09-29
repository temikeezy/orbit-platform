# ORBIT Platform Changes for the Updated ORBIT 2.0 Concept Note

**Prepared:** 5 August 2026  
**Target:** ORBIT application in `/path/to/orbit`  
**Basis:** Review of the updated concept note and the current Convex/React codebase

## Executive summary

The current platform already implements much of the required foundation: public applications, document uploads, application review and conversion, cohorts, departments, intern profiles, daily logs, weekly summaries, attendance, supervisor review, exports, tasks, submissions, points, badges, and overall/monthly/weekly leaderboards.

The updated concept note does **not** require a rebuild. It requires a focused release that turns existing features into a tightly enforced Cohort 1 operating model. The most important work is programme configuration and enforcement, track-to-department ownership, the staff-approved weekly task workflow, workload/compliance reporting, and the public call-for-application/weekly-Astronaut-leaderboard experience.

## Current fit against the concept

| Concept requirement | Current platform state | Change needed |
|---|---|---|
| Public application at `/apply` | Implemented with applicant details, location-derived mode, passport photo, SIWES letter, and admin review. | Align programme types and admissions policy; add cohort window/cap messaging. |
| IIH assigns mode | Implemented by deriving Ilorin → hybrid/Monday and other locations → virtual. | Keep the derived recommendation, but make final mode an explicit staff decision during review and audit any override. |
| Cohort cap of 30 | Cohorts exist, but no capacity field or hard acceptance guard is present. | Add capacity, accepted-count display, waitlist state, and server-side enforcement. |
| One participant in one stream | User has a current stream, but historical/active memberships can coexist. | Enforce at most one active learning-stream membership per Cohort 1 participant. |
| Tracks group platform streams | Application track interests exist as strings; streams have no first-class track or owning department. | Add track records or a controlled track enum and map every stream to one track, department, lead, and backup. |
| Named supervisor | Intern profiles support an IIH supervisor. | Require supervisor before activation; add assignment coverage and capacity warnings. |
| Monday kickoff/attendance | Physical day and attendance exist. | Default Cohort 1 to Monday, generate expected attendance, handle public holidays/excused/makeup cases, and alert on exceptions. |
| Daily logs | Implemented with structured fields and review states. | Configure exact required weekdays and reminder deadlines; ensure approved entries are locked/reopenable. |
| Weekly deliverable and summary | Tasks/submissions and weekly summaries exist. | Resolve Thursday vs Friday first, then enforce a cohort submission cutoff and show completeness before submission. |
| Staff review before next week | Review dashboard exists. | Add due-by-Sunday queue, ageing, workload, and escalation indicators. |
| ORBIT Agent drafts plans | General MCP/automation support exists, but no complete weekly plan entity/approval/deployment workflow was found. | Build draft → approve → publish → notify → audit workflow; never auto-approve. |
| Zeptomail alerts | Email/notification infrastructure exists. | Add scheduled task/log/review/attendance alerts and visible delivery status. |
| Monitoring metrics | Compliance reporting exists. | Add the complete Section 12 dashboard and monthly report pack. |
| Four progression levels | Levels/points/badges exist. | Confirm names and thresholds match Orbit Entry, Active Orbit, Event Orbit, and Orbit Stars. |
| Weekly Astronaut leaderboard | Weekly filtering exists for authenticated users. | Rename/copy-align, make weekly the programme emphasis, filter to active cohort participants, and create a privacy-safe public/design surface if approved. |
| Certificates and final evidence | Logbook export exists. | Add completion decision, final report/presentation record, certificate register, recommendation eligibility, and SIWES completion pack. |

## Priority 0 — policy decisions before coding

These decisions change application behaviour and deadline logic:

1. Choose Thursday or Friday as the weekly submission deadline; remove “weekend submission” ambiguity.
2. Confirm application close, selection, acceptance, onboarding, and go-live dates.
3. Confirm the Programme Lead and every active stream lead/backup.
4. Decide whether Engineering/Special Projects is inactive until its owner is confirmed.
5. Approve completion, certificate, recommendation, inactivity, and withdrawal thresholds.
6. Confirm whether a weekly public leaderboard may show names/photos or should require opt-in/anonymisation.

## Priority 1 — Cohort 1 launch blockers

### A. Cohort capacity and admissions control

Add to the cohort model:

- `capacity` (30 for Cohort 1)
- application open/close timestamps
- acceptance deadline and onboarding status
- submission weekday/timezone/cutoff
- required logging weekdays
- cohort display/publication status

Update application review so accepting or converting an applicant cannot exceed capacity. Add `waitlisted` as an application outcome, show accepted/remaining places, and make all capacity checks server-side to avoid concurrent over-acceptance.

### B. Admissions-policy alignment

Change the public programme choices from `SIWES / Internship / NYSC / Volunteer` to:

- SIWES
- Internship

For internship applications, add an optional “currently serving through NYSC” flag and mandatory acknowledgement that ORBIT is a secondary learning track, not a PPA or substitute for national service. Add an admin review flag for these applicants. Existing embedded IIH interns/corps members should be marked ineligible or excluded before conversion.

Keep location-derived mode as a recommendation. During review, staff should explicitly confirm `virtual` or `hybrid`, with a reason captured when overriding the recommendation.

### C. Track, stream, department, and lead ownership

Model the seven concept-note tracks and map each active stream to:

- owning track
- owning IIH department/unit
- primary lead
- backup reviewer
- participant capacity
- Cohort 1 active/inactive state

Prevent publication/assignment when the ownership fields are incomplete. Enforce one active stream per participant while retaining membership history. Provide an assignment matrix showing uncovered participants, overloaded leads, and unowned streams.

### D. Canonical weekly rhythm

Once the deadline decision is made, encode it in cohort settings and use it everywhere:

- Monday kickoff/task publication
- daily-log reminders Tuesday–Thursday (or the approved weekdays)
- weekly deliverable and summary cutoff
- supervisor review deadline before the next Monday
- late/missing/changes-requested states

Show a participant-facing “This week in ORBIT” card with the current task, daily-log progress, weekly-summary status, attendance requirement, submission deadline, and reviewer feedback.

### E. Production readiness

Before publishing the call for applications, execute the complete production smoke test with staff roles and test data. Verify application uploads, conversion, cohort assignment, stream assignment, task submission, log review, sign-off, attendance, email delivery, export, and leaderboard visibility. Confirm the live build is tied to the current Convex implementation and update stale Supabase-era documentation.

## Priority 2 — core programme operations

### A. Weekly Task Plan / ORBIT Agent workflow

Add first-class records for weekly plans and plan items. Suggested states:

`draft → awaiting_approval → approved → publishing → published` with `rejected` and `cancelled` terminal paths.

Each plan should record cohort, week, track, stream, task copy, submission type, points, deadline, source template, agent draft metadata, approving staff member/time, published task IDs, notification results, and full audit history.

The ORBIT Agent may:

- draft from approved templates
- identify missing plans and compliance exceptions
- prepare reminders and weekly roundups

Only authorised staff may approve, publish, reject participant work, award final completion, or issue recognition.

### B. Supervisor workbench and escalation

Enhance the current review dashboard with:

- reviews due before Monday
- age of pending submission
- missing daily logs and summaries
- changes requested but not resubmitted
- Monday attendance exceptions
- participant inactivity risk
- per-lead assigned count and outstanding-review load
- escalation owner and resolution status

Add a weekly lead roundup and a programme-level exception digest for HR and the Programme Lead.

### C. Section 12 management dashboard

Add cohort-filtered metrics for:

- active participants and SIWES count
- track and stream distribution
- virtual/hybrid split
- daily-log completion rate
- weekly supervisor sign-off rate and median review time
- Monday attendance/punctuality
- task submission and approval rate
- at-risk/inactive participants
- open tasks with zero submissions
- certificates/completion records issued
- participant and supervisor feedback
- supervisor workload

Support a downloadable monthly management pack and store snapshots so historical reports do not change when live data changes.

### D. Completion and recognition

Add a closeout workflow containing final report/portfolio/presentation, conduct/attendance/log/task checks, supervisor recommendation, completion decision, certificate number/date, recommendation-letter eligibility, SIWES document status, and public-spotlight consent. Completion must be based on supervised evidence, not points or leaderboard rank.

## Priority 3 — design and engagement

### A. Call for applications

Create a clear public programme entry experience (or public landing section) with:

- Cohort 1 dates and 30-place cap
- eligibility and exclusions
- virtual-first/Monday policy
- tracks currently open
- application deadline and status
- what applicants need to upload
- NYSC disclaimer
- prominent Apply CTA to `/apply`

The call should automatically show `open`, `closing soon`, `closed`, or `cohort full/waitlist` from cohort configuration rather than hard-coded copy.

### B. Weekly Astronaut leaderboard

Make the weekly view the primary Cohort 1 leaderboard and use the concept’s “Astronaut” terminology. Restrict rankings to active Cohort 1 participants and approved, auditable points. Show the week range, stream/track filters where helpful, position movement, and the viewer’s own standing.

For any public version, require explicit leaderboard visibility consent. Avoid exposing email, institution, SIWES status, attendance, or performance details. Consider first name + surname initial and avatar opt-in if public visibility is not already covered by consent.

### C. Participant clarity

Update onboarding and in-product copy so “hybrid” is explained as virtual-first with required Monday attendance for Ilorin-based participants. Use consistent terms for participant (`Astronaut` as engagement language; `participant/intern` in official records), stream, track, department, task, deliverable, daily log, weekly summary, and sign-off.

## Data and security changes

- Keep passport photos, SIWES letters, institution supervisor data, and emergency contacts out of public user and leaderboard queries.
- Define retention/deletion rules for rejected, withdrawn, and completed applicants.
- Audit application review, mode override, cohort/stream/supervisor assignment, task-plan approval, log reopening, completion decisions, certificate issuance, and exports.
- Use least-privilege reviewer access based on assignment, with admin override recorded.
- Add consent version/timestamp for data processing and any public spotlight/leaderboard use.
- Ensure uploaded evidence and exports use authenticated, expiring access rather than permanent public URLs.

## Documentation updates in the app repo

The repository documentation currently mixes the former Supabase architecture with the current Convex implementation and contains completed items as future work. After implementation:

- update `README.md` architecture, setup, storage, auth, email, and deployment sections for Convex
- update `STATUS.md` (IIH-internal, not published) with the current production state
- remove completed application-conversion work from `ROADMAP.md`
- update `ORBIT_2_0_REQUIREMENTS.md` to match the approved concept-note policy and canonical submission day
- add the updated concept note as a programme source document or link it from `DOCS_INDEX.md`
- record the platform delivery plan in the durable roadmap rather than leaving this review as the only source

## Acceptance criteria for Cohort 1

- The platform cannot accept more than 30 Cohort 1 participants; overflow can be waitlisted.
- Every active participant has exactly one active stream, one confirmed mode, and one named supervisor.
- Every active stream has a track, owning department, primary lead, backup reviewer, and capacity.
- Ilorin-based participants are assigned Monday attendance; outside-Ilorin participants are virtual unless staff records an approved exception.
- Weekly tasks are drafted, staff-approved, published, notified, and audited.
- Daily logs, weekly summaries, deliverables, review deadlines, and reminders follow one approved weekly schedule.
- HR and the Programme Lead can see every Section 12 metric and export a monthly snapshot.
- Reviewers can see workload and exceptions and complete sign-off before the next week.
- Completion/certification uses supervised evidence and records the decision.
- The public application experience and weekly Astronaut leaderboard respect cohort state, capacity, and privacy.
- A full staff-led production test passes before the call for applications is promoted.

## Recommended delivery order

1. Close policy decisions and configure dates/owners.
2. Add capacity enforcement and align admissions categories.
3. Add track/stream/department ownership and one-stream enforcement.
4. Encode the weekly rhythm and participant/reviewer dashboards.
5. Build weekly task-plan approval/publishing and scheduled alerts.
6. Complete management reporting and closeout/certification.
7. Deliver the call-for-application and weekly Astronaut leaderboard design updates.
8. Run production QA, staff training, and a go/no-go review.
