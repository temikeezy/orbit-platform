import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

/**
 * Replaces the four Netlify scheduled functions.
 *
 * Without this file the Convex port had no scheduled work at all: queued
 * magic-link emails were written and never sent (the request returned its
 * generic success message, so the failure was completely silent), and expired
 * sessions, magic links and OAuth state accumulated forever.
 */
const crons = cronJobs();

// Was an hourly Netlify function that curled process-email-queue. Runs more
// often here because it is now a direct call with no cold start — a magic link
// that takes an hour to arrive is a magic link nobody uses.
crons.interval('process email queue', { minutes: 2 }, internal.email.processQueue, {});

// Terminal rows keep full email bodies, so leaving them forever makes both the
// admin log and permanent user deletion grow towards Convex's transaction
// limits. The mutation retains a month and takes bounded pages; a six-hour
// cadence lets a backlog drain over several safe transactions.
crons.interval('sweep terminal email queue', { hours: 6 }, internal.emailQueue.sweepTerminal, {});

/**
 * Empties the queue on a deployment that must never send it.
 *
 * A no-op unless `EMAIL_SINK=1`, which production does not set and is not asked
 * to. Hourly rather than daily so a dev backlog stays small enough that nobody
 * is tempted to reach for the allowlist to clear it.
 */
crons.hourly(
  'purge sink email queue',
  { minuteUTC: 40 },
  internal.emailQueue.purgeSink,
  {},
);

// Notifications are an inbox, not an audit record. Read rows retain a month;
// unread rows retain six months, and the mutation drains both in bounded pages.
crons.interval('sweep expired notifications', { hours: 6 }, internal.notifications.sweepExpired, {});

// sessions / magicLinks / oauthStateTokens / oauthExchangeCodes.
crons.interval('sweep expired auth rows', { hours: 6 }, internal.auth.sweepExpired, {});

// Retries applications that failed to reach the Google Sheet. The action is a
// no-op when the deployment is not wired to a sheet, and when nothing is
// outstanding — so this is cheap on every deployment that does not use it.
/**
 * REMOVED: ORBIT -> Google Sheet mirror.
 *
 * The spreadsheet is disconnected. Its readback half was already removed for
 * being an unattributable approval path; this is the other half, and with
 * nothing reading the sheet there is no reason to keep writing to it.
 *
 * A spreadsheet of applicant records is a standing disclosure risk that grows
 * quietly: it holds names, phone numbers, institutions and matriculation
 * numbers for the whole intake, it is shared by link, copied by export, and
 * inherited by whoever had access last term. Admissions now reads the same
 * information from `applications.exportRows` — the same columns, generated on
 * demand, for an admin who is signed in and named.
 */
// crons.interval('flush application sheet mirror', { minutes: 5 }, internal.applications.flushMirror, {});

// Pulls the sheet's Status column back into ORBIT. Separate from the flush so a
// read failure cannot stop new applications reaching the sheet, and vice versa.
/**
 * REMOVED: sheet -> ORBIT status readback.
 *
 * This ran every five minutes and approved any application whose Status column
 * read "approved", straight from the spreadsheet. Its own audit note admits the
 * problem: "A spreadsheet cannot identify which person made the edit, so no
 * userId is recorded." An approval is a decision communicated to a person — it
 * creates their account and, now that the email hold is off, sends them an
 * acceptance with a sign-in link within minutes. A stray paste, an autofill
 * drag, or anyone with edit access to the sheet could therefore admit someone
 * with no admin in ORBIT having decided anything and nobody named as having
 * decided it.
 *
 * That was survivable while the ORBIT 2.0 intake was being approved in bulk
 * behind a global email pause. It is not survivable now: admissions from here
 * are approved one at a time, by a named admin, in ORBIT.
 *
 * The ORBIT -> sheet mirror above is UNAFFECTED, so the sheet still shows the
 * current state of every application. It is now a report, not a control.
 */
// crons.interval('sync application statuses from sheet', { minutes: 5 }, internal.applications.syncFromSheet, {});

// The safety net for conversion. Every approval schedules this immediately; the
// cron is what recovers an application whose conversion failed — most likely
// because no cohort existed yet — without anyone having to notice.
crons.interval('convert approved applications', { minutes: 15 }, internal.applications.convertApprovedApplications, {});

// Publishes agent proposals no supervisor got to inside the approval window.
// Hourly rather than daily so the stated auto-publish time in the supervisor's
// email is accurate to within the hour rather than to within a day.
crons.hourly(
  'auto-approve overdue task proposals',
  { minuteUTC: 20 },
  internal.tasks.autoApproveOverdueProposals,
  {},
);

// 07:00 WAT — before anyone arrives, so the day's expected attendance exists
// while it can still be met.
crons.daily(
  'open expected attendance',
  { hourUTC: 6, minuteUTC: 0 },
  internal.scheduled.openExpectedAttendance,
  {},
);

// 22:00 WAT — long after the working day, so a late arrival still counts as
// present rather than being marked absent while they are still on site.
crons.daily(
  'close expected attendance',
  { hourUTC: 21, minuteUTC: 0 },
  internal.scheduled.closeExpectedAttendance,
  {},
);

// Was netlify/functions/deadline-reminder.mts, hourly on the hour. That version
// degraded silently: if its RPC 4xx'd it logged a count and returned without
// emailing anyone.
crons.hourly(
  'deadline reminders',
  { minuteUTC: 0 },
  internal.scheduled.sendDeadlineReminders,
  {},
);

