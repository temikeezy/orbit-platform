import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MAX_SELF_JOINED_STREAMS } from '../../../convex/streams';

const root = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
/**
 * A function's CODE, with comments stripped.
 *
 * These files explain their own history in prose, so `leaveOtherStreams` and
 * `.collect()` appear in comments describing what no longer happens. A test that
 * greps raw source fails on its own documentation.
 */
const fn = (src: string, name: string) => {
  const start = src.indexOf(`export const ${name} =`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = src.indexOf('export const', start + 10);
  const body = src.slice(start, next === -1 ? undefined : next);
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
};

/**
 * Interns may belong to more than one stream.
 *
 * The old rule was one active stream each, enforced by ending every other
 * membership before starting a new one. Its stated reasons — counted twice, on
 * two rosters, notified twice — are all still true; they are simply what
 * belonging to two streams means, and each is now correct rather than a bug.
 *
 * The rule also had a destructive edge nobody intended. Placing someone in a
 * stream SILENTLY REMOVED them from their others, so a duplicate applicant
 * whose second application converted with no stream assigned had the membership
 * their first application created deactivated, and got nothing in its place.
 * Four interns were found in exactly that state, signed in to an empty task
 * list with nothing explaining why. These tests exist so that cannot return.
 */
describe('an intern can hold several streams', () => {
  const streams = read('convex/streams.ts');

  it('adds a membership without ending the others', () => {
    // The whole defect in one assertion: joining or being placed must not
    // deactivate a membership the person already holds.
    expect(fn(streams, 'addMember')).not.toContain('leaveOtherStreams');
    expect(fn(streams, 'join')).not.toContain('leaveOtherStreams');
  });

  it('does not strip streams when an application converts', () => {
    // The exact path that stranded the four.
    const conv = read('convex/applications.ts');
    const body = fn(conv, 'convertApprovedApplications');
    expect(body).not.toContain('leaveOtherStreams(');
  });

  it('bounds self-service joining', () => {
    // Uncapped, an intern could join all fourteen streams and be handed every
    // task on the platform plus a notification for each.
    expect(MAX_SELF_JOINED_STREAMS).toBeGreaterThan(1);
    expect(MAX_SELF_JOINED_STREAMS).toBeLessThanOrEqual(5);
    expect(fn(streams, 'join')).toContain('MAX_SELF_JOINED_STREAMS');
  });

  it('leaves the admin path uncapped', () => {
    // Placing someone is deliberate and audited; the cap protects an intern
    // from their own enthusiasm, not an admin from a decision they have made.
    expect(fn(streams, 'addMember')).not.toContain('MAX_SELF_JOINED_STREAMS');
  });

  it('repoints the pointer on leave rather than blanking it', () => {
    // Someone still in two streams must not read as being in none.
    const body = fn(streams, 'leave');
    expect(body).toContain('currentStreamId: remaining[0]?.streamId');
    expect(body).not.toContain('currentStreamId: undefined');
  });

  it('keeps leaveOtherStreams available for a genuine move', () => {
    // Reassignment is still a real operation; it is just no longer what
    // "add to a stream" means.
    expect(read('convex/lib/membership.ts')).toContain('export async function leaveOtherStreams');
  });
});
