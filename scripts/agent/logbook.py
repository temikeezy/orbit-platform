#!/usr/bin/env python3
"""
The ORBIT agent's daily-log review.

A daily log is a short account of one day's work. The question a supervisor
answered was never "is this good" — it was "does this describe real work that
was done", because that is what the logbook certifies for a SIWES student. So
that is the only question asked here:

    both approve               -> "approve"   (approved now, by the ORBIT Agent)
    both request changes       -> "changes"   (returned with the first reviewer's
                                               comment; the intern edits and
                                               resubmits — nothing is lost)
    split                      -> opus: approve -> "approve", changes -> "contested"
                                  ("contested" is approved by the Convex timer
                                  after five days — convex/agentSupervision.ts)
    no usable answer           -> "no-quorum" (retried in six hours)

Returning someone's logbook entry takes two readers agreeing; approving it takes
the ordinary benefit of the doubt. No name, email or identity is sent — the
reviewers see the entry's own fields and nothing else.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from assess import ask_claude, ask_luna, convex  # noqa: E402

DEFAULT_BATCH = 20

REVIEW = """You are reviewing one day's logbook entry from an intern at Ilorin
Innovation Hub's ORBIT programme (many are SIWES students on industrial
training in Nigeria). The logbook certifies that real work was done.

Approve unless the entry clearly fails to describe any real work: empty or
filler text, a copy of the field labels, gibberish, or content unrelated to
work. Brief, plain or informal entries describing real activity SHOULD be
approved — most genuine entries are short.

If you request changes, the comment goes to the intern: one kind, specific
sentence saying what to add.

Reply with ONLY a JSON object, no prose and no code fence:
{"decision": "approve" | "changes", "comment": "<one sentence>"}
"""


def prompt_for(row):
    entry = {k: row[k] for k in (
        "logDate", "title", "workDone", "learned", "toolsUsed", "challenges", "nextSteps", "hoursSpent",
    )}
    return REVIEW + "\n\nENTRY:\n" + json.dumps(entry, indent=2)


def verdict(reply):
    d = (reply or {}).get("decision")
    return d if d in ("approve", "changes") else None


def decide(a, b, c_fn):
    """(outcome, comment). Pure apart from `c_fn`; see test_logbook.py."""
    va, vb = verdict(a), verdict(b)
    if va is None or vb is None:
        return ("no-quorum", "")
    if va == vb == "approve":
        return ("approve", "")
    if va == vb == "changes":
        return ("changes", (a or {}).get("comment", ""))
    c = verdict(c_fn())
    if c is None:
        return ("no-quorum", "")
    return ("approve", "") if c == "approve" else ("contested", "")


def main():
    batch = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_BATCH
    dry = "--dry" in sys.argv
    res = convex("agentSupervision:pendingLogsForReview", {"limit": batch}) or {}
    rows = res.get("rows", [])
    tally, log = {}, []
    for row in rows:
        try:
            handle(row, dry, tally, log)
        except Exception as e:  # one bad row must not stall the batch behind it
            tally["error"] = tally.get("error", 0) + 1
            log.append({"id": row.get("logId"), "outcome": "error", "reason": str(e)[:300]})
    print(json.dumps({"considered": len(rows), "queueDepth": res.get("queueDepth", 0),
                      "tally": tally, "dryRun": dry, "log": log}, indent=2))
    return 0


def handle(row, dry, tally, log):
    """Review one daily log and record the verdict."""
    prompt = prompt_for(row)
    outcome, comment = decide(
        ask_claude(prompt, "sonnet"), ask_luna(prompt), lambda: ask_claude(prompt, "opus")
    )
    tally[outcome] = tally.get(outcome, 0) + 1
    log.append({"id": row["logId"], "outcome": outcome, "comment": comment})
    if not dry:
        convex("agentSupervision:applyLogReview", {
            "logId": row["logId"], "verdict": outcome, "comment": comment,
            "expectUpdatedAt": row["updatedAt"],
        })


if __name__ == "__main__":
    sys.exit(main())
