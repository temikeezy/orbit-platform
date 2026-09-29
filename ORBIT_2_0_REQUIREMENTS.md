# ORBIT 2.0 Requirements: Virtual-First SIWES Internship Platform

## Purpose

Reactivate ORBIT as a mostly virtual internship programme that can absorb more SIWES and non-SIWES interns into the IIH community while still supporting a light, IIH-assigned in-person participation model for Ilorin-based participants.

The platform should preserve the current ORBIT strengths: streams, tasks, submissions, points, badges, leaderboard, activity feed, messages, admin tooling, and onboarding. ORBIT 2.0 adds the missing SIWES operations layer: public application intake, passport/SIWES-letter uploads, intern records, daily logs, weekly summaries, supervisor review/sign-off, attendance for assigned in-person days, department shadowing, and exportable logbook evidence.

## Current State

The existing app already includes:

- Custom authentication and role-based access for admin, moderator, and intern users.
- Stream membership and task assignment.
- Email queueing and in-platform notifications.
- Task acceptance, submission, review, feedback, scoring, and points.
- Badges, levels, leaderboard, activity feed, messages, notifications, and admin screens.
- Orientation/manual content for interns.
- Bulk import and user-management tooling.

Before the ORBIT 2.0 SIWES implementation, the app did not include:

- Public SIWES/internship application intake.
- SIWES-specific intern profile fields.
- Passport photograph and SIWES form/letter upload.
- Daily work/learning logs.
- Weekly logbook summaries and sign-off.
- IIH department assignment or shadowing schedule.
- Attendance/check-in for once-weekly IIH-assigned in-person participation.
- Institution-ready logbook export/print views.
- Supervisor dashboards for pending log reviews and sign-off.

## Programme Model

ORBIT 2.0 should support an IIH-assigned participation policy:

- Virtual: participants outside Ilorin learn, complete stream tasks, attend online sessions, and submit daily/weekly logbook records remotely.
- Hybrid: Ilorin-based participants may be assigned by IIH to attend one fixed in-person day per week at IIH, currently Monday, while completing most learning and documentation virtually.

Applicants do not choose virtual, hybrid, or physical participation themselves, and there is no applicant-selectable physical option. Interns should be able to learn across the available ORBIT streams. The existing stream/task model should remain the learning backbone, while SIWES tracking is added as a programme layer around it.

## Roles

- Intern: completes profile, joins/participates in streams, accepts/submits tasks, records daily logs, submits weekly summaries, views supervisor feedback, exports logbook records.
- Supervisor/Moderator: reviews logs for assigned interns, requests corrections, signs off weekly summaries, monitors attendance and task progress.
- Department Lead: optional reviewer for physical shadowing activities in an IIH department. This can use the moderator role initially unless a new role is needed later.
- Admin/Super Admin: configures cohorts, departments, supervisors, physical days, logbook requirements, exports, and reporting.

## Functional Requirements

### 1. Cohorts

Create a cohort model so ORBIT can run multiple internship batches over time.

Required fields:

- Name, e.g. "ORBIT 2.0 SIWES 2026".
- Start date and end date.
- Status: draft, active, completed, archived.
- Default participation mode.
- Default physical day of week.
- Logbook cadence settings: daily logs required, weekly summary required, sign-off required.

Admins should be able to assign interns to a cohort and filter dashboards by cohort.

### 2. Intern SIWES Profile

Add SIWES/internship details without overloading the main user profile.

Required fields:

- User ID.
- Cohort ID.
- IIH-assigned participation policy: virtual or hybrid.
- Institution name.
- Faculty/college.
- Course/department.
- Matriculation number.
- SIWES start date and end date.
- Institution supervisor name, email, and phone.
- IIH supervisor ID.
- IIH department ID, optional for virtual interns and required for physical department shadowing.
- Emergency contact name and phone.
- Status: pending, active, paused, completed, withdrawn.
- Passport photograph URL/path.
- SIWES form, posting letter, placement letter, or introductory letter URL/path.

