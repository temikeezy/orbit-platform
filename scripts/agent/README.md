# ORBIT agent runner

`cycle.sh` is one turn of ORBIT's unattended operation. Run it on a schedule (every 8 hours in the reference deployment) on a machine where the `claude` and `codex` CLIs are logged in.

ORBIT does **not need** the runner to work. See "Running without the runner" below.

Background: the "The portal runs itself" section of `CLAUDE.md` and `docs/AUTOMATION_LOG.md` (design, gates removed, verification).

## What one cycle does

In order, all through `npx convex run` against your Convex deployment:

1. `assess.py` marks pending task submissions. Claude sonnet and OpenAI `gpt-5.6-luna` (via Codex) each read the work. If they disagree beyond a tolerance, Claude opus is the third reader. Contested or unreadable work is set aside, never averaged.
2. `admit.py` screens new applications.
3. `logbook.py` reviews daily logbook entries.
4. `tasks.py` writes the week's task for any stream with no live task.
5. `support.py` answers pending intern messages (see `SUPPORT_FAQ.md`).
6. Weekly backup: `convex export` to a zip, verified with `unzip -t`, newest four kept. Skipped when under 2 GiB is free.
7. Anomaly check: `agentOps:respondToMarkOutliers` withdraws flagged low marks and sets them aside.

Everything is posted as the ORBIT Agent account, and every decision names it.

## Prerequisites

- **Node and the Convex CLI** (`npx convex`), logged in to YOUR project (`npx convex login`; `npx convex dev` links the repo). Do not leave a stale `CONVEX_DEPLOY_KEY` in the environment; the scripts unset it.
- **`claude` CLI** (Claude Code), logged in. Used with `sonnet` and `opus`.
- **`codex` CLI**, logged in to a ChatGPT account. Used with `gpt-5.6-luna`.
- **`python3`** (standard library only) and **`zsh`** (`cycle.sh` is a zsh script).
- An ORBIT Agent account and MCP credentials on the deployment (`MCP_CREDENTIALS`, `MCP_SECRET_<NAME>`, `MCP_ACTOR_<NAME>`; see `.env.example`).

These CLIs are how the runner reaches the models; there is no API key to configure. If a CLI is logged out or its usage pool is exhausted, every row fails on our side and the cycle reports unhealthy (below).

## Running without the runner

Convex crons hold every rule, timer and fallback (`convex/crons.ts`, `convex/lib/agentFallback.ts`, `convex/lib/admissionRules.ts`, `convex/agentSupervision.ts`). Without the runner, marks, admissions and logbooks are still settled on their timers and weekly tasks are seeded from the fixed bank. You lose only the individual judgement; nothing waits for a person. Note the defaults in those files are the reference operator's policy: read them before relying on them.

## Install on macOS (launchd)

1. `cp scripts/agent/orbit-agent.plist.example ~/Library/LaunchAgents/org.example.orbit-agent.plist`
2. Replace every `REPLACE_WITH_*` placeholder (repo path, log dir) and make sure `PATH` includes your node, `claude` and `codex` locations. Change the `Label` and file name to match.
3. `mkdir -p <log dir>`, then `launchctl load ~/Library/LaunchAgents/org.example.orbit-agent.plist`.
4. Test one cycle now: `launchctl start org.example.orbit-agent`, then read the logs.

`ng.iih.orbit-agent.plist` is the reference operator's own file; do not install it as-is.

## Install on Linux (systemd)

See the header of `orbit-agent.service.example`. In short, copy the `.service` and `.timer` examples to `~/.config/systemd/user/`, edit the placeholders, then `systemctl --user enable --now orbit-agent.timer` and `loginctl enable-linger $USER`.

On Linux the FileVault and Time Machine steps are skipped. Disk encryption cannot be checked from the script, so it logs a warning and still takes the backup. **Put `ORBIT_BACKUP_DIR` on an encrypted volume:** the export contains live session tokens and personal data.

## Dry run

Nothing is written when `--dry` is passed to a stage script. Point it at dev, and run it from anywhere (paths derive from the script location):

```bash
ORBIT_AGENT_DEPLOYMENT=dev python3 scripts/agent/assess.py 1 --dry
```

`admit.py`, `logbook.py`, `tasks.py` and `support.py` accept `--dry` the same way. Dry runs still call the models, so they use CLI quota. Run the unit tests with `python3 -m unittest discover -s scripts/agent -p 'test_*.py'`.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `ORBIT_AGENT_DEPLOYMENT` | `prod` | `prod` targets the production deployment (`--prod`); anything else (use `dev`) targets your dev deployment. Applies to the stages, the backup and the anomaly check. |
| `ORBIT_AGENT_BATCH` | `12` | Marks per cycle. This is the blast radius of a bad pass: raise it deliberately, never "to clear the queue". |
| `ORBIT_AGENT_ADMIT_BATCH` | `15` | Applications screened per cycle. |
| `ORBIT_AGENT_LOG_BATCH` | `30` | Logbook entries reviewed per cycle. |
| `ORBIT_AGENT_LOG_DIR` | `$HOME/.openclaw/workspace/logs/orbit-agent` | Where the health flag files are written. |
| `ORBIT_BACKUP_DIR` | `$HOME/orbit-backups` | Backup zips (mode 700, files 600). |

Note that "prod" here means whichever deployment `npx convex run --prod` resolves to for your logged-in project.

## Health flags

Both are files in `ORBIT_AGENT_LOG_DIR`. Look for them in monitoring.

- `UNHEALTHY`: `assess.py` exited 2 because every row failed on our side (logged-out `claude`/`codex`, or exhausted usage). The cycle returns exit status 2. Cleared by the next healthy cycle.
- `BACKUP_FAILED`: the weekly backup was refused (FileVault off, macOS only), skipped (low disk) or failed verification. Cleared by the next successful backup.

## Editing while installed

`cycle.sh` keeps all logic inside `main()` on purpose: zsh reads a script as it runs, so editing the file mid-cycle used to crash the running copy. Keep that structure.