// Was netlify/functions/populate-weekly-leaderboard.mts, Mondays 00:05 UTC.
// Neither this nor the reminder had any Convex counterpart before now.
crons.weekly(
  'weekly leaderboard snapshot',
  { dayOfWeek: 'monday', hourUTC: 0, minuteUTC: 5 },
  internal.scheduled.populateWeeklyLeaderboard,
  {},
);

// Was orbit_siwes_send_reminders, an admin-callable RPC that nothing ever
// called. 16:00 UTC is 17:00 in Lagos — late enough that "you have not logged
// today" is true, early enough to act on.
crons.daily(
  'siwes logbook reminders',
  { hourUTC: 16, minuteUTC: 0 },
  internal.scheduled.sendSiwesReminders,
  {},
);

// Storage is billed per byte and never reclaimed by Convex, so an upload that
// was issued a URL and then abandoned is a permanent cost with nothing pointing
// at it.
crons.hourly(
  'reap unattached uploads',
  { minuteUTC: 20 },
  internal.files.reapUnattachedUploads,
  {},
);

/**
 * THE AGENT'S UNATTENDED UPKEEP.
 *
 * Everything below runs with nobody watching, which changes what each one is
 * allowed to do. The ordering is deliberate and is the safety property: ASK
 * before MARK, and CHECK after. A submission nobody can open gets chased on
 * Monday; the 72-hour auto-review only ever reaches work that survived that;
 * and the anomaly report reads the result on Friday.
 *
 * None of these assess CONTENT. Convex cannot open a PDF or judge an argument,
 * so the marking that cleared 510 submissions ran outside this deployment and
 * still does. What is automated here is the chasing, the reminding and the
 * checking around it — not the reading.
 */

// 07:00 WAT, DAILY — not weekly. A submission nobody can open is worth catching
// the morning after it arrives rather than up to six days later; the five-day
// `resharePromptedAt` window is what stops that becoming a daily nag, so the
// frequent check and the infrequent message are separate settings on purpose.
crons.daily(
  'chase unreadable submissions',
  { hourUTC: 6, minuteUTC: 0 },
  internal.agentOps.chaseUnreadableSubmissions,
  {},
);

// Monday and Thursday 08:00 WAT — twice a week is a rhythm; daily is nagging,
// and a reminder people learn to ignore is worse than none.
crons.cron(
  'remind reviewers',
  '0 7 * * 1,4',
  internal.agentOps.remindReviewers,
  {},
);

/**
 * SCHEDULED — BUT ONLY AS THE AGENT'S FALLBACK, never as the marker.
 *
 * Run bare, `autoReviewStaleSubmissions` pays every submission in full after
 * 72 hours, which would turn points into a record of who submitted. With
 * `agentFallback` it reaches only two kinds of row (lib/agentFallback.ts):
 * work the marking runner TRIED and set aside — its readers disagreed, or it
 * could not open the file — once five days have passed; and anything at all
 * after two weeks, so that the runner being a machine that can be switched off
 * delays marks rather than stranding them. Everything the agent can read is
 * still marked on its merits, by `scripts/agent/assess.py`, long before either.
 *
 * This is what closes the portal's last human gate on marking: nothing a
 * submission can turn into now waits for a person.
 */
crons.cron(
  'settle unmarkable submissions',
  '30 */6 * * *',
  internal.tasks.autoReviewStaleSubmissions,
  { afterHours: 120, agentFallback: true },
);

/**
 * Admissions, with no admissions desk. See convex/agentAdmissions.ts.
 *
 * The screener on the agent's machine records verdicts; this is the only thing
 * that admits, and it applies lib/admissionRules.ts — screened admits now,
 * split verdicts after three days, anything unscreened after a week (so a
 * runner outage delays admissions but cannot strand them), and two screeners
 * agreeing on "hold" never. Hourly, at :45, clear of the other hourly jobs.
 */
crons.hourly('admit screened applications', { minuteUTC: 45 }, internal.agentAdmissions.admitDue, {});

// Logbook supervision without supervisors (convex/agentSupervision.ts): approves
// daily logs the runner split on after five days, anything after two weeks, and
// signs off each week once none of its daily logs is still waiting.
crons.cron('settle logbooks', '15 */6 * * *', internal.agentSupervision.settleLogbook, {});

// Saturday 12:00 UTC: the week's tasks from the fixed bank, for any stream the
// agent's own drafting (scripts/agent/tasks.py -> agentTasks.publishAgentTasks)
// did not reach. Lands as proposals, which the hourly auto-approval publishes
// after the window. Skips every stream that already has live work.
crons.cron('seed weekly task proposals', '0 12 * * 6', internal.tasks.seedWeeklyProposals, {});

// 05:30 WAT daily, before attendance opens: the cohort calendar
// (convex/agentCohorts.ts). Opens the next cohort as a draft three weeks before
// the current one ends, activates it on its start date, completes the old one.
crons.daily('roll cohorts over', { hourUTC: 4, minuteUTC: 30 }, internal.agentCohorts.rollover, {});

// Friday 16:00 WAT. Reads the week's marking and, where it looks wrong, withdraws
// the low marks behind it (agentOps.respondToMarkOutliers). The runner also calls
// it at the end of every marking cycle; this is the backstop.
// Placed last on purpose — it is the check on everything above it.
crons.cron(
  'report mark anomalies',
  '0 15 * * 5',
  internal.agentOps.respondToMarkOutliers,
  {},
);

export default crons;
