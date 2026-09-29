import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { autoApprovalFeedback } from '../../../convex/lib/agentFallback';

const root = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const code = (src: string, name: string) => {
  const start = src.indexOf(`export const ${name} =`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = src.indexOf('export const', start + 10);
  return src
    .slice(start, next === -1 ? undefined : next)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
};

/**
 * The agent's fallback review.
 *
 * A submission nobody reads is worse for an intern than one that is rejected:
 * they cannot resubmit, cannot earn the points, and cannot tell whether the work
 * was poor or simply unseen. The queue reached 524 with not one actioned and the
 * oldest waiting over a week, so this is a real failure rather than a
 * precaution.
 *
 * What these pin is the shape of the compromise. Automating a JUDGEMENT is the
 * thing to be careful about, so the automation is allowed to be generous and
 * never allowed to be punitive, and it must never be mistakable for a person.
 */
describe('automatic review fallback', () => {
  const tasks = read('convex/tasks.ts');
  const body = code(tasks, 'autoReviewStaleSubmissions');

  it('only ever approves — never rejects, never requests changes', () => {
    // No machine here has read the work. "Rejected" is a judgement a person has
    // to make and be answerable for.
    expect(body).toContain("status: 'approved'");
    expect(body).not.toContain("'rejected'");
    expect(body).not.toContain("'changes_requested'");
  });

  it('does not record a reviewer', () => {
    /**
     * The property that makes this honest. `autoApproveOverdueProposals` leaves
     * `approvedBy` unset for the same reason: it keeps "the window expired"
     * distinguishable from "a supervisor read this and agreed", in the data,
     * for anyone auditing how a mark was reached.
     */
    expect(body).not.toContain('reviewedBy:');
  });

  it('tells the intern it was not individually assessed', () => {
    // They are entitled to know, and to be able to ask for a real read — on
    // every route to an automatic approval, not just the plain timeout.
    expect(body).toContain('autoApprovalFeedback(');
    for (const outcome of [undefined, 'contested', 'unreadable', 'unsupported', 'no-quorum']) {
      expect(autoApprovalFeedback(outcome)).toContain('has not been individually assessed');
    }
  });

  it('pays the full points rather than a reduced score', () => {
    // Withholding points because a supervisor was busy charges the intern for
    // someone else's delay.
    expect(body).toContain('score: task.points');
    expect(body).toContain('points: task.points');
  });

  it('refuses an empty submission', () => {
    // A row with no text and no file is not work, and paying for it puts points
    // on the leaderboard that nothing earned.
    expect(body).toContain('hasWork');
    expect(body).toContain('skippedEmpty');
  });

  it('counts a stored file as work, whichever column it lives in', () => {
    /**
     * THE BUG THAT NEARLY SHIPPED. `attachSubmissionFile` stores an upload as
     * `submissionFileId`; `submissionFileUrl` holds a link submission. Checking
     * only the url made every file-based submission look empty — a dry run said
     * 11 of 25 were empty and every one of them held real work. It would have
     * skipped those interns entirely, and read as them submitting nothing.
     */
    expect(body).toContain('sub.submissionFileId');
    expect(body).toContain('sub.submissionFileUrl');
  });

  it('will not pay twice for one submission', () => {
    // The ledger is what moves a leaderboard; a double payment there would be
    // invisible and permanent.
    expect(body).toContain('pointsLedger');
    expect(body).toContain('skippedAlreadyPaid');
    expect(body.indexOf('pointsLedger')).toBeLessThan(body.indexOf('awardPoints'));
  });

  it('waits longer than a proposal does', () => {
    // A proposal auto-publishes after 48h. A submission is a person's finished
    // work, so its supervisor gets a longer chance to read it first.
    const win = tasks.match(/const AUTO_REVIEW_AFTER_HOURS = (\d+)/);
    expect(win).toBeTruthy();
    expect(Number(win![1])).toBeGreaterThan(48);
  });

  it('supports a dry run, so the blast radius can be measured first', () => {
    // Approving hundreds of submissions is not something to discover the size
    // of afterwards.
    expect(body).toContain('dryRun');
    expect(body.indexOf('if (dryRun)')).toBeLessThan(body.indexOf('ctx.db.patch'));
  });

  it('batches and reschedules rather than one unbounded pass', () => {
    expect(body).toContain('AUTO_REVIEW_BATCH');
    expect(body).toContain('scheduler.runAfter');
    expect(body).not.toContain('.collect()\n      .filter');
  });

  it('still awards badges and notifies, like a real approval', () => {
    // Auto-approved must mean approved in every respect except who decided.
    expect(body).toContain('checkAndAward');
    expect(body).toContain('notifySubmissionReviewed');
  });
});
