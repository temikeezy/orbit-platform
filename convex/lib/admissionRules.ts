/**
 * When the admissions fallback may admit without a screening verdict.
 *
 * The screener runs on a machine outside this deployment, so the rule has to
 * cover it being wrong, split, or switched off — none of which may leave a
 * genuine applicant waiting on a person, because there is no longer a person.
 *
 *  - `admit`     — both screeners (or two of three) said admit: admit now.
 *  - `contested` — the screeners split and the tie-break sided with hold:
 *                  admitted after CONTESTED_ADMIT_MS. A split is a reason to
 *                  wait a little, not a reason to refuse; nearly every
 *                  application ORBIT has ever received was genuine.
 *  - `hold`      — both screeners independently said spam or ineligible.
 *                  Never admitted by a timer. This is the one outcome that
 *                  keeps someone out, and it takes two readers agreeing.
 *  - `duplicate` — the same inbox already holds an approved application.
 *                  Admitting again would only re-send an acceptance.
 *  - unscreened  — admitted after UNSCREENED_ADMIT_MS, counted from the
 *                  agent era, so a runner outage delays admissions rather
 *                  than stranding them, and the backlog that predates the
 *                  agent is screened before any timer can reach it.
 */

export const CONTESTED_ADMIT_MS = 3 * 24 * 60 * 60 * 1000;
export const UNSCREENED_ADMIT_MS = 7 * 24 * 60 * 60 * 1000;
export const ADMISSIONS_ERA_START = Date.UTC(2026, 8, 29);

export function admitByFallback(
  outcome: string | undefined,
  screenedAt: number | undefined,
  createdAt: number,
  now: number,
): boolean {
  if (outcome === 'hold' || outcome === 'duplicate') return false;
  if (outcome === 'admit') return true;
  if (outcome === 'contested' && screenedAt !== undefined) {
    return now - screenedAt > CONTESTED_ADMIT_MS;
  }
  return now - Math.max(createdAt, ADMISSIONS_ERA_START) > UNSCREENED_ADMIT_MS;
}
