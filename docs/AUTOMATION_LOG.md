# ORBIT automation log

Founder direction, 2026-09-29: **ORBIT runs itself.** No person operates the portal; the only human activity is interns doing intern work. This file records each human gate that was removed, what replaced it, and how the change was verified. Newest entries are at the top.

## How the pieces fit

| Where | What | Runs |
|---|---|---|
| This Mac: `scripts/agent/cycle.sh` (launchd `ng.iih.orbit-agent`, every 8h) | The **model calls**: marking (`assess.py`), admissions screening (`admit.py`), daily-log review (`logbook.py`), weekly task writing (`tasks.py`), then the anomaly response | Claude (sonnet/opus) via the Claude Code subscription; `gpt-5.6-luna` via Codex on the ChatGPT subscription |
| Convex crons (`convex/crons.ts`) | Every **decision rule, timer and fallback**: admitting (`agentAdmissions.admitDue`), settling marks (`tasks.autoReviewStaleSubmissions` with `agentFallback`), settling logbooks (`agentSupervision.settleLogbook`), bank-seeded tasks (`tasks.seedWeeklyProposals`), anomaly backstop | Always, on Convex |

The split matters. The subscriptions can only be used from this machine, so the models run here. Everything that must happen *regardless* of whether this machine is on lives in Convex, which means an outage **delays** work but never leaves it waiting for a person:

- Marks: set-aside work settles 5 days after it was set aside; anything at all settles 14 days after `max(submitted, 2026-09-29)` (`convex/lib/agentFallback.ts`).
- Admissions: split verdicts admit after 3 days; unscreened applications admit after 7 days (`convex/lib/admissionRules.ts`).
- Logbooks: split reviews approve after 5 days; anything after 14 days; weeks sign off once no daily log in them is waiting (`convex/agentSupervision.ts`).
- Tasks: the Saturday cron seeds from the fixed bank for any stream the agent did not write for.

Every agent decision names the **ORBIT Agent** (`orbit.agent@iih.ng`) as reviewer, signatory or author, and every message to an intern says the agent made it.

**Health signal.** `assess.py` exits 2, and `cycle.sh` writes `~/.openclaw/workspace/logs/orbit-agent/UNHEALTHY`, when every row in a cycle failed on our side (for example a logged-out CLI or an exhausted usage pool). Logs are in the same directory (`cycle.out.log`, `cycle.err.log`).

## 2026-09-29

### First full unattended cycle — verified

launchd, 03:04–03:27 UTC, exit code 0, no health flags. Checked against the prod records rather than the log:
- **Marking:** 7 approved (scores 5–9); the feedback engages the actual work. 5 set aside (4 unsupported formats, 1 unreadable).
- **Admissions:** 15 screened; 13 admitted, converted and placed across several streams (the balanced placement works); 2 recognised as duplicates.
- **Logbook:** 29 daily logs approved by the ORBIT Agent; 1 contested, which the 5-day timer settles.
- **Task writing and support:** correctly did nothing. All streams have live tasks, and no messages are pending.
- **Backup:** correctly skipped, since today's verified backup is under a week old.
- **Anomalies:** none flagged.
- **Email out via ZeptoMail:** 13 `application_approved`, 7 `submission_approved`, 21 `new_task` digests for the new admits.
- Also today: the frontend was deployed via the Netlify API (build `f8a8761`), and the Edit submission strings were confirmed in the served bundle. The e2e suite was repaired: 202 passed, 0 failed.


### Found while doing this

- **Interns had no live tasks.** The latest deadline on any prod task was 2026-09-24. Weekly seeding was a manual step, and the bank it seeds from repeats the same five titles per stream.
- **No stream was attached to a track on prod.** `tracks.attachStream` had never been run, so a first-choice placement had nowhere to go. The first 13 agent admissions converted with no stream. Fixed by attaching all 14 streams to their tracks as the ORBIT Agent (through `tracks.attachStream`, which also sets up lead grants) and placing those 14 admits (one more arrived meanwhile) in the least-loaded stream of their first-choice track.
  - Mapping: engineering → Telecoms, Mechanical/Automobile, Special/Emerging. Entrepreneurship → E&I Support. Operations → Admin & Task Support. Research → Research & Documentation. Programmes & community → Event Coordination, E-Learning. Design, media & content → Social Media, Graphic Design & Animation, Writing & Storytelling. Software & product → Software Engineering, Product Testing, Blockchain & Web3.
- **A mark of 0 dead-ended.** An intern who uploaded work for the wrong task was marked 0 as `approved`, and approved rows cannot be resubmitted. Zero marks now go back to the intern as `changes_requested` (`tasks.returnForChanges`).
- **Editing `cycle.sh` mid-cycle broke the running copy** (zsh reads scripts incrementally). The body now sits inside `main()`.

### Marking (commit f1a43b5)

- Before: the runner read text submissions only (20 of 225 pending), and set disagreements aside "for a person". It was not installed.
- After: every evidence type is read (`evidence.py`). Two readers, with opus as tie-break. Set-asides are recorded, and the intern is told once when they can fix something. The fallback settles on a timer. Anomaly flags withdraw the flagged low marks and set them aside.
- Review: a Fable review returned 9 findings, all verified and fixed (commit message has the detail).
- Verified: dry run on prod (4 rows); then the first live cycle (12 rows): 5 marked by agreement (8, 6, 6, 8, 0 — the 0 was wrong-task work, see above), 7 correctly set aside (video, 404s, sign-in walls, an app shell). 5 review emails sent.

### Admissions (commit f1a43b5)

