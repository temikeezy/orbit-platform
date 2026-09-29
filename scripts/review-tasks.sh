#!/usr/bin/env bash
#
# Codex-reviews the task bank BEFORE anything is seeded into a deployment.
#
# This exists because the first 70 proposals went in unreviewed and the review
# afterwards found real problems: tasks that would have had students submitting
# test data to ORBIT's own live application form, fuzzing third-party production
# systems, dismantling powered equipment, and cold-contacting business owners —
# plus several no supervisor could grade, because a lazy submission was
# indistinguishable from a good one.
#
#   ./scripts/review-tasks.sh            # review convex/lib/taskSeed.ts
#   ./scripts/review-tasks.sh <file>     # review some other bank
#
# Read the output and FIX THE BANK before running tasks:seedWeeklyProposals.
set -euo pipefail

BANK="${1:-convex/lib/taskSeed.ts}"
[ -f "$BANK" ] || { echo "No such file: $BANK" >&2; exit 1; }

command -v codex >/dev/null || { echo "codex CLI not found" >&2; exit 1; }

echo "Reviewing $BANK ..." >&2

codex exec --sandbox read-only --skip-git-repo-check <<PROMPT
Review the task bank at $(pwd)/$BANK.

These tasks are proposed to supervisors at Ilorin Innovation Hub and then given
to interns — SIWES students, NYSC members, general interns and volunteers, mostly
Nigerian university students. Work is remote, submitted as text, a link or a file.

Report ONLY problems. No praise.

1. SAFETY AND AUTHORISATION — flag anything that has a student test, fuzz or
   submit data to a production system they do not own, dismantle powered or
   pressurised equipment, contact strangers, scrape, or breach terms of service.
2. ACHIEVABILITY — completable in a week, remotely, on intermittent internet,
   with free tools, no IIH premises, no internal systems, no real client.
3. GRADABILITY — could a supervisor tell a good submission from a lazy one?
   Flag vague deliverables and missing minimum criteria.
4. SUBMISSION TYPE — text / link / file must match the deliverable.
5. POINTS — 1-20 only. Flag anything out of line with its effort.
6. DUPLICATION — across streams, or within one stream.
7. SELF-CONTAINMENT — no task may depend on having done another, since members
   choose freely.
8. CONTEXT — costings need naira, a city and dated public sources; nothing
   written for a US/UK audience.

For each: name the stream and title, one line on the defect, and a concrete
replacement that can be applied directly. Under 700 words.
PROMPT
