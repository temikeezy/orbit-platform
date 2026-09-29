import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * Source with comments removed.
 *
 * These files explain their own history in prose, so `EMAIL_ALLOWLIST` and
 * `EMAIL_SINK` both appear in commentary about what changed and why. A test
 * that greps raw source is reading documentation, not behaviour — and will
 * pass or fail on how a comment was worded.
 */
/** A single export's body — bounded, or the slice runs into the next one. */
const fnBody = (src: string, name: string) => {
  const start = src.indexOf(`export const ${name} =`);
  const next = src.indexOf('export const', start + 10);
  return src.slice(start, next === -1 ? undefined : next);
};

const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

/**
 * A non-production deployment must not be able to send mail.
 *
 * Dev holds real ZeptoMail credentials and no pause. The only thing standing
 * between a test run and a few thousand messages to real `@iih.ng` addresses
 * was `EMAIL_ALLOWLIST` — a guard whose own documentation says to unset it "at
 * cutover, when mail is supposed to reach real users". Anyone unsetting it to
 * try something would have discharged the whole accumulated backlog at once.
 *
 * The property these protect is the direction of the default: production must
 * OPT IN to being affected, rather than having to remember to opt out. Prod has
 * never set EMAIL_SINK, so both the refusal and the purge are inert there.
 */
describe('sink deployments cannot send, and do not hoard', () => {
  const email = read('convex/email.ts');
  const queue = read('convex/emailQueue.ts');
  const crons = read('convex/crons.ts');

  it('refuses at the SMTP boundary, not on individual call paths', () => {
    // Inside assertDeliverable, which every send route passes through — so a
    // targeted drain or a one-off `convex run` is covered too, not just the cron.
    const fn = codeOnly(email.slice(email.indexOf('function assertDeliverable')));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain("process.env.EMAIL_SINK === '1'");
    expect(body).toContain('throw new Error');
  });

  it('refuses before the allowlist is even consulted', () => {
    // Order matters: the allowlist is documented as removable, so the sink
    // check must not sit behind it.
    const fn = codeOnly(email.slice(email.indexOf('function assertDeliverable')));
    const sink = fn.indexOf('EMAIL_SINK');
    const allow = fn.indexOf('EMAIL_ALLOWLIST');
    expect(sink).toBeGreaterThan(-1);
    expect(sink).toBeLessThan(allow);
  });

  it('purges only where the variable is explicitly set', () => {
    const fn = codeOnly(fnBody(queue, 'purgeSink'));
    // The first thing it does is leave, unless opted in. Without this a
    // production pause — mail deliberately held — would be deleted.
    expect(fn).toContain("process.env.EMAIL_SINK !== '1'");
    expect(fn.indexOf("EMAIL_SINK !== '1'")).toBeLessThan(fn.indexOf('ctx.db.delete'));
  });

  it('purges in bounded batches and reschedules', () => {
    const fn = codeOnly(fnBody(queue, 'purgeSink'));
    expect(fn).toContain('take(BATCH)');
    expect(fn).toContain('scheduler.runAfter');
    expect(fn).not.toContain('.collect()');
  });

  it('keeps a window so a developer can still inspect what would have sent', () => {
    // Purging instantly would make the dev queue useless for the one thing it
    // is good for.
    expect(fnBody(queue, 'purgeSink')).toContain('olderThanMinutes');
  });

  it('runs on a schedule rather than waiting to be remembered', () => {
    expect(crons).toContain('purge sink email queue');
    expect(crons).toContain('internal.emailQueue.purgeSink');
  });
});
