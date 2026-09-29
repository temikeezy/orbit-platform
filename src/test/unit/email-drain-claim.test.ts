import { describe, it, expect } from 'vitest';
import * as emailQueue from '../../../convex/emailQueue';

/**
 * The targeted drain's claim model.
 *
 * `drainType` releases ONE email type while the global hold keeps everything
 * else queued — the procedure used to let a specific batch go without releasing
 * the whole backlog behind it. Its docstring has always asserted that "each row
 * is claimed so a second run cannot double-send"; until this was fixed, nothing
 * claimed anything, and the assertion was false in two ways that both end with
 * a real person receiving the same email twice:
 *
 *   - two overlapping runs each read the same pending rows and each sent them
 *   - a report left `claimId` on the row, so the cron's own `markFailed` could
 *     still pass its ownership check and resurrect an already-sent message
 *
 * Tested here rather than in the integration suite because these are
 * `internalMutation`s and deliberately not callable from a client — which also
 * means this runs in CI, where the integration file skips for want of a secret.
 */

interface Row {
  _id: string;
  status: string;
  emailType: string;
  retryCount: number;
  claimId?: string;
  claimedAt?: number;
  nextAttemptAt?: number;
  recipientEmail: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  requeuedByUserId?: string;
}

type Handler<A, R> = { _handler: (ctx: unknown, args: A) => Promise<R> };

/** A minimal in-memory stand-in for the parts of ctx.db these mutations use. */
function makeDb(rows: Row[]) {
  const inserted: Record<string, unknown>[] = [];
  const ctx = {
    db: {
      query: (table: string) => {
        if (table === 'emailAttempts') {
          // `recordAttempt` numbers from what is already logged, so the mock
          // has to return the rows it has inserted so far.
          return {
            withIndex: () => ({
              take: async () => inserted,
              collect: async () => inserted,
            }),
          };
        }
        return {
          withIndex: (_index: string, configure: (r: unknown) => unknown) => {
            let status = '';
            const range = {
              eq(field: string, value: string) {
                if (field === 'status') status = value;
                return range;
              },
            };
            configure(range);
            return { take: async () => rows.filter((r) => r.status === status) };
          },
        };
      },
      get: async (id: string) => rows.find((r) => r._id === id) ?? null,
      patch: async (id: string, value: Partial<Row>) => {
        const row = rows.find((r) => r._id === id);
        if (row) Object.assign(row, value);
      },
      insert: async (_table: string, doc: Record<string, unknown>) => {
        inserted.push(doc);
        return `attempt-${inserted.length}`;
      },
    },
  };
  return { ctx, rows, inserted };
}

function pendingRow(id: string, emailType = 'general'): Row {
  return {
    _id: id,
    status: 'pending',
    emailType,
    retryCount: 0,
    recipientEmail: `${id}@example.invalid`,
    subject: `subject ${id}`,
    bodyHtml: '<p>body</p>',
    bodyText: 'body',
  };
}

const claimFn = emailQueue.claimPendingOfType as unknown as Handler<
  { emailType: string; limit: number; claimId: string },
  { id: string }[]
>;
const sentFn = emailQueue.markSentDirect as unknown as Handler<
  { id: string; claimId: string },
  { applied: boolean }
>;
const failedFn = emailQueue.markFailedDirect as unknown as Handler<
  { id: string; error: string; claimId: string },
  { applied: boolean }
>;

