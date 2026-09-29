import { describe, it, expect } from 'vitest';

/**
 * What the email pause screen is allowed to say.
 *
 * There are two independent brakes — the Settings toggle and the EMAIL_PAUSED
 * environment variable — and the screen got this wrong twice. First it reported
 * only the setting, so an environment-paused deployment claimed mail was
 * sending normally. Then, with both on, its button still said "Resume sending"
 * for an action that cannot resume anything.
 *
 * The rules are reproduced here as the pure functions the screen uses, so all
 * four combinations are pinned rather than checked by eye on whichever one
 * production happens to be in.
 */

/** What `emailDispatch.status` computes. */
function statusOf(setting: boolean, env: boolean) {
  return { paused: setting || env, pausedBySetting: setting, pausedByEnv: env };
}

/** What the button in OperationsSettings says. */
function buttonLabel(s: { pausedBySetting: boolean; pausedByEnv: boolean }): string {
  if (!s.pausedBySetting) return 'Pause all email';
  return s.pausedByEnv ? 'Remove Settings pause' : 'Resume sending';
}

describe('email pause: both brakes', () => {
  it('is paused if EITHER brake is on', () => {
    expect(statusOf(false, false).paused).toBe(false);
    expect(statusOf(true, false).paused).toBe(true);
    expect(statusOf(false, true).paused).toBe(true);
    expect(statusOf(true, true).paused).toBe(true);
  });

  /**
   * The state production sat in: held by the environment, with the setting off.
   * The screen must not call that "sending normally".
   */
  it('reports environment-only pauses as paused', () => {
    const s = statusOf(false, true);
    expect(s.paused).toBe(true);
    expect(s.pausedBySetting).toBe(false);
    // …and the button offers to pause, because that is all it can do here.
    expect(buttonLabel(s)).toBe('Pause all email');
  });

  it('never offers to "resume" what it cannot resume', () => {
    // Both on: removing the setting leaves the deployment brake holding.
    expect(buttonLabel(statusOf(true, true))).toBe('Remove Settings pause');
    // Setting only: resuming genuinely resumes.
    expect(buttonLabel(statusOf(true, false))).toBe('Resume sending');
  });

  it('offers to pause when nothing is holding it', () => {
    expect(buttonLabel(statusOf(false, false))).toBe('Pause all email');
  });
});
