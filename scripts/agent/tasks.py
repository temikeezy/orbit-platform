#!/usr/bin/env python3
"""
The ORBIT agent's weekly task writing.

For every active stream with nothing live (agentTasks.streamsNeedingTasks):
  1. sonnet drafts five tasks against the bank's content rules, shown three of
     the stream's bank tasks as examples and the stream's recent titles so it
     does not repeat them;
  2. codex luna vets EACH task independently — safe, doable virtually from
     public material, and gradeable from what is submitted — and drops any that
     fail;
  3. the survivors are published by agentTasks.publishAgentTasks, which prices
     them with the same complexity rules as a supervisor's form.

The vetting step is the review that lib/taskSeed.ts says is "not optional": the
first unreviewed bank had students fuzzing production systems and dismantling
powered equipment. A stream whose drafts mostly fail vetting publishes nothing
this cycle and is picked up again next cycle — or by the bank fallback on
Saturday — rather than receiving something unvetted.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from assess import ask_claude, ask_luna, convex, first_json  # noqa: E402

MIN_SURVIVORS = 2

DRAFT = """You write weekly tasks for interns at Ilorin Innovation Hub's ORBIT programme
(Nigeria). Interns are students, graduates and corps members, working virtually.

Write FIVE new tasks for the stream below. Every task must:
- be doable virtually, from publicly available material, in a few hours to a few days
- teach a real, practical skill for this stream
- produce something a marker can judge from the submission alone
- be SAFE and LEGAL: never test, scrape, fuzz or submit data to anyone's live
  system; never contact businesses or members of the public; never handle
  powered equipment, money or personal data; never require paid tools
- not repeat or closely resemble any title in RECENT TITLES
- vary in size: one small, three medium, one larger

Write each description as the brief an intern reads: what to do, what to hand
in, and what good looks like. 60-160 words. submissionType is "text" (written
answer), "link" (a public URL), or "file" (an upload such as a PDF or image).

Reply with ONLY a JSON object, no prose and no code fence:
{"tasks": [{"title": "...", "description": "...", "submissionType": "text"|"link"|"file"}, ...]}
"""

VET = """You are vetting one task before it is published to interns at an internship
programme. Interns work virtually and are marked only on what they submit.

Answer "keep" only if ALL hold:
- safe and legal: no testing/scraping/submitting to live systems, no contacting
  businesses or the public, no powered equipment, money or personal data
- doable virtually from public material without paid tools
- gradeable: a marker could judge the submission against the brief
- the brief is clear about what to hand in

Reply with ONLY a JSON object, no prose and no code fence:
{"verdict": "keep" | "drop", "reason": "<one sentence>"}
"""


def draft_for(stream):
    prompt = (
        DRAFT
        + "\n\nSTREAM: " + stream["name"]
        + ("\nABOUT THE STREAM: " + stream["description"] if stream["description"] else "")
        + "\n\nEXAMPLES OF GOOD TASKS FOR THIS STREAM:\n" + json.dumps(stream["exemplars"], indent=2)
        + "\n\nRECENT TITLES (do not repeat):\n" + "\n".join("- " + t for t in stream["recentTitles"])
    )
    reply = ask_claude(prompt, "sonnet")
    tasks = (reply or {}).get("tasks")
    return [t for t in tasks if isinstance(t, dict)] if isinstance(tasks, list) else []


def keep(task):
    reply = ask_luna(VET + "\n\nTASK:\n" + json.dumps(task, indent=2))
    return (reply or {}).get("verdict") == "keep", (reply or {}).get("reason", "no answer")


def valid(task):
    return (
        isinstance(task.get("title"), str)
        and isinstance(task.get("description"), str)
        and task.get("submissionType") in ("text", "link", "file")
    )


def main():
    dry = "--dry" in sys.argv
    limit = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 50
    need = convex("agentTasks:streamsNeedingTasks", {}) or {}
    if not need.get("allowed"):
        print(json.dumps({"skipped": need.get("reason", "not allowed")}))
        return 0
    report = []
    for stream in need.get("streams", [])[:limit]:
        try:
            report.append(write_for(stream, dry))
        except Exception as e:  # one stream's failure must not stall the rest
            report.append({"stream": stream["name"], "error": str(e)[:300]})
    print(json.dumps({"streams": len(report), "dryRun": dry, "report": report}, indent=2))
    return 0


def write_for(stream, dry):
    """Draft, vet and (unless dry) publish one stream's tasks."""
    drafted = [t for t in draft_for(stream) if valid(t)]
    vetted, dropped = [], []
    for t in drafted:
        ok, why = keep(t)
        (vetted if ok else dropped).append({"title": t["title"], "why": why} if not ok else t)
    entry = {"stream": stream["name"], "drafted": len(drafted), "kept": len(vetted),
             "dropped": dropped}
    if len(vetted) >= MIN_SURVIVORS and not dry:
        entry["result"] = convex("agentTasks:publishAgentTasks", {
            "streamId": stream["streamId"],
            "tasks": [{k: t[k] for k in ("title", "description", "submissionType")} for t in vetted],
        })
    elif dry:
        entry["wouldPublish"] = [t["title"] for t in vetted]
    return entry


if __name__ == "__main__":
    sys.exit(main())
