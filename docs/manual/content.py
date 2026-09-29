# -*- coding: utf-8 -*-
"""Content for the ORBIT staff manual. Edit here, then run build.py."""

TITLE = "Running ORBIT"
STANDFIRST = (
    "ORBIT now runs itself: the ORBIT Agent admits applicants, marks work, reviews "
    "logbooks and writes each week's tasks. This is how that works, what staff can still "
    "do, and every screen you would use to do it."
)

INTRO = """
<aside class="note note--care" style="max-width:none">
  <p><strong>Before the first letter goes out:</strong> set the signatory, in
  <strong>Admin → Settings → General Settings</strong>. Until a super admin saves one,
  every acceptance letter prints with a blank signature line. It takes about thirty
  seconds — <a href="#acceptance-letters">{{sec:acceptance-letters}}</a> has the steps.</p>
</aside>
<p>ORBIT is where an application becomes an intern: the public form feeds a queue, the
queue produces a decision, the decision produces a letter the applicant's university
needs, and everything after that — placement, tasks, logbooks, sign-off — hangs off the
same record.</p>
<p><strong>Since 29 September 2026 nobody has to operate it.</strong> The ORBIT Agent
does the work staff used to do, and timers make sure nothing waits on a person
(<a href="#how-orbit-runs-itself">{{sec:how-orbit-runs-itself}}</a>). Every staff screen still works, so this
manual is for looking up how something works or stepping in by choice — not a list of
chores. It is written to be looked up rather than read through, so each section stands on
its own.</p>
"""

