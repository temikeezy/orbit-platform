# ORBIT Product Requirements Document

## 1. Product Overview

### 1.1 Purpose

Build a single platform that manages ORBIT programme operations: onboarding, stream assignment, tasks, submissions, scoring, SIWES/internship records, supervisor review, attendance, community engagement, and communications.

### 1.2 Core Value

Reduce administrative overhead and eliminate fragmented trackers. Enable structured learning, accountability, SIWES logbook evidence, supervisor sign-off, and community engagement.

### 1.3 Users

- Programme Admin

- Stream Lead / Moderator

- Intern / SIWES Student / Volunteer

## 2. Core Modules

- Authentication and access control

- User profiles and social layer

- Streams and membership management

- Tasks and submissions

- Weekly task agent and task-template workflow

- Leaderboard and gamification

- Messaging and activity feed

- Notifications and email automation

- Admin dashboard and bulk importer

- Public application intake, passport/SIWES-letter uploads, SIWES cohorts, departments, intern profiles, daily logs, weekly summaries, attendance, supervisor sign-off, reports, and exports

## 3. Authentication and Access Control

### 3.1 Login

Primary login via Zoho Single Sign On using organization email.

Passwordless email fallback for non-Zoho users where permitted.

### 3.2 Roles and Permissions

Admin: full system control across streams, tasks, users.

Stream Lead: manage tasks and submissions within assigned stream.

Member: participate in assigned stream and complete tasks.

Supervisor/Reviewer: review SIWES logs, attendance exceptions, and weekly summaries for assigned interns.

### 3.3 Stream Exclusivity

A user cannot be part of more than one stream at the same time.

Attempt to join another stream requires removal from the current one by Admin only.

4. User Profiles and Social Layer
4.1 Profiles

Display photo, profile fields, bio, and stream membership.

Show progress: points, badges, levels, completed tasks.

4.2 Social Features

Activity feed where users can post updates, images, links, and polls.

Commenting and reactions.

Add as friend or follow.

Stream-specific feed that shows stream-only discussions.

5. Streams and Membership
5.1 Streams

Each stream has: name, description, moderators, task board, leaderboard.

Stream visibility: members see only their assigned stream.

5.2 Stream Membership Rules

One user per one stream, enforced by validation.

Switching streams requires admin approval and action.

5.3 Bulk Importer (replacement for ORBIT Importer plugin)

Admin uploads a spreadsheet with:

Full name

Email

Assigned stream

The system:

Creates accounts automatically (if they don’t exist)

Assigns stream membership

Sends onboarding email with magic login link

6. Tasks, Deadlines, and Submissions
6.1 Task Creation

Admin or Stream Lead can create tasks.

Task configuration includes title, description, submission type, point value, and deadline.

Task creation and assignment must be refused until the programme commences, with the
refusal naming the programme start date. Because tasks belong to streams rather than
cohorts, the programme clock is the active cohort with the latest start date, breaking a
tie with the newest record. Resolving per member would give one stream conflicting start
dates and cadences for the same task.

Unless the lead chooses another deadline, a new task uses the current cohort cadence's
weekly deliverable deadline: Thursday by default. It uses the current programme week
while meaningful working time remains, then the next week's deadline once the configured
due hour begins. A default that is already past or leaves only minutes to work merely
shifts deadline selection back onto the lead.

6.1.1 Weekly Task Agent

ORBIT should support a weekly task-setting agent that prepares draft task plans for each cohort, stream, and track. The agent should use admin-approved templates and cohort calendars to propose tasks, deadlines, points, submission types, and expected deliverables.

The agent must operate in staff-approved mode by default: it creates pending task proposals
that remain invisible and unassigned until a Programme Lead, Admin, or Stream Lead approves
them, or the configured approval-window sweep publishes them. Publication queues the email
alerts and in-platform notifications and records the approver or automatic publication in
the audit trail; neither path may publish before programme commencement.

The 48-hour proposal auto-publish window is an approval safety valve, not the time
participants receive to complete a task. It cannot publish a proposal before programme
commencement, and agent-created tasks use the same cadence-derived deadline default as
lead-created tasks.

6.2 Submission

Supported formats: text, link, file upload.

Member can edit until the deadline.

Submission auto timestamps.

6.3 Review and Scoring

Moderator approves, requests change, or rejects.

Points automatically accumulate toward leaderboard and levels.

Feedback visible to member.

7. Leaderboards and Gamification
7.1 Leaderboards

Visible globally and per stream.

Sorting and filters: weekly, all time.

7.2 Gamification

Levels unlock based on cumulative points.

Badges awarded for streaks, quality scores, or consistency.

Auto progress bar on profile.

8. Messaging and Notifications
8.1 Messaging

Direct messaging between users.

Stream chat channel.

Admin broadcast or announcement channel.

8.2 Notifications

In app.

Email automation.

8.3 Required Email Notifications

Onboarding email after bulk import or self registration.

New task created.

Weekly task plan published.

Deadline reminder 48 hours before due date. This is notification lead time, not task
duration; for the default Thursday cadence it arrives around Tuesday's close, leaving
Wednesday and Thursday to act.

Submission confirmation.

Task scored and points awarded.

SIWES daily log reminder, missing log alert, weekly summary reminder, correction request, sign-off, and Monday in-person attendance reminder for Ilorin-based interns.

9. Admin Dashboard
9.1 Stream Management

Create, update, or archive streams.

Assign or change stream leads.

Move a member between streams.

9.2 Bulk User Importer

Upload spreadsheet.

Preview and validate.

Confirm import triggers welcome emails.

9.3 System Reporting

Submissions per stream per week.

Points and participation health.

Export to CSV.

## 10. SIWES / ORBIT 2.0 Requirements

### 10.1 Internship Model

ORBIT 2.0 supports a mostly virtual internship/SIWES model. Participants outside Ilorin participate virtually. Ilorin-based participants may be assigned by IIH to hybrid participation with one fixed in-person day per week, currently Monday. Applicants do not choose virtual, hybrid, or physical participation themselves, and there is no applicant-selectable physical option.

### 10.2 Intern Records

Each SIWES intern profile should capture institution, course, matric number, SIWES dates, cohort, IIH-assigned participation policy, department assignment where applicable, supervisor, physical day where applicable, passport photograph, SIWES form or placement letter, and status.

### 10.3 Daily and Weekly Logbook

Interns must be able to record daily learning/work done, tools used, challenges, hours, next steps, and supervisor comments. Weekly summaries must support supervisor sign-off and export/print use for university logbook evidence.

### 10.4 Review and Reporting

Supervisors/admins need queues for submitted logs, pending sign-offs, missing logs, attendance exceptions, private notes, compliance reports, CSV export, and reminder fan-out.

## 11. Technical Foundation

Web app first; mobile responsive; later convert to PWA.

React or Next.js frontend.

Supabase or Firebase backend with real time features.

Authentication via Zoho OAuth.

## 12. Success Criteria

Reduce admin work from weekly manual tracking to zero.

At least 90 percent of members submit tasks on time.

Weekly stream leads approve 95 percent of submissions within 48 hours.

SIWES interns can generate daily/weekly records suitable for their university logbooks.

Supervisors can review/sign off submitted SIWES records within 48 hours.
