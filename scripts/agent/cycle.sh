#!/bin/zsh
# One turn of the ORBIT agent's unattended operation.
#
# WHY A WRAPPER. launchd starts a bare process with almost no environment: no
# PATH to node, and none of the shell's exported secrets. `zsh` reads ~/.zshenv
# even non-interactively, which is where a shell-exported secret would live —
# so this runs under zsh deliberately rather than being invoked directly by
# launchd. (No script here reads an API key; the claude and codex CLIs use
# their own logins.)
#
# WHY A BOUNDED BATCH. The batch is the blast radius: it is the most marks that
# can be written before the anomaly check at the end of this same cycle reads
# them. An unattended job able to mark the whole cohort in one pass is one bad
# prompt away from doing so, and this cycle already produced twelve wrong marks
# once when it ran unchecked. The interval is a preference; this number is the
# safety property, so raise it deliberately and never to "clear the queue".
#
# WHY EVERYTHING IS INSIDE main(). zsh reads a script as it runs it, so editing
# this file during a cycle (which lasts tens of minutes) made the running copy
# resume at a shifted byte offset and die on "unmatched quote" — it happened on
# 2026-09-29. A function body is parsed in full before its first line executes.
#
# INSTALLED DELIBERATELY. The launch agent lives at
# scripts/agent/ng.iih.orbit-agent.plist (this operator's own; a portable
# template is orbit-agent.plist.example, and systemd examples sit beside it)
# and is copied into ~/Library/LaunchAgents
# by hand. Founder direction 2026-09-29: ORBIT runs without a person operating
# it, so this is now the portal's marker, admissions screener, logbook reviewer
# and task writer. It never acts alone on what it cannot judge: set-aside marks,
# split admissions and split logbook reviews are settled by Convex crons on a
# timer (convex/lib/agentFallback.ts, convex/lib/admissionRules.ts,
# convex/agentSupervision.ts), which also cover this machine being off.