SECTIONS = [
    # ------------------------------------------------------------------ 00
    ("How ORBIT runs itself", [
        ('p', "Every job that used to need a member of staff is now done by the "
              "<strong>ORBIT Agent</strong> — an automated assistant with its own account "
              "(<code>orbit.agent@iih.ng</code>), so every decision it makes is recorded "
              "under its name, never yours."),
        ('table',
         ['Job', 'What the agent does', 'If it cannot decide'],
         [
             ['<strong>Admissions</strong>',
              'Two independent models screen each application; if they agree it is genuine, '
              'the agent approves it and places the applicant in the least-busy stream of '
              'their first-choice track. Acceptance email (and SIWES letter) follow '
              'automatically.',
              'A split verdict is admitted after 3 days; an application nobody screened, '
              'after 7. Two screeners agreeing on spam or ineligible keeps it out.'],
             ['<strong>Marking</strong>',
              'Two models read each submission — text, files, links — and must agree on a '
              'score; a third breaks ties. A unanimous zero (usually work for the wrong task) '
              'goes back to the intern to redo.',
              'Work it cannot open or agree on is approved at full points 5 days after it was '
              'set aside, with feedback saying it was not individually assessed. Anything at '
              'all is settled after 14 days.'],
             ['<strong>Logbooks</strong>',
              'Daily logs are reviewed by two models; one is returned only if both say it '
              'describes no real work. Weeks are signed off once they end, have an approved '
              'log and nothing is waiting.',
              'Split reviews are approved after 5 days; anything after 14.'],
             ['<strong>Tasks</strong>',
              'Each week, for every stream with nothing live, the agent writes fresh tasks and '
              'a second model vets each for safety and whether it can be marked. Survivors '
              'publish straight away and interns get one message per stream.',
              'On Saturdays the prepared task bank tops up any stream the agent missed.'],
             ['<strong>Cohorts</strong>',
              'Three weeks before a cohort ends, the next one is opened as a draft; it '
              'becomes active on its start date and the old one closes once it has.',
              '—'],
             ['<strong>Questions</strong>',
              'Interns who message the ORBIT Agent get a reply grounded in how ORBIT actually '
              'works and in their own record.',
              'A reply that fails its check is replaced by a short, safe one.'],
         ]),
        ('note', 'info',
         "<strong>The timers are the safety net.</strong> The agent's reading runs on a "
         "machine outside ORBIT three times a day; the rules and timers run inside ORBIT "
         "itself. If that machine is off, work is delayed — never stranded, and never left "
         "for someone to notice."),
        ('h', 'What staff can still do'),
        ('p', "Everything. Staff screens are unchanged, and a person acting first always wins: "
              "a submission you review is never touched by the agent, an application you "
              "approve is simply approved, and a daily log you sign off is done. The agent "
              "only ever picks up what is still waiting."),
        ('h', 'Telling who decided'),
        ('bullets', [
            'A submission the agent marked carries feedback ending <em>“Assessed by ORBIT Agent …”</em>; one settled by the timer says it was <em>not individually assessed</em>.',
            'An application, daily log or weekly sign-off the agent decided names the <strong>ORBIT Agent</strong> as its reviewer.',
            'Tasks the agent wrote list the ORBIT Agent as their author.',
        ]),
    ]),

    # ------------------------------------------------------------------ 01
    ("Signing in and what you can see", [
        ('p', "Everyone works from the same address — <code>orbit2.iih.ng</code> — and what "
              "you can reach is decided by your role. If a screen described here is missing, "
              "your account almost certainly does not carry the role for it; that is a "
              "permissions question for a super admin, not a fault."),
        ('shot', '01-sign-in.png', 'The sign-in screen. Password or a magic link by email; '
                                   'Zoho SSO is offered for staff accounts.'),
        ('h', 'The four roles'),
        ('table',
         ['Role', 'Reaches', 'Typical holder'],
         [
             ['<strong>Super admin</strong>', 'Everything, plus bulk import and role changes',
              'Programme lead'],
             ['<strong>Admin</strong>', 'Admissions, approvals, letters, placement, streams, tasks, users',
              'Programme staff'],
             ['<strong>Moderator</strong> <span style="color:var(--muted)">(supervisor)</span>',
              'Their own streams, their interns’ submissions and logbooks',
              'Team leads supervising interns'],
             ['<strong>Intern</strong>', 'Their own tasks, submissions, logbook and profile',
              'The students on placement'],
         ]),
        ('note', 'info',
         "A moderator only ever sees the streams they moderate. This is enforced on the "
         "server, not by hiding buttons — so a supervisor cannot reach another team’s "
         "submissions by any route."),
        ('h', 'Finding your way around'),
        ('h', 'When something is wrong'),
        ('p', "There is a <strong>Report a bug</strong> button on every page, bottom right. "
              "It takes one sentence and records which screen you were on, which is the part "
              "people usually cannot remember later. It works signed out too — useful when "
              "the thing that is broken is the sign-in page itself. Anywhere this manual says "
              "to raise something, that is the channel."),
        ('note', 'care',
         "Do not paste a password or a sign-in link into a bug report. The page address is "
         "attached automatically, with anything sensitive stripped out of it."),
        ('p', "The green <strong>Admin</strong> button in the top bar opens the staff area. "
              "Inside it, the row of tabs — Overview, Streams, Tasks, Users, Applications, "
              "SIWES, Gamification, Settings — is most of the administrative platform, but "
              "not all of it. Three things staff use daily sit OUTSIDE it, on the main "
              "navigation: <strong>Manual</strong> (this document, in the app, with a "
              "PDF to download), the review dashboard, and the task proposal queue."),
        ('shot', '03-admin-overview.png', 'The admin area. Everything in this manual lives '
                                          'behind one of these eight tabs — with the three exceptions noted above.'),
    ]),

    # ------------------------------------------------------------------ 02
    ("Admissions: reading and approving applications", [
        ('p', "Applications arrive from the public form at <code>orbit2.iih.ng/apply</code>. "
              "Nobody needs an account to apply, and nothing you do in ORBIT sends the form "
              "out — it is simply always open."),
        ('note', 'info',
         "<strong>You do not need to approve anyone.</strong> The ORBIT Agent screens every "
         "new application within hours and approves genuine ones itself "
         "(<a href=\"#how-orbit-runs-itself\">{{sec:how-orbit-runs-itself}}</a>). The steps below are for when "
         "you want to decide one yourself — an application you approve is simply approved, "
         "and the agent leaves it alone."),
        ('shot', '02-public-form.png', 'What an applicant fills in. The SIWES fields — '
                                       'institution, course, matric number, dates, placement '
                                       'letter — only appear when they choose SIWES.'),
        ('h', 'Opening the queue'),
        ('steps', [
            'Click <strong>Admin</strong> in the top bar.',
            'Open the <strong>Applications</strong> tab — this is the queue for all four programmes.',
            '(<strong>SIWES → Applications</strong> shows the same screen filtered to SIWES only.)',
        ]),
        ('h', 'Getting the data out'),
        ('p', "<strong>Export to Excel</strong>, on the Applications screen, downloads every "
              "application as a workbook — the same columns the old Google Sheet carried. "
              "It is generated when you press it, so it is current, and it is a snapshot: "
              "the file is dated, and it does not update itself afterwards."),
        ('note', 'care',
         "<strong>The Google Sheet is disconnected.</strong> It no longer receives "
         "applications and it no longer approves anyone — a Status column edited there does "
         "nothing. If you have it bookmarked, stop consulting it; it is frozen at the day it "
         "was switched off. Approval happens here — by the ORBIT Agent or an admin, and the "
         "record names which — and the export above replaces it for anything you used the "
         "sheet to read."),
        ('note', 'care',
         "The export names each applicant's documents but never contains them. The passport "
         "photograph and the placement letter stay in ORBIT behind a sign-in. A downloaded "
         "workbook gets forwarded and copied like any other file, and an identity document "
         "inside one travels with it."),
        ('shot', '04-admissions-queue.png',
         'The admissions queue, filtered to Submitted. The count beneath the heading is how '
         'many are waiting on a decision.'),
        ('h', 'Four programmes, one queue'),
        ('p', "ORBIT is not a SIWES-only platform, and the queue is not a SIWES-only "
              "queue. Applicants choose SIWES, Internship, NYSC or Volunteer, and on the "
              "live platform SIWES is the minority — of the applications waiting now, "
              "roughly two in three are one of the other three."),
        ('p', "The coloured badge beside each name is the programme. It matters because the "
              "rest of the row changes with it: a SIWES applicant supplies an institution, "
              "course, matric number and placement dates, and a volunteer supplies none of "
              "them. The Programme column shows what that person actually gave you rather "
              "than a row of dashes."),
        ('note', 'info',
         "Only SIWES applicants receive an acceptance letter, and only SIWES interns keep a "
         "logbook. Everything else — tasks, submissions, points, streams, community — works "
         "the same for all four."),
        ('h', 'Reading a row'),
        ('p', "Each row carries everything a decision needs: the applicant and their contact "
              "details, their reference code, the institution, course, matric number and "
              "placement dates, and a link to the SIWES form or letter they uploaded."),
        ('shot', '05-application-row.png',
         'One application. <strong>SIWES form/letter</strong> opens the uploaded document in '
         'a new tab.'),
        ('note', 'info',
         "Documents open through an authenticated link rather than a public URL, so the tab "
         "may take a moment. If nothing opens, your session has probably expired — sign in "
         "again and retry."),
        ('h', 'Approving'),
        ('steps', [
            'Find the applicant. The search box matches name, email and reference code.',
            'Click <strong>Approve</strong> on their row.',
            'Read the name in the confirmation prompt, then confirm.',
        ]),
        ('note', 'stop',
         "<strong>Approval cannot be undone.</strong> There is no route back to Submitted, "
         "which is why the prompt names the applicant rather than asking “are you "
         "sure” — reading the name is what catches the wrong row. An approved row stops "
         "offering an Approve button at all."),
        ('h', 'Approving several at once'),
        ('p', "Tick the checkboxes on the rows you want and use the bulk action above the "
              "table. Only rows still awaiting a decision can be selected — an approved "
              "application has nothing left to do to it. Changing the filter clears your "
              "selection, deliberately: a selection that survived a filter change would be a "
              "selection of rows you can no longer see."),
    ]),

    # ------------------------------------------------------------------ 03
    ("Acceptance letters", [
        ('p', "A university’s Industrial Liaison Unit will not accept a placement until it "
              "holds a letter from the host organisation confirming the student was taken. "
              "ORBIT generates that letter from the application, on IIH letterhead, with the "
              "wording fixed to the approved template."),
        ('h', 'First: set who signs'),
        ('p', "Do this once. Until it is set, every letter prints with a blank signature line "
              "and the screen will tell you the HR signatory is missing."),
        ('steps', [
            'Open <strong>Admin → Settings → General Settings</strong>.',
            'In <strong>Acceptance letter signatory</strong>, choose the person who signs and '
            'set their job title.',
            'Save. Every letter from then on uses it.',
        ]),
        ('note', 'care',
         "<strong>Super admin only</strong>, and not editable from the letter itself. The "
         "letter screen shows you who is set but cannot change it — deliberately: gating "
         "the stored value would mean nothing if the printed name were a free-text box beside "
         "the Print button. An admin can still print letters; they just cannot change "
         "whose name signs them — that is a super admin setting."),
        ('note', 'care',
         "<strong>SIWES applicants only.</strong> An approved internship, NYSC or volunteer "
         "row shows no letter button, and a batch run passes over them. The letter is "
         "addressed to a university's Industrial Liaison Unit and titled &ldquo;for SIWES "
         "placement&rdquo; — an office a volunteer has no relationship with."),
        ('h', 'One letter'),
        ('steps', [
            'In the Applications queue, set the status filter to <strong>Approved</strong>.',
            'Click <strong>Acceptance letter</strong> on the applicant’s row.',
            'Check the letter date, then click <strong>Print</strong>.',
            'In the print dialog choose <strong>Save as PDF</strong>, or print on plain paper — the IIH letterhead is part of the generated document, so pre-printed headed paper would print it twice.',
        ]),
        ('shot', '06-approved-filter.png',
         'Approved applicants. Each approved SIWES row offers its own letter; internship, NYSC and volunteer rows correctly offer none.'),
        ('shot', '07-acceptance-letter.png',
         'The letter exactly as it prints, on IIH letterhead. The controls you see on '
         'screen around it are not part of the document.'),
        ('p', "Pronouns come from the gender the applicant gave on the form. Answered, the "
              "letter reads “She will undergo her industrial training”; left blank, it "
              "falls back to “He/She … his/her” rather than guessing on a document "
              "the university keeps."),
        ('h', 'The whole cohort at once'),
        ('p', "<strong>Acceptance letters</strong> at the top of the queue gathers every "
              "approved SIWES applicant — not just the ones on screen — and lays them out one "
              "per page for a single print run."),
        ('shot', '09-letters-batch.png',
         'A batch run. Each letter starts a new page, so one print job produces the whole set.'),
        ('h', 'Read the warnings before you print'),
        ('p', "If an application is missing something the letter needs — no department, no "
              "level, no university, no signatory — the letter still prints, with that clause "
              "dropped so the sentence still reads as English. The amber panel above the "
              "letters is the only thing that tells you. A letter that quietly omits the "
              "department reads as complete and is not."),
        ('note', 'care',
         "A missing field cannot be corrected from the approved application — the intake "
         "record is fixed once a decision is made, and there is no staff edit for it. What "
         "you CAN correct is the source the letter reads from: the signatory in "
         "<strong>Admin → Settings → General Settings</strong>, and the intern's department "
         "and cohort under <strong>SIWES → Interns</strong>. Fix those, then reprint. If the "
         "wrong value is one only the applicant supplied, raise it rather than reprinting "
         "around it — the letter and the intern's file are supposed to agree."),
        ('h', 'Reprinting'),
        ('p', "Letters are not stored. Each one is generated fresh from the application, so a "
              "letter that goes astray is reprinted by opening the row again — and a "
              "correction to the application shows up on the next print automatically."),
    ]),

    # ------------------------------------------------------------------ 04
    ("Placement and conversion", [
        ('p', "Approval says yes. Placement says <em>how</em>: whether the intern works on "
              "site, which stream they join, and who supervises them. When the ORBIT Agent "
              "admits someone it places them itself — in the least-busy stream of the first "
              "track they chose, in the current cohort (or the incoming one, in a cohort's "
              "last fortnight). Use <strong>Assign</strong> on the application row to decide "
              "a placement yourself before approving."),
        ('note', 'care',
         "Automatic placement only works for streams that belong to a <strong>track</strong>. "
         "A new stream that is not attached to one is never chosen, so attach it when you "
         "create it."),
        ('h', 'What you set'),
        ('table',
         ['Field', 'What it means'],
         [
             ['<strong>Participation mode</strong>',
              'Virtual (online), Hybrid (on site one day a week), or Physical (on site). '
              '<strong>SIWES placements are virtual for everyone</strong>, wherever the '
              'student lives — do not put a SIWES intern on site. For the other '
              'programmes, Ilorin-based interns are hybrid and attend on '
              '<strong>Mondays</strong>.'],
             ['<strong>Reason</strong>',
              'Required when you override the mode the applicant asked for'],
             ['<strong>On-site day</strong>', 'Which weekday a hybrid intern attends. Monday, unless there is a specific reason — a cohort scattered across the week has no day when the Hub is full.'],
             ['<strong>Stream</strong>', 'The team they join and receive tasks from'],
             ['<strong>Supervisor</strong>', 'The person who reviews their work and signs their logbook'],
         ]),
        ('note', 'info',
         "The reason field exists because a mode override is a decision someone will ask "
         "about later — usually the intern. Writing it down at the time is cheaper than "
         "reconstructing it."),
        ('h', 'Becoming an intern'),
        ('p', "Conversion is automatic and starts the moment you approve — an approved "
              "applicant becomes an intern account straight away, and appears under "
              "<strong>SIWES → Interns</strong>. A job every fifteen minutes retries anything "
              "that failed, so that interval is a safety net rather than the normal wait. "
              "There is no button to press, and approving twice does not make it faster."),
        ('p', "Once converted, the intern is managed from the Interns register rather than "
              "the application row, which has done its job."),
        ('note', 'info',
         "If someone approved more than fifteen minutes ago still has not appeared, the "
         "retry sweep has had a go and not succeeded — that is "
         "worth raising rather than re-approving — the record is already approved and the "
         "sweep will not create them twice."),
        ('shot', '12-interns.png',
         'The interns register. Filter by cohort; <strong>Edit</strong> changes mode, '
         'supervisor or department after placement.'),
        ('h', 'Cohorts and departments'),
        ('p', "A cohort carries the programme dates and the logbook rules — which days need a "
              "daily log, when weekly summaries are due, whether sign-off is required. "
              "Departments are the IIH teams interns are attached to."),
        ('shot', '10-cohorts.png',
         'Cohorts. The start date matters beyond reporting: tasks cannot be created or '
         'assigned before the programme starts.'),
        ('shot', '11-departments.png', 'Departments, and whether each is currently active.'),
    ]),

    # ------------------------------------------------------------------ 05
    ("Streams and tasks", [
        ('p', "A stream is a team with its own members, feed and work. Tasks are published "
              "into a stream, and only its members see them."),
        ('p', "<strong>Every week the ORBIT Agent writes each stream's tasks.</strong> For any "
              "stream with no live task, it drafts five against the programme's rules — "
              "doable virtually, from public material, safe, and markable from the "
              "submission — has a second model vet each one, and publishes the survivors. "
              "They are priced by the same complexity rules as a task you write, and every "
              "intern in the stream gets one message listing them. You can still add tasks of "
              "your own at any time."),
        ('shot', '13-streams.png', 'Streams. Deactivating one hides it without deleting '
                                   'anything that happened in it.'),
        ('h', 'Creating a task'),
        ('steps', [
            'Open <strong>Admin → Tasks</strong> and click <strong>Create Task</strong>. <em>Admins only — a supervisor has no Admin button; supervisors shape the week by approving or editing proposals in the task queue instead.</em>',
            'Choose the <strong>stream</strong> — a task with no stream reaches nobody.',
            'Write a title and full instructions.',
            'Check the deadline. It is pre-filled from the cohort’s weekly cadence; change it if this task differs.',
            'Set the points and how work should be submitted — text, link or file.',
            'Click <strong>Create Task</strong>.',
        ]),
        ('shot', '14-tasks.png',
         'Task management. Search and the status filter combine, so you can find inactive '
         'tasks in one stream.'),
        ('note', 'care',
         "<strong>Tasks cannot be created or assigned before the programme starts.</strong> "
         "If the Create Task button is disabled, check the cohort’s start date — the "
         "message on screen names it."),
        ('h', 'Active and inactive'),
        ('p', "Deactivating a task withdraws it without destroying submissions already made "
              "against it. That is almost always what you want instead of deleting."),
    ]),

    # ------------------------------------------------------------------ 06
    ("Reviewing submissions", [
        ('p', "Submitted work waits on the <strong>Review Submissions</strong> screen. "
              "Supervisors see their own streams; admins see everything."),
        ('note', 'info',
         "<strong>The ORBIT Agent marks this queue for you</strong>, three times a day. What "
         "you see here is what it has not reached yet, or has set aside because it could not "
         "read the work or its markers disagreed. Reviewing one yourself is always allowed "
         "and always wins; the agent never touches a submission a person has decided."),
        ('note', 'info',
         "<strong>How you get there depends on your role.</strong> Supervisors open the "
         "<strong>profile menu</strong> — your avatar, top right — and choose "
         "<strong>Review Submissions</strong>. There is no Admin button on a supervisor "
         "account and there is not meant to be; the review screens are reached from the "
         "profile menu instead. Admins can use either route."),
        ('shot', '16-submission-review.png',
         'The review queue. Pick a submission on the left; it opens for review on the right.'),
        ('h', 'Making a decision'),
        ('steps', [
            'Filter by status, or search by intern, task or stream.',
            'Click the submission to open it.',
            'Choose <strong>Approve</strong>, <strong>Request Changes</strong> or <strong>Reject</strong>.',
            'For an approval, set the points to award. For anything else, write the feedback — it is required.',
            'Click <strong>Submit Review</strong>.',
        ]),
        ('table',
         ['Decision', 'What happens', 'Points'],
         [
             ['<strong>Approve</strong>', 'Work accepted and closed', 'Awarded, up to the task maximum'],
             ['<strong>Request changes</strong>', 'Returns to the intern, who can resubmit', 'None'],
             ['<strong>Reject</strong>', 'Closed without acceptance', 'None'],
         ]),
        ('note', 'info',
         "Feedback is mandatory for anything that is not an approval. An intern who is told "
         "only “changes requested” has been given a verdict, not a way forward."),
        ('note', 'care',
         "A submission can be resubmitted after <em>Request changes</em>, but not after "
         "<em>Approve</em> or <em>Reject</em> — both are final."),
    ]),

    # ------------------------------------------------------------------ 07
    ("Logbook and attendance sign-off", [
        ('p', "SIWES requires a logbook the university will inspect, so this is the part with "
              "an external deadline. The <strong>Review Dashboard</strong> collects everything "
              "waiting on a supervisor."),
        ('note', 'info',
         "<strong>The ORBIT Agent reviews daily logs and signs off weeks</strong>, so this "
         "dashboard is no longer a to-do list. A log is sent back only when two independent "
         "reviewers agree it describes no real work; a week is signed off once it has ended, "
         "has at least one approved log, and nothing in it is waiting or was sent back. The "
         "sign-off names the ORBIT Agent. You can still review anything that is waiting."),
        ('shot', '17-logbook-review.png',
         'The Review Dashboard. The four tiles are counts of work waiting on you; the tabs '
         'below open each list.'),
        ('table',
         ['Tab', 'What is in it'],
         [
             ['<strong>Pending logs</strong>', 'Daily logs submitted and waiting to be reviewed'],
             ['<strong>Sign-offs</strong>', 'Weekly summaries awaiting a supervisor’s sign-off'],
             ['<strong>My interns</strong>', 'The people you supervise'],
             ['<strong>Missing logs</strong>', 'Days that should have a log and do not'],
             ['<strong>Attendance</strong>', 'Check-ins that need attention — absences and exceptions'],
         ]),
        ('h', 'Who keeps a logbook'),
        ('p', "SIWES interns, and nobody else. The logbook exists to be inspected by a "
              "university's Industrial Liaison Unit; an internship, NYSC or volunteer "
              "participant has no institution expecting one, so ORBIT does not ask them for "
              "one, does not remind them about one, and does not count them as missing one "
              "on this dashboard."),
        ('shot', '18-volunteer-logbook.png',
         'The logbook as a SIWES intern sees it: today’s log, history, weekly summaries, '
         'attendance and export. A volunteer opening the same page sees only Attendance.'),
        ('note', 'info',
         "This is decided by the programme on the person's record. An account created by "
         "hand or by import carries no programme, so if a SIWES intern is missing their "
         "logbook tabs, that is the field to check first."),
        ('h', 'Reviewing a log'),
        ('steps', [
            'Open the <strong>profile menu</strong> (your avatar, top right) and choose <strong>Review Logbooks</strong>.',
            'On <strong>Pending logs</strong>, click <strong>Review</strong> on an entry.',
            'Read the work described, then approve it or send it back with a comment.',
        ]),
        ('note', 'care',
         "<strong>Missing logs</strong> is the number that matters at the end of the "
         "placement. A gap is far easier to resolve in the week it happens than in the month "
         "the university asks for the completed logbook."),
        ('p', "Verification writes against the intern’s record, not the supervisor’s, so "
              "a supervisor signing off work never affects their own logbook."),
    ]),

    # ------------------------------------------------------------------ 08
    ("Users, accounts and settings", [
        ('p', "<strong>Admin → Users</strong> is the account register: create accounts, edit "
              "them, change roles, deactivate, and export the list you are looking at."),
        ('shot', '15-users.png',
         'The user register. Search and role filters combine; bulk selection drives the bulk '
         'actions.'),
        ('h', 'Deactivating rather than deleting'),
        ('p', "Deactivating blocks sign-in and keeps everything the person did. It is "
              "reversible. Use it when someone leaves the programme."),
        ('note', 'stop',
         "Deleting moves an account to trash, from which it can be restored. "
         "<strong>Delete forever</strong> is exactly that, and only a SUPER ADMIN can do it "
         "— an ordinary admin will not see the option, which is a permission boundary and "
         "not a fault. Prefer deactivation unless the account was created in error."),
        ('h', 'Adding people'),
        ('bullets', [
            '<strong>One at a time</strong> — <strong>Add User</strong> creates an account and can send them a password.',
            '<strong>In bulk</strong> — import a CSV or spreadsheet. Super admin only. Re-importing the same file does not create duplicates.',
            '<strong>From an application</strong> — the normal route for interns, covered in <a href="#placement-and-conversion">{{sec:placement-and-conversion}}</a>.',
        ]),
        ('h', 'Who has actually signed in'),
        ('p', "The register carries a <strong>Last sign-in</strong> column and a filter for "
              "it. An account that has never been used shows <strong>Never</strong>. In the "
              "first week of a cohort this is the number that matters: signing in is the "
              "first thing every new intern has to do, and this is how you see who has."),
        ('p', "Signing in is not the only thing, though. The home page shows a new member a "
              "short <strong>Your first steps</strong> checklist — sign in, set a password, "
              "read the orientation manual — and it disappears once they finish. The password "
              "step is the one worth chasing: sign-in links expire, and a member without a "
              "password needs a new email every time they come back."),
        ('note', 'info',
         "Set the filter to <strong>Never signed in</strong> for the list of people to "
         "chase. If that list is not shrinking, check whether outgoing mail is held "
         "(<a href=\"#email-logs-holds-and-why-nothing-arrived\">{{sec:email-logs-holds-and-why-nothing-arrived}}</a>) before assuming the accounts are at fault."),
        ('h', 'Settings worth knowing'),
        ('bullets', [
            '<strong>Email logs</strong> — every message ORBIT tried to send, and what happened to it. <strong>Sent</strong> means ORBIT handed it to the mail service, not that it reached an inbox. Check here first when someone says they never received a mail; <a href="#email-logs-holds-and-why-nothing-arrived">{{sec:email-logs-holds-and-why-nothing-arrived}}</a> covers this in full.',
            '<strong>Gamification</strong> — levels and badges, and the points thresholds between them.',
            '<strong>Backup management</strong> — exports of platform data.',
        ]),
        ('note', 'info',
         "Roles take effect <strong>immediately</strong> on the server — every permission is "
         "re-checked on each request, so a demotion bites on the demoted person’s very next "
         "action. What can lag is their own screen: the navigation they are looking at was "
         "drawn with their old roles. If someone was just promoted and still cannot see a "
         "screen, a reload is enough; they do not need to sign out."),
    ]),

    # ------------------------------------------------------------------ 09
    ("Task proposals: work the agent drafts", [
        ('p', "The proposal queue matters far less than it used to. The ORBIT Agent now "
              "publishes each week's tasks itself, after a second model has vetted them "
              "(<a href=\"#streams-and-tasks\">{{sec:streams-and-tasks}}</a>), so its tasks no longer wait "
              "here. What still arrives as a <strong>proposal</strong>:"),
        ('bullets', [
            'The <strong>Saturday top-up</strong> from the prepared task bank, for any stream the agent did not write for that week.',
            'Tasks a person creates through the agent\u2019s connection rather than in the browser.',
        ]),
        ('shot', '19-task-proposals.png',
         'The proposal queue. You see proposals for the streams you supervise; admins see '
         'all of them.'),
        ('h', 'Proposals publish themselves'),
        ('p', "A proposal nobody answers publishes itself once the approval window passes "
              "(48 hours), with no approver recorded. That keeps a quiet week from becoming "
              "a week with no work in it — so an unattended queue is not a problem to solve. "
              "You can still step in:"),
        ('steps', [
            'Open <strong>Tasks</strong>, then <strong>Task proposals</strong>.',
            'Read the draft — stream, deadline, points and how work should be submitted.',
            'Choose <strong>Approve and publish</strong>, <strong>Edit first</strong> if it needs changing, or <strong>Decline</strong>.',
            'A decline asks for a reason. Write one — it is the only record that survives.',
        ]),
        ('note', 'care',
         "<strong>Declining deletes the proposal.</strong> There is no declined list and "
         "no recycle bin — only your reason, in the audit log. If the task is salvageable, "
         "use <strong>Edit first</strong> instead."),
        ('p', "<strong>Request another task</strong>, above the list, drafts the next prepared "
              "task for a stream as a new proposal — useful after a decline."),
    ]),

    # ------------------------------------------------------------------ 10
    ("Email: logs, holds, and why nothing arrived", [
        ('p', "Almost every complaint that reaches you as “the account is broken” is really "
              "a mail question: the sign-in link never arrived. This section is where to "
              "look, in order."),
        ('h', 'First: is mail flowing at all?'),
        ('p', "ORBIT has two independent brakes on outgoing mail, and either one holds "
              "<em>everything</em> — notifications, acceptance letters, sign-in links, "
              "application receipts. Nothing is lost while a brake is on; messages queue up "
              "and send when it is released."),
        ('table',
         ['BRAKE', 'WHERE IT LIVES', 'WHO CAN RELEASE IT'],
         [
             ['The pause switch', 'Admin → Settings → General Settings', 'Super admin, from the app'],
             ['The deployment hold', 'Set on the deployment itself', 'Whoever administers the deployment — not from the app'],
         ]),
        ('note', 'care',
         "<strong>While mail is held, the Users screen says so.</strong> A standing notice "
         "appears at the top of <strong>Admin → Users</strong>, and the password-reset "
         "actions report that a link was <em>queued</em> rather than sent. If you see that "
         "notice, no amount of resending will deliver anything — release the brake first."),
        ('h', 'Then: did this particular message go?'),
        ('shot', '20-email-logs.png',
         'Email logs. Every message ORBIT has tried to send, and what happened to it.'),
        ('p', "Reach it from <strong>Admin → Settings → Email Configuration → View Email "
              "Logs</strong>. Search by the person’s address. Open any row to see its "
              "<strong>delivery attempts</strong> — every try, when it happened, how long the "
              "provider took, and the exact error. Three failures for three different reasons "
              "look nothing like three for one, and only the attempt history tells them apart."),
        ('bullets', [
            '<strong>No row at all</strong> — the message was never queued. The action that should have created it did not run; check you completed it.',
            '<strong>Pending</strong> — waiting. Either for the next run, or out a retry backoff after a failed attempt; the row shows when the next try is due. A brake being on is the usual reason nothing moves at all.',
            '<strong>Sending</strong> — a drain run holds it right now. Leave it; it resolves within a few minutes.',
            '<strong>Cancelled</strong> — someone stopped it deliberately. NOT a failure, and never retried on its own. Requeue it if that was a mistake.',
            '<strong>Failed</strong> — attempted and refused. The reason on the row is the actual error from the mail service.',
            '<strong>Sent</strong> — ORBIT handed it over successfully. If the recipient still has nothing, it is in their spam folder or their institution blocked it.',
        ]),
        ('note', 'info',
         "A message body IS kept, but reading one is deliberately awkward: only a super admin can, it is written to the audit log naming who looked, and there is no bulk view. That is because a sign-in email contains a live credential — opening one is closer to borrowing someone’s account than to reading a log."),

        ('h', 'Acting on a message'),
        ('p', "Two actions sit on each row, and they appear only where they would work — "
              "the server refuses the rest, so a button that is not offered is not a "
              "permissions problem."),
        ('bullets', [
            '<strong>Requeue</strong> — puts a failed or cancelled message back in the queue and clears its retry count, so it starts again from a clean slate. Use it after fixing whatever caused the failure. It is audited, because requeuing an unexpired sign-in email re-delivers a live credential to somebody’s mailbox on your say-so.',
            '<strong>Stop</strong> — cancels a message that has not gone out. The recipient will not get it and nothing else in the system will notice, so it asks first. Requeue afterwards if you stopped it in error.',
        ]),
        ('note', 'info',
         "Neither is offered for a message already sent, or for one a run is holding right "
         "now — that send may already be in flight, and marking it otherwise would leave the "
         "log asserting something that did not happen."),
        ('h', 'Reading the queue at a glance'),
        ('p', "Above the log is a summary that separates the three ways a message can sit "
              "unsent, because they look identical in a status column and need different "
              "responses: <strong>waiting to send</strong> (nothing to do), <strong>retrying"
              "</strong> (backing off after a failure — also nothing to do, it is scheduled), "
              "and <strong>held</strong> because dispatch is paused, which is waiting on a "
              "person. During a hold, “18 pending” does not mean a queue about to move."),
        ('note', 'warn',
         "The panel can only see ONE of the two brakes. The pause switch lives in the "
         "database and is shown; the deployment hold is an environment variable that no "
         "screen can read. If messages stay pending while dispatch reads as running, that is "
         "the one to check — the screen says as much rather than guessing."),
        ('h', 'Week one: getting everyone signed in'),
        ('p', "New interns have no password. Conversion deliberately does not set one — they "
              "sign in with a magic link they request themselves, and a magic link is an "
              "email. So while mail is held, <strong>nobody can get in</strong>, and week "
              "one's only task cannot start. This is the sequence to open it."),
        ('steps', [
            'Confirm the accounts exist first: <strong>Admin → Users</strong>, filter '
            '<strong>Never signed in</strong>. Everyone you approved should be listed.',
            '<strong>Only if mail is actually held</strong> — a notice appears at the '
            'top of <strong>Admin → Users</strong> when it is — release it in '
            '<strong>Admin → Settings → General Settings</strong>. Super admin '
            'only. Mail sends normally by default, so on most cohorts there is nothing to '
            'release and this step is skipped.',
            'Watch the queued backlog drain in <strong>Email logs</strong> — rows move from '
            'Pending to Sent. This includes anything queued while the hold was on, so expect '
            'more than just today\u2019s messages.',
            'Give it a few minutes, then reload the Users register. Names should start '
            'dropping off the <strong>Never signed in</strong> filter.',
            'For anyone still on that list after a day, select them and use the bulk '
            'sign-in-link action, then check <strong>Email logs</strong> for their address.',
        ]),
        ('note', 'stop',
         "<strong>Releasing the hold sends everything waiting behind it, immediately.</strong> "
         "If the queue has been held for a while and you are not sure how old the backlog is, "
         "look at Email logs BEFORE releasing — those messages go to real applicants the "
         "moment you do."),
        ('note', 'info',
         "An intern who says the link never arrived: check <strong>Email logs</strong> first. "
         "<strong>Sent</strong> means ORBIT handed it over and the problem is their inbox or "
         "their institution\u2019s filter. Anything else is ours."),
    ]),

    # ------------------------------------------------------------------ 11
    ("Settings", [
        ('p', "One screen, at <strong>Admin → Settings</strong>, holding the things that "
              "change how the whole platform behaves rather than anything about one person."),
        ('shot', '21-settings.png',
         'Admin settings. The sub-tabs across the top separate mail, sign-in and general '
         'configuration.'),
        ('bullets', [
            '<strong>General Settings</strong> — branding, and the two super-admin-only controls that matter most here: the <strong>outgoing email pause switch</strong> and the <strong>acceptance letter signatory</strong>.',
            '<strong>Email configuration</strong> — the sending account, and the route through to the email logs.',
            '<strong>Sign-in</strong> — the Zoho single-sign-on connection used by staff accounts.',
        ]),
        ('note', 'care',
         "Changes here apply to everyone at once and some of them are not visibly "
         "reversible from the same screen. Read what a control says before changing it, "
         "and if a setting mentions a deployment variable, it cannot be changed from the "
         "app at all."),
    ]),

    # ------------------------------------------------------------------ 12
    ("Keeping an eye on the agent", [
        ('p', "Nothing here needs doing on a schedule. It is where to look if something "
              "seems off, and what each signal means."),
        ('h', 'Where its work shows up'),
        ('bullets', [
            '<strong>Audit log</strong> — every decision is written under the ORBIT Agent with an <code>agent.</code> action: <code>agent.application_admitted</code>, <code>agent.tasks_published</code>, <code>agent.cohort_created</code>, and so on.',
            '<strong>Email logs</strong> (<a href="#email-logs-holds-and-why-nothing-arrived">{{sec:email-logs-holds-and-why-nothing-arrived}}</a>) — acceptances, marks, task messages and replies go out like any other mail, so a quiet week there is the first sign something has stopped.',
            '<strong>Review Submissions</strong> — a queue that keeps growing for more than a couple of days means marking is not keeping up.',
        ]),
        ('h', 'The machine that does the reading'),
        ('p', "The models that read applications, submissions, logs and messages run on a "
              "machine outside ORBIT, three times a day, using ORBIT's own subscriptions. It "
              "keeps its logs in <code>~/.openclaw/workspace/logs/orbit-agent/</code> and "
              "raises two flags there:"),
        ('table',
         ['File', 'Means', 'Usually'],
         [
             ['<code>UNHEALTHY</code>', 'A whole cycle failed on the agent’s side', 'A model sign-in has expired or a usage allowance ran out'],
             ['<code>BACKUP_FAILED</code>', 'The weekly backup could not be taken or verified', 'Low disk space, or disk encryption switched off'],
         ]),
        ('note', 'info',
         "If that machine is off, ORBIT does not stop: the timers inside ORBIT settle "
         "whatever is waiting — marks within 14 days at most, admissions within a week, "
         "logbooks within 14 days — and the prepared task bank tops up streams on Saturdays. "
         "Work is slower and less individually judged until it is back."),
        ('h', 'Backups'),
        ('p', "A copy of ORBIT's data (not uploaded files) is taken weekly on the same machine "
              "and checked before it is kept; the newest four are kept. It contains personal "
              "data and live sign-in sessions, so it stays on an encrypted disk, readable by "
              "its owner only, and out of Time Machine."),
    ]),

    # ================================================================ INTERN
    # The intern manual. Interns are the only people who use ORBIT day to day,
    # and until 2026-09-29 they had no manual at all — only the orientation page.
    # Every fact here is also in scripts/agent/SUPPORT_FAQ.md, which the agent's
    # helpdesk answers from; keep the two in step.

    ("Getting started", [
        ('p', "ORBIT is where your placement happens: your weekly tasks, your submissions "
              "and marks, your logbook if you keep one, and your stream's conversations. "
              "Everything is at <code>orbit2.iih.ng</code>, on a phone or a computer."),
        ('h', 'Signing in'),
        ('steps', [
            'Open <code>orbit2.iih.ng</code>.',
            'Sign in with your email and password — or choose <strong>Send me a magic link instead</strong> and open the link emailed to you. New members have no password yet, so the magic link is how you get in the first time.',
            'Set a password from <strong>Settings</strong> once you are in, so you do not need a new link every time.',
        ]),
        ('note', 'info',
         "Nobody from ORBIT will ever ask you for your password — not the ORBIT Agent, not "
         "staff, not by email."),
        ('h', 'Your home page'),
        ('shot', 'i01-home.png',
         'Home. Your stream’s posts and announcements, and — while you are new — a short '
         '<strong>Your first steps</strong> checklist that disappears once it is done.'),
        ('p', "The menu across the top takes you to <strong>Community</strong>, "
              "<strong>Streams</strong>, <strong>Tasks</strong>, <strong>Logbook</strong>, "
              "<strong>Manual</strong> (how the programme works, with this handbook to read or "
              "download) and <strong>Achievements</strong> (the leaderboard and your badges). "
              "The bell is your notifications; your picture, top right, opens a menu with your "
              "profile, <strong>My Messages</strong> and settings."),
        ('h', 'Who runs ORBIT'),
        ('p', "ORBIT is run by the <strong>ORBIT Agent</strong>, an automated assistant. It "
              "writes each week's tasks, marks your work, reviews your logbook and answers "
              "your messages. When something says it was done by the ORBIT Agent, that is "
              "what it means — there is no person behind it, and it will tell you so if you "
              "ask."),
    ]),

    ("Your weekly tasks", [
        ('p', "Every week your stream gets new tasks, written by the ORBIT Agent for that "
              "stream. You get one message listing them when they are published."),
        ('shot', 'i02-tasks.png',
         'Tasks. Each card shows the stream, the points it is worth and how long is left.'),
        ('bullets', [
            '<strong>Pick the ones you want</strong> and complete <strong>at least two each week</strong>. Points add up, so doing more earns more.',
            '<strong>Deadlines</strong> fall at the end of the week — Thursday at 23:59 (WAT) for the current cohort. The task page shows each task’s exact deadline.',
            'Each task says <strong>how to hand it in</strong>: a written answer, a link, or a file.',
        ]),
        ('h', 'Taking a task on'),
        ('steps', [
            'Open the task and read the whole brief — it says what to do, what to hand in, and what good looks like.',
            'Press <strong>Accept Task</strong>.',
        ]),
        ('shot', 'i03-task-accept.png', 'A task you have not started yet.'),
    ]),

    ("Handing in your work", [
        ('shot', 'i04-task-submit.png',
         'The submission form, once you have accepted a task.'),
        ('steps', [
            'Open the task you accepted.',
            'Write your answer, paste your link, or choose your file — whichever the task asks for.',
            'Press <strong>Submit Task</strong>.',
        ]),
        ('h', 'Links must open for anyone'),
        ('p', "Your work is marked by reading it, so a link has to open <strong>without "
              "signing in</strong>. For Google Docs, Sheets, Slides or Drive: "
              "<strong>Share → General access → Anyone with the link → Viewer</strong>."),
        ('note', 'care',
         "Folders, private GitHub repositories, Notion, Canva and Figma links usually cannot "
         "be read. A PDF, a Word document, or a public link is the safest way to hand work in."),
        ('h', 'Changing what you handed in'),
        ('p', "You can change a submission <strong>until it is marked</strong> — even after "
              "the deadline. Open the task and press <strong>Edit submission</strong>, make "
              "your change, and press <strong>Update Submission</strong>."),
        ('shot', 'i05-task-edit.png',
         'A submission waiting to be marked, with <strong>Edit submission</strong> beneath it.'),
        ('note', 'info',
         "Once a task’s deadline has passed you cannot <em>start</em> it, but anything you "
         "already submitted can still be edited, and work that was returned to you can still "
         "be resubmitted."),
    ]),

    ("How your work is marked", [
        ('p', "Two independent automated markers read each submission against the task’s "
              "brief and must agree on a score; if they do not, a third reads it. Marking "
              "usually happens within a few days, and can take longer just after a Thursday "
              "deadline, when everyone submits at once."),
        ('shot', 'i06-task-feedback.png',
         'A marked submission: your score, and feedback that says what worked and what would '
         'raise the mark.'),
        ('table',
         ['What you see', 'What it means'],
         [
             ['<strong>Approved</strong> with a score and feedback', 'Marked. The points are added to your total.'],
             ['<strong>Changes requested</strong>', 'The markers agreed the work does not answer this task — usually because it was meant for a different one. Read the feedback, then fix it and submit again.'],
             ['A notification that your work <strong>could not be opened</strong>', 'Usually a link that asks for a sign-in. Fix the sharing, or edit the submission. Links are tried again once a day, up to four times.'],
             ['<strong>Approved automatically</strong>, “not individually assessed”', 'The markers could not read it or could not agree, so after five days you were given the full points rather than left waiting.'],
         ]),
        ('note', 'care',
         "A submission with no work in it — just “done” or “please check” — is never approved "
         "automatically. Resubmit it with the work itself."),
        ('p', "Marks are final once given. There is no one to appeal to, so the best way to a "
              "better mark is the feedback on this one."),
    ]),

    ("Points, levels and badges", [
        ('p', "Every approved submission earns points. Points raise your <strong>level</strong>, "
              "and <strong>badges</strong> are awarded automatically for milestones — your "
              "first completed task, crossing a points threshold, and more."),
        ('shot', 'i07-leaderboard.png',
         'The leaderboard, under <strong>Achievements</strong>, ranks interns by points.'),
        ('shot', 'i08-badges.png', 'Your badges, and the ones still to earn.'),
    ]),

    ("Your logbook", [
        ('p', "SIWES students keep a logbook, because your institution will inspect it. "
              "If your programme does not keep one you will only see "
              "<strong>Attendance</strong> here — checking in when you come to the Hub."),
        ('shot', 'i09-logbook.png', 'The logbook: daily logs, weekly summaries and attendance.'),
        ('h', 'Daily logs'),
        ('steps', [
            'Open <strong>Logbook</strong> and add a log for the day.',
            'Describe the work you actually did, what you learned and anything that got in the way. Short and plain is fine — it has to be real.',
            'Submit it. The ORBIT Agent reviews it; it is sent back only if it does not describe any real work, and you can edit and resubmit.',
        ]),
        ('h', 'Weekly summaries'),
        ('p', "At the end of each week, write a short summary. It is signed off by the ORBIT "
              "Agent once the week is over, at least one of that week’s daily logs is "
              "approved, and none is still waiting or sent back. A nearly empty summary is "
              "returned for you to fill in."),
        ('note', 'info',
         "Your SIWES acceptance letter was attached to your acceptance email as a PDF. "
         "Keep it — it is what your institution asks for."),
    ]),

    ("Getting help", [
        ('p', "Message the <strong>ORBIT Agent</strong> from <strong>My Messages</strong> (open "
              "the menu under your picture, top right) with "
              "any question about ORBIT — why a submission has not been marked, how to share "
              "a link, when tasks are due. It answers from how ORBIT actually works and from "
              "your own record, so it can tell you, for example, exactly why a link could not "
              "be opened."),
        ('shot', 'i10-messages.png', 'A message from the ORBIT Agent, with the box to reply. '
                                     '(In the test environment its account has a different name.)'),
        ('note', 'care',
         "The agent cannot change a mark, extend a deadline, make an exception, or pass your "
         "message to a person — those do not exist in ORBIT. It will say so rather than "
         "promise something that will not happen."),
        ('h', 'Notifications'),
        ('p', "Marks, returned work, new tasks, logbook reviews and replies all arrive as "
              "notifications, and most also as an email."),
        ('shot', 'i11-notifications.png', 'Notifications. Open one to go straight to what it is about.'),
    ]),

    ("Your profile and settings", [
        ('p', "<strong>Settings</strong> is where you set or change your password and choose "
              "which notifications you receive by email. Your profile — photo, bio, skills — "
              "is what other members see."),
        ('shot', 'i12-settings.png', 'Settings.'),
    ]),
]