The main profile page should show a concise SIWES status panel when a user has an active internship profile.

### 3. IIH Departments

Add departments for physical shadowing and internal assignment.

Suggested departments:

- Programmes.
- Operations/Admin.
- Community/Events.
- Facility/Front Desk.
- Partnerships/Communications.
- Technical/Product.
- Media/Content.
- Other.

Admins should be able to create/edit departments and assign department leads.

### 4. Daily Logbook Entries

Interns need a daily record that can later be used to complete university logbooks.

Required fields:

- Intern profile ID.
- Date.
- Participation mode for the day: virtual or physical.
- Stream ID, optional.
- Department ID, optional.
- Task/submission ID, optional.
- Title/summary.
- Work done.
- What I learned.
- Tools/resources used.
- Challenges/blockers.
- Next steps.
- Hours spent.
- Evidence links.
- Attachment URL, optional.
- Status: draft, submitted, changes_requested, approved.
- Reviewed by, reviewed at, supervisor comments.

Rules:

- One submitted daily log per intern per date.
- Interns can save drafts.
- Submitted/approved entries should retain audit timestamps.
- Supervisors/admins can request changes with comments.
- Approved entries should be locked from casual edits unless reopened by a reviewer.

### 5. Weekly Summaries

Interns should submit a weekly summary that supervisors can sign off.

Required fields:

- Intern profile ID.
- Week start and week end.
- Goals for the week.
- Summary of work done.
- Key learning outcomes.
- Links to daily logs included in the week.
- Supervisor comment.
- Status: draft, submitted, changes_requested, signed_off.
- Signed off by and signed off at.

Useful behaviour:

- Auto-suggest a weekly summary from the submitted daily logs.
- Show missing daily logs before weekly submission.
- Allow supervisors to sign off the week or request corrections.

### 6. Attendance and Physical Day Tracking

For Ilorin-based hybrid interns, track the minimal once-weekly in-person participation assigned by IIH.

Required fields:

- Intern profile ID.
- Date.
- Expected mode: physical or virtual.
- Check-in time.
- Check-out time.
- Department ID.
- Activity/assignment summary.
- Verified by.
- Status: expected, present, absent, excused, remote_makeup.

Admins should be able to generate a weekly attendance view and identify missed physical days.

### 7. Supervisor Review Dashboard

Moderators/supervisors need a focused review surface.

Required views:

- Assigned interns.
- Pending daily logs.
- Weekly summaries awaiting sign-off.
- Missing daily logs for the current week.
- Attendance exceptions.
- Intern progress summary: stream tasks, approved submissions, logbook completion, weekly sign-offs.

Review actions:

- Approve daily log.
- Request changes on daily log.
- Sign off weekly summary.
- Request changes on weekly summary.
- Add private/internal supervisor notes visible only to reviewers/admins.

### 8. Intern Logbook UI

Add a Logbook area for interns.

Suggested placement:

- Add "Logbook" to main navigation for interns.
- Add a compact logbook summary to "My Orbit".

Required intern views:

- Today entry: create/update today's log.
- Calendar/list of daily logs.
- Weekly summary composer.
- Supervisor feedback and correction requests.
- Export/print logbook records.

### 9. Admin Configuration and Reporting

Admins should be able to:

- Manage cohorts.
- Manage IIH departments.
- Assign interns to cohorts, supervisors, departments, and participation modes.
- Bulk import SIWES fields when onboarding interns.
- View logbook compliance by cohort.
- Export daily logs, weekly summaries, attendance, and supervisor sign-offs.

Reports should support:

- PDF/print-friendly intern logbook.
- CSV export for admin tracking.
- Date range and cohort filters.

### 10. Weekly Task Agent

Add an ORBIT task-setting agent that helps programme staff prepare and deploy weekly task plans.

Required behaviour:

- Draft weekly task plans by cohort, stream, and track.
- Use reusable templates for recurring tasks such as weekly reflection, portfolio update, programme documentation, research brief, product testing, community assignment, and SIWES logbook compliance.
- Require staff approval before publishing tasks.
- Create approved tasks in `orbit_tasks` with title, description, submission type, point value, deadline, and assigned stream.
- Queue email alerts and create in-platform notifications when tasks are published.
- Maintain an audit trail for generated plan, approving staff member, deployment time, and deployed task IDs.
- Escalate missed deadlines, repeated missed logs, pending reviews, and missed Monday attendance to supervisors/admins.

The first production version can use deterministic templates and staff approval. Generative AI can be added later for drafting task copy, but task publication must remain under IIH control.

### 11. Notifications

Extend notifications for:

- Weekly task plan published.
- New task assigned.
- Daily log reminder.
- Weekly summary reminder.
- Supervisor review pending.
- Changes requested.
- Weekly summary signed off.
- Monday in-person attendance reminder.
- Missed attendance alert.

Reuse the existing notification/email queue patterns where possible.

## Data Model Proposal

Add these tables through Supabase migrations:

- `orbit_cohorts`
- `orbit_departments`
- `orbit_intern_profiles`
- `orbit_daily_logs`
- `orbit_weekly_summaries`
- `orbit_attendance_records`
- `orbit_supervisor_notes`
- `orbit_logbook_exports`, optional audit/history table

Extend TypeScript database types for each table and add API modules rather than embedding all Supabase calls inside page components.

Use strict RLS:

- Interns can read/write their own draft or submitted logs.
- Interns cannot approve or sign off their own logs.
- Supervisors/moderators can review assigned interns only.
- Admins/super admins can manage all internship records.
- Public/anonymous users should have no access to SIWES/logbook records.

## Implementation Plan

1. Add database migrations, RLS policies, indexes, and seed/demo data.
2. Add TypeScript types and API helpers for cohorts, departments, intern profiles, logs, summaries, attendance, and reviews.
3. Build intern Logbook UI and add My Orbit summary widgets.
4. Build supervisor review dashboard.
5. Extend admin screens for cohort, department, assignment, and reporting management.
6. Add notifications/reminders using the existing notification/email infrastructure.
7. Add a weekly task-agent workflow for drafting, approving, publishing, and notifying participants about weekly tasks.
8. Add export/print views for institution logbook submission.
9. Add unit/integration tests for API helpers, role access, log submission, review, sign-off, alerts, and export flows.
10. Run typecheck, lint, tests, build, and production readiness review.

## Acceptance Criteria

- Admin can create an ORBIT 2.0 cohort and assign interns to the correct IIH-defined virtual or hybrid policy.
- Admin can assign an Ilorin-based hybrid intern to an IIH department and supervisor where shadowing is required.
- Admin or programme staff can approve weekly task plans and deploy tasks to the app with email and in-platform notifications.
- Intern can create daily logs, save drafts, submit logs, and see review status.
- Intern can create weekly summaries based on daily logs.
- Supervisor can approve daily logs, request changes, and sign off weekly summaries.
- Hybrid/physical attendance can be recorded and reported.
- Admin can see missing logs, pending reviews, attendance exceptions, and completion status by cohort.
- Intern can export or print daily/weekly records for university SIWES logbook support.
- Existing streams, tasks, submissions, points, badges, leaderboard, messages, and orientation continue to work.
- RLS prevents interns from accessing other interns' SIWES/logbook records.
- User-facing copy does not expose local filesystem paths or machine/workspace details.

## Production Readiness Checklist

- TypeScript typecheck passes.
- Lint passes or remaining warnings are documented.
- Unit and integration tests pass.
- Production build passes.
- Supabase migrations are idempotent and ordered after existing migrations.
- RLS policies are verified for intern, moderator, admin, and unauthenticated access.
- Export/print output is readable on desktop and mobile.
- Mobile layout is checked for Logbook, Review, and Admin pages.
- Existing auth/session behaviour remains intact.
- Existing task submission/review flow remains intact.
- Deployment configuration is inspected before deploying.
- Deployment is attempted only after checks pass and required environment variables/configuration are available.