main() {
  set -u
  # Repo root derived from this script's own path (scripts/agent/cycle.sh), so a
  # clone anywhere works. ${(%):-%x} is zsh's path of the running script; bash
  # cannot parse it, so this script needs zsh (as its shebang says).
  local SELF="${(%):-%x}"
  [ -n "$SELF" ] || SELF="$0"
  local ROOT
  ROOT="$(cd "$(dirname "$SELF")/../.." 2>/dev/null && pwd)" || exit 1
  cd "$ROOT" || exit 1

  # Deployment for the backup and anomaly check, matching assess.py's
  # ORBIT_AGENT_DEPLOYMENT: unset or empty means prod, anything else drops
  # --prod. TARGET_NAME keeps a dev export from being filed as a prod backup.
  local CONVEX_TARGET="--prod" TARGET_NAME="prod"
  if [ "${ORBIT_AGENT_DEPLOYMENT:-prod}" != "prod" ]; then
    CONVEX_TARGET=""; TARGET_NAME="${ORBIT_AGENT_DEPLOYMENT}"
  fi
  # It becomes part of a file name below.
  if [[ ! "$TARGET_NAME" =~ '^[A-Za-z0-9_]+$' ]]; then
    echo "!!! ORBIT_AGENT_DEPLOYMENT must be letters, digits or _ (got: $TARGET_NAME)"; exit 1
  fi

  local BATCH="${ORBIT_AGENT_BATCH:-12}"
  local ADMIT_BATCH="${ORBIT_AGENT_ADMIT_BATCH:-15}"
  local LOG_BATCH="${ORBIT_AGENT_LOG_BATCH:-30}"

  # launchd gives no PATH to node, so `npx`, `claude` and `codex` (all installed
  # under fnm) would not resolve. fnm is on the plist's PATH via Homebrew.
  if command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env --shell zsh)"
    fnm use default >/dev/null 2>&1 || true
  fi

  local LOG_DIR="${ORBIT_AGENT_LOG_DIR:-$HOME/.openclaw/workspace/logs/orbit-agent}"
  mkdir -p "$LOG_DIR"
  local STAMP
  STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  echo "=== $STAMP  assess batch=$BATCH ==="
  python3 scripts/agent/assess.py "$BATCH" 2>&1
  local ASSESS_EXIT=$?

  echo "--- admissions screening batch=$ADMIT_BATCH ---"
  python3 scripts/agent/admit.py "$ADMIT_BATCH" 2>&1

  echo "--- logbook review batch=$LOG_BATCH ---"
  python3 scripts/agent/logbook.py "$LOG_BATCH" 2>&1

  # Only does anything for a stream with no live task and nothing written for
  # it this week, so on most cycles it costs a single query.
  echo "--- task writing ---"
  python3 scripts/agent/tasks.py 2>&1

  echo "--- answering messages ---"
  python3 scripts/agent/support.py 2>&1

  # WEEKLY BACKUP. There was none (STATUS.md). Data only — documents and uploads
  # stay in Convex storage — because a backup that fills the disk the runner
  # lives on takes the runner down with it; skipped below 2 GiB free.
  #
  # IT HOLDS LIVE CREDENTIALS: the export includes `sessions` (raw bearer
  # tokens) and personal data for the whole intake. So the folder is owner-only,
  # excluded from Time Machine (a backup disk is not FileVault-encrypted with
  # this one), and this machine's FileVault must stay on — checked below.
  local BACKUP_DIR="${ORBIT_BACKUP_DIR:-$HOME/orbit-backups}"
  mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
  # macOS-only pieces (Time Machine exclusion, FileVault check) skip cleanly
  # elsewhere. On Linux disk encryption cannot be checked from here, so the
  # backup is still taken but the operator is warned.
  local IS_MAC=0
  [ "$(uname -s)" = "Darwin" ] && IS_MAC=1
  if [ "$IS_MAC" = "1" ]; then
    tmutil addexclusion "$BACKUP_DIR" >/dev/null 2>&1 || true
  else
    echo "note: not macOS - Time Machine exclusion skipped; keep $BACKUP_DIR out of unencrypted backups yourself"
  fi
  local LATEST
  LATEST=$(ls -t "$BACKUP_DIR"/orbit-"$TARGET_NAME"-<->.zip(N) 2>/dev/null | head -1)
  local FREE_KB
  FREE_KB=$(df -k "$BACKUP_DIR" | awk 'NR==2 {print $4}')
  if [ -z "$LATEST" ] || [ -n "$(find "$LATEST" -mtime +6 2>/dev/null)" ]; then
    if [ "$IS_MAC" = "1" ] && ! fdesetup status 2>/dev/null | grep -q "FileVault is On"; then
      echo "!!! weekly backup REFUSED: FileVault is off" | tee -a "$LOG_DIR/BACKUP_FAILED"
    elif [ "${FREE_KB:-0}" -le 2097152 ]; then
      echo "!!! weekly backup SKIPPED: under 2 GiB free on $BACKUP_DIR" | tee -a "$LOG_DIR/BACKUP_FAILED"
    else
      echo "--- weekly backup ---"
      if [ "$IS_MAC" != "1" ]; then
        echo "warning: not macOS - cannot verify $BACKUP_DIR is on an encrypted volume; the export holds live session tokens and personal data, so make sure it is (LUKS/dm-crypt or similar)"
      fi
      local OUT="$BACKUP_DIR/orbit-$TARGET_NAME-$(date -u +%Y%m%d).zip"
      # Verified, not assumed: a truncated zip would otherwise become LATEST,
      # suppress the retry for a week, and count as one of the four kept.
      if env -u CONVEX_DEPLOY_KEY npx convex export $CONVEX_TARGET --path "$OUT" >/dev/null 2>&1 \
         && unzip -tq "$OUT" >/dev/null 2>&1; then
        chmod 600 "$OUT"
        echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
        # Keep the newest four. A zsh glob, not ls|xargs: a backup dir with a
        # space in it would split, and <-> (digits only) keeps orbit-prod-* from
        # matching another target's files.
        rm -f -- "$BACKUP_DIR"/orbit-"$TARGET_NAME"-<->.zip(N.om[5,-1])
        rm -f "$LOG_DIR/BACKUP_FAILED"
      else
        rm -f "$OUT"
        echo "!!! weekly backup FAILED at $STAMP" | tee -a "$LOG_DIR/BACKUP_FAILED"
      fi
    fi
  fi

  # The anomaly check runs in the same turn as the marking it checks, so a bad
  # pass is caught by the pass that caused it rather than waiting for Friday. It
  # withdraws flagged LOW marks and sets them aside for settlement at full points
  # (agentOps.setAsideOutlierGroup) — the one correction that cannot hurt anyone.
  echo "--- anomaly check ---"
  env -u CONVEX_DEPLOY_KEY npx convex run $CONVEX_TARGET agentOps:respondToMarkOutliers '{}' 2>&1
  echo

  # assess.py exits 2 when every row failed on our side (a logged-out CLI or an
  # exhausted usage pool). Written to a flag file the next cycle — and anyone
  # reading the log — can see, and to the exit status launchd records.
  if [ "$ASSESS_EXIT" = "2" ]; then
    echo "!!! RUNNER UNHEALTHY at $STAMP — check \`claude\` and \`codex\` logins" | tee -a "$LOG_DIR/UNHEALTHY"
    return 2
  fi
  rm -f "$LOG_DIR/UNHEALTHY"
  return 0
}

main "$@"
exit $?
