#!/usr/bin/env python3
"""
The ORBIT agent's admissions screening.

It records verdicts and never admits anyone itself: `agentAdmissions.admitDue`
in Convex is the single admission path, and it applies lib/admissionRules.ts.
This script's only job is to say, for each application, whether it looks like a
genuine applicant for the programme they chose.

TWO SCREENERS, THE SAME WAY MARKING HAS TWO READERS. Sonnet and Codex luna read
each application independently:
    both admit            -> "admit"      (admitted within minutes)
    both hold             -> "hold"       (never admitted by a timer)
    split                 -> opus breaks it: admit -> "admit", hold -> "contested"
                             ("contested" is admitted after three days)
A missing or unparseable answer is "no-quorum" and retried next cycle — never
read as a hold. Keeping someone out takes two readers agreeing on it.

GENEROUS BY DESIGN. Nearly every application ORBIT has received was genuine, and
the cost of the two errors is not symmetric: admitting a weak applicant costs a
seat in a stream; refusing a genuine one costs a person their placement. The
prompt says so.

The screeners never see a name, email, phone number, matric number or document:
`pendingForScreening` does not return them.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from assess import ask_claude, ask_luna, convex  # noqa: E402

DEFAULT_BATCH = 10

SCREEN = """You are screening an application to ORBIT, the internship programme of
Ilorin Innovation Hub (Nigeria). Programmes: siwes (students on industrial
training), internship, nysc (corps members), volunteer.

Decide only whether this is a GENUINE applicant for the programme they chose.
Be generous: admit unless the application is clearly one of these:
- spam, a test entry, gibberish, or copy-pasted filler with no real content
- abusive or offensive content
- plainly ineligible for the chosen programme (e.g. siwes with no institution
  and no course of study)
Short, plain or poorly written applications are NOT reasons to hold — many
genuine applicants write little. Missing optional fields are not a reason.

Reply with ONLY a JSON object, no prose and no code fence:
{"decision": "admit" | "hold", "reason": "<one sentence>"}
"""


def prompt_for(row):
    fields = {k: row[k] for k in (
        "programmeType", "institutionName", "courseOfStudy", "levelOrYear",
        "trackInterests", "skillsSummary", "motivation", "hasPortfolio",
        "hasSiwesLetter", "siwesStartDate", "siwesEndDate",
    )}
    return SCREEN + "\n\nAPPLICATION:\n" + json.dumps(fields, indent=2)


def verdict(reply):
    d = (reply or {}).get("decision")
    return d if d in ("admit", "hold") else None


def decide(a, b, c_fn):
    """(outcome, reason). Pure apart from `c_fn`; see test_admit.py."""
    va, vb = verdict(a), verdict(b)
    if va is None or vb is None:
        return ("no-quorum", "a screener gave no usable answer")
    if va == vb:
        return (va, (a or {}).get("reason", ""))
    c = verdict(c_fn())
    if c is None:
        return ("no-quorum", "the tie-break gave no usable answer")
    if c == "admit":
        return ("admit", "two of three screeners admitted")
    return ("contested", "screeners split; tie-break held")


def main():
    batch = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_BATCH
    dry = "--dry" in sys.argv
    res = convex("agentAdmissions:pendingForScreening", {"limit": batch}) or {}
    rows = res.get("rows", [])
    tally, log = {}, []
    for row in rows:
        try:
            handle(row, dry, tally, log)
        except Exception as e:  # one bad row must not stall the batch behind it
            tally["error"] = tally.get("error", 0) + 1
            log.append({"id": row.get("applicationId"), "outcome": "error", "reason": str(e)[:300]})
    print(json.dumps({"considered": len(rows), "queueDepth": res.get("queueDepth", 0),
                      "tally": tally, "dryRun": dry, "log": log}, indent=2))
    return 0


def handle(row, dry, tally, log):
    """Screen one application and record the verdict."""
    prompt = prompt_for(row)
    outcome, reason = decide(
        ask_claude(prompt, "sonnet"), ask_luna(prompt), lambda: ask_claude(prompt, "opus")
    )
    tally[outcome] = tally.get(outcome, 0) + 1
    log.append({"id": row["applicationId"], "outcome": outcome, "reason": reason})
    if not dry:
        convex("agentAdmissions:recordScreening", {
            "applicationId": row["applicationId"], "outcome": outcome, "detail": reason,
        })


if __name__ == "__main__":
    sys.exit(main())