describe('the targeted drain claims what it sends', () => {
  it('moves a claimed row out of pending, so a second run cannot see it', async () => {
    const { ctx, rows } = makeDb([pendingRow('a'), pendingRow('b')]);

    const first = await claimFn._handler(ctx, {
      emailType: 'general',
      limit: 10,
      claimId: 'run-1',
    });
    expect(first.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows.every((r) => r.status === 'processing')).toBe(true);

    // The whole point: a concurrent run finds nothing left to send.
    const second = await claimFn._handler(ctx, {
      emailType: 'general',
      limit: 10,
      claimId: 'run-2',
    });
    expect(second).toEqual([]);
  });

  it('claims only the requested type', async () => {
    const { ctx, rows } = makeDb([pendingRow('a', 'general'), pendingRow('b', 'application_approved')]);

    const claimed = await claimFn._handler(ctx, {
      emailType: 'application_approved',
      limit: 10,
      claimId: 'run-1',
    });

    expect(claimed.map((r) => r.id)).toEqual(['b']);
    // The untouched type stays available to the ordinary cron drain.
    expect(rows.find((r) => r._id === 'a')!.status).toBe('pending');
  });

  it('honours a backoff the cron path would respect', async () => {
    const row = pendingRow('a');
    row.nextAttemptAt = Date.now() + 60_000;
    const { ctx } = makeDb([row]);

    // Without this the targeted drain would ignore the backoff and hammer a
    // recipient the cron path is deliberately waiting on.
    const claimed = await claimFn._handler(ctx, {
      emailType: 'general',
      limit: 10,
      claimId: 'run-1',
    });
    expect(claimed).toEqual([]);
  });

  it('refuses a report from a run that does not hold the claim', async () => {
    const { ctx, rows } = makeDb([pendingRow('a')]);
    await claimFn._handler(ctx, { emailType: 'general', limit: 10, claimId: 'run-1' });

    const stolen = await sentFn._handler(ctx, { id: 'a', claimId: 'run-2' });
    expect(stolen.applied).toBe(false);
    // Untouched — a stale run must not be able to stamp `sent` over a row
    // another run now owns.
    expect(rows[0].status).toBe('processing');

    const owned = await sentFn._handler(ctx, { id: 'a', claimId: 'run-1' });
    expect(owned.applied).toBe(true);
    expect(rows[0].status).toBe('sent');
  });

  it('releases the claim when it reports, so the reaper cannot resurrect a sent row', async () => {
    const { ctx, rows } = makeDb([pendingRow('a')]);
    await claimFn._handler(ctx, { emailType: 'general', limit: 10, claimId: 'run-1' });
    await sentFn._handler(ctx, { id: 'a', claimId: 'run-1' });

    // Left set, the row would keep a claim nobody holds; the stale-claim sweep
    // keys on claimedAt and would eventually return a DELIVERED message to
    // pending for a second send.
    expect(rows[0].claimId).toBeUndefined();
    expect(rows[0].claimedAt).toBeUndefined();
  });

  it('numbers attempts continuously across a requeue, not from a reset counter', async () => {
    const { ctx, rows, inserted } = makeDb([pendingRow('a')]);

    await claimFn._handler(ctx, { emailType: 'general', limit: 10, claimId: 'r1' });
    await failedFn._handler(ctx, { id: 'a', error: 'first failure', claimId: 'r1' });

    // Simulate what adminRetry does: back to pending with retryCount reset.
    // Numbering from retryCount would restart at 1 here and the history would
    // show two different "Attempt 1" rows for one message.
    rows[0].status = 'pending';
    rows[0].retryCount = 0;

    await claimFn._handler(ctx, { emailType: 'general', limit: 10, claimId: 'r2' });
    await sentFn._handler(ctx, { id: 'a', claimId: 'r2' });

    expect(inserted.map((a) => a.attempt)).toEqual([1, 2]);
    expect(inserted.map((a) => a.outcome)).toEqual(['failed', 'sent']);
  });

  it('persists the retry increment it logs, so the row and the log agree', async () => {
    const { ctx, rows, inserted } = makeDb([pendingRow('a')]);
    await claimFn._handler(ctx, { emailType: 'general', limit: 10, claimId: 'run-1' });

    await failedFn._handler(ctx, { id: 'a', error: 'smtp refused', claimId: 'run-1' });

    // This used to log "attempt 1" while leaving retryCount at 0 — the log said
    // an attempt happened and the message said none had.
    expect(rows[0].retryCount).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].attempt).toBe(1);
    expect(inserted[0].outcome).toBe('failed');
  });
});

/**
 * The cron path's backoff, which the targeted-drain path deliberately does not
 * use — `markFailedDirect` fails terminally because a targeted drain is a
 * human releasing one batch, not an automatic retry loop.
 */
describe('markFailed schedules the next attempt', () => {
  const markFailed = emailQueue.markFailed as unknown as Handler<
    { id: string; error: string; claimId: string },
    void
  >;

  it('sets a future nextAttemptAt rather than retrying immediately', async () => {
    const { ctx, rows } = makeDb([pendingRow('a')]);
    rows[0].status = 'processing';
    rows[0].claimId = 'run-1';
    rows[0].claimedAt = Date.now();

    const before = Date.now();
    await markFailed._handler(ctx, { id: 'a', error: 'smtp refused', claimId: 'run-1' });

    // Straight back to pending with no timer was the old behaviour: the
    // two-minute cron picked it up at once, three attempts inside four minutes,
    // and a five-minute provider outage lost the mail.
    expect(rows[0].status).toBe('pending');
    expect(rows[0].retryCount).toBe(1);
    expect(rows[0].nextAttemptAt).toBeGreaterThan(before);
  });

  it('gives up terminally at the retry ceiling instead of scheduling forever', async () => {
    const { ctx, rows } = makeDb([pendingRow('a')]);
    rows[0].status = 'processing';
    rows[0].claimId = 'run-1';
    rows[0].claimedAt = Date.now();
    rows[0].retryCount = 2; // MAX_RETRIES is 3, so this failure is the last

    await markFailed._handler(ctx, { id: 'a', error: 'bad recipient', claimId: 'run-1' });

    // A permanently bad address would otherwise be picked up by every cron run
    // and the queue would never drain.
    expect(rows[0].status).toBe('failed');
    expect(rows[0].nextAttemptAt).toBeUndefined();
  });
});