# ---------------------------------------------------------------------------
# WHO EACH SECTION IS FOR
#
# A supervisor (moderator) reaches only their own streams: the interns on them,
# those interns' submissions and logbooks, and the task proposals awaiting their
# approval. Admissions, letters, placement, accounts, email and settings are all
# admin work — a supervisor has no route to any of them, so putting those
# sections in their manual describes buttons they will never find and invites
# them to go looking for permissions they should not have.
#
# Keyed by title rather than index so reordering SECTIONS cannot silently
# reassign an audience. `roles_for` raises on an unknown title.
# ---------------------------------------------------------------------------
SECTION_ROLES = {
    "How ORBIT runs itself":                       ("admin", "moderator"),
    "Signing in and what you can see":            ("admin", "moderator"),
    "Admissions: reading and approving applications": ("admin",),
    "Acceptance letters":                          ("admin",),
    "Placement and conversion":                    ("admin",),
    "Streams and tasks":                           ("admin", "moderator"),
    "Reviewing submissions":                       ("admin", "moderator"),
    "Logbook and attendance sign-off":             ("admin", "moderator"),
    "Users, accounts and settings":                ("admin",),
    "Task proposals: work the agent drafts":       ("admin", "moderator"),
    "Email: logs, holds, and why nothing arrived": ("admin",),
    "Settings":                                    ("admin",),
    "Keeping an eye on the agent":                 ("admin",),
    # The intern manual — its own document, not a subset of the staff one.
    "Getting started":                             ("intern",),
    "Your weekly tasks":                           ("intern",),
    "Handing in your work":                        ("intern",),
    "How your work is marked":                     ("intern",),
    "Points, levels and badges":                   ("intern",),
    "Your logbook":                                ("intern",),
    "Getting help":                                ("intern",),
    "Your profile and settings":                   ("intern",),
}


def roles_for(title):
    """The roles a section belongs to. Raises rather than guessing."""
    try:
        return SECTION_ROLES[title]
    except KeyError:
        raise KeyError(
            f"Section {title!r} has no entry in SECTION_ROLES. Add one — a section "
            f"with no declared audience would silently vanish from every manual."
        )


def sections_for(role):
    """SECTIONS filtered to one role, in the original order."""
    return [(t, b) for (t, b) in SECTIONS if role in roles_for(t)]