- Before: 35 applications had sat in `submitted` for a month.
- After: two-model screening, and `admitDue` is the single admission path.
- Verified: dry run on 5, then live. 14 admitted, 14 accounts converted, 14 acceptance emails sent via ZeptoMail (`application_approved` / `sent`), 1 `no-quorum` to retry.

### Cohorts, support, editing submissions, backups (batch 3)

- **Cohort rollover** (`agentCohorts.rollover`, daily; rules in `lib/cohortRollover.ts`). Before: the only cohort ends 2026-11-06, and everything keys off the newest active cohort, so task creation and enrolment would have stopped the day after. After:
  - the next cohort opens as a draft 21 days before the current one ends, starting the Monday after, with the same length and rhythm;
  - the draft is activated on its start date and the old cohort is completed;
  - admissions in the final fortnight enrol into the incoming cohort.
- **Support responder** (`agentSupport.ts` + `support.py`, grounded in `scripts/agent/SUPPORT_FAQ.md`). Before: intern messages to the ORBIT Agent were answered by a person driving the account. After:
  - sonnet drafts a reply from the fact sheet and the intern's own state;
  - luna fails any unsupported claim or non-existent promise;
  - a failed draft is redrafted once; if that also fails, a safe fallback reply is sent.
  - Verified on a realistic message that included an injected instruction: the reply named the actual cause (a sign-in wall), gave the fix, refused the deadline extension honestly, and ignored the injection.
- **Edit submission** (`TaskDetailPage`). Before: interns could not change work once submitted, even though the server allowed it. Two interns reported this through the bug button, and the agent's own "reshare your link" messages depended on it. After: an **Edit submission** button on pending work, which also works after the deadline. Component test added.
- **Weekly backup** in `cycle.sh`: a data-only `convex export --prod` to `~/orbit-backups` (owner-only permissions), keeping the newest four. It skips itself below 2 GiB free, because the disk is at 98%. First backup taken: 4.4 MB.
- **Opus 5.5 review: 12 findings, all fixed.**
  - **HIGH:** returned work could not be resubmitted after the deadline. The form now ignores the deadline for `changes_requested` work (test added).
  - **HIGH:** when no model answered, every pending message got the canned reply and was then treated as answered. The fallback now applies only to a draft that failed its check; no answer means a retry next cycle.
  - Rollover left every weekend with no active cohort. An ended cohort now completes only once its successor has started.
  - `reply` refuses when the intern wrote again mid-draft.
  - SIWES interns whose placement outlives the cohort carry over to the successor.
  - `pendingConversations` memoises per-stream counts.
  - Backup is Time-Machine-excluded, FileVault-gated, verified with `unzip -t`, and failures are flagged.
  - Fact-sheet claims corrected: 23:59 deadline, password or magic link, retry is 4×, editing restarts settlement, empty work never settles, no "Report a bug reaches a person".
  - Only agent-created drafts are activated.
  - The conversation goes to the models as JSON.
  - The edit form has Cancel and an "Update Submission" label.
- **Known flake (pre-existing, untouched):** `TaskProposalsPage.test.tsx` "disables the button while a request is in flight" fails about 1 run in 3, even in isolation.
- **Error reports**: 756 open, never triaged. 679 are masked "Server Error"s, mostly `requireUser` throwing on sessions that expired mid-use (for example the live `unreadCount` subscription). That is noise rather than a blocker, and recorded as a follow-up. The intern-written reports among them led to the Edit submission fix.

### Logbook supervision, task writing, zero-return (this batch)

- Before: 180 daily logs and 27 weekly summaries on prod, never reviewed. No task live since 2026-09-24.
- After: `agentSupervision.ts` + `logbook.py`, and `agentTasks.ts` + `tasks.py` (with `seedWeeklyProposals` as the Saturday fallback, now skipping streams that already have work).
- Verified on dev: the task-drafting dry run kept 4 of 5, dropping 1 for an inconsistent hand-in format.
- **Live on prod (2026-09-29):** all 14 streams got this week's tasks. 70 were drafted, 60 kept after vetting, and 60 published. All are due 2026-10-08 22:59 UTC, because this week's Thursday was under three days away. Points range 6–14 from the complexity rules. Each intern got one digest per stream (`new_task`, 372 queued and draining).
- **Opus 5.5 review: 13 findings.** 11 fixed. #8 (`tasks.py` not wired) was already fixed by the `cycle.sh` rewrite. #11 (the sheet mirror) does not apply: the mirror is disconnected in `crons.ts`. What was fixed:
  - **HIGH:** `claude -p` ran in the repo with the user's tools and MCP connectors live, while reading untrusted text. Every model call now runs with `--tools "" --strict-mcp-config` (image marking gets `Read` only, confined to the image's folder) in an empty temp directory; Codex also runs from that directory. Verified with a canary: an injected "touch a file / read ~/.zshenv" did neither.
  - A failed re-screen (`no-quorum`) could erase a `hold` and let the unscreened timer admit within the hour. A verdict is now never replaced by a failed attempt.
  - Admissions scan newest-first, so held or duplicate rows cannot starve new applications.
  - Placement load counts approved-but-unconverted applicants and updates within a run, so a batch no longer lands in one stream.
  - Duplicates are checked against existing accounts and computed canonical addresses.
  - Weekly sign-off requires the week to be over, at least one approved log, and nothing waiting or returned (unless two weeks overdue). A week with no approved log is never signed off by a timer.
  - The Saturday seeder's deadline no longer skips a week.
  - Routine agent approvals notify in-app only, and new tasks are announced as one digest per member, not one email per task.
  - A zero is returned for changes only when every reader behind it gave zero.
  - The publish re-checks that the stream still needs tasks.
  - Read windows are bounded, and one bad row no longer stops a batch.
