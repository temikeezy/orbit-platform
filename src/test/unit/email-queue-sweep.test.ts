import { afterEach, describe, expect, it, vi } from 'vitest';
import * as emailQueue from '../../../convex/emailQueue';

type Row = { _id: string };
type Constraint =
  | { operation: 'eq'; field: string; value: string | undefined }
  | { operation: 'gt'; field: string; value: undefined }
  | { operation: 'lt'; field: string; value: number };
type Read = { index: string; constraints: Constraint[]; limit: number };
type Patch = { id: string; value: Record<string, number> };

type SweepMutation = {
  _handler: (
    ctx: ReturnType<typeof makeContext>['ctx'],
    args: Record<string, never>,
  ) => Promise<{ removed: number; attemptsRemoved: number; backfilled: number }>;
};

function makeContext(rows: {
  oldSent?: Row[];
  oldFailed?: Row[];
  oldCancelled?: Row[];
  missingSent?: Row[];
  missingFailed?: Row[];
  /** Attempt rows keyed by the queue row they belong to. */
  attempts?: Record<string, Row[]>;
}) {
  const reads: Read[] = [];
  const attemptReads: { index: string; emailId: string }[] = [];
  const deleted: string[] = [];
  const patched: Patch[] = [];

  const ctx = {
    db: {
      query: (table: string) => {
        /**
         * The sweep now reads TWO tables: the queue rows it deletes, and each
         * one's attempt log, which it deletes with them. Before that existed,
         * `emailAttempts` grew forever while the rows it referenced were swept.
         */
        expect(['emailQueue', 'emailAttempts']).toContain(table);

        if (table === 'emailAttempts') {
          return {
            withIndex: (
              index: string,
              configure: (range: { eq: (field: string, value: string) => unknown }) => unknown,
            ) => {
              let emailId = '';
              const range = {
                eq(field: string, value: string) {
                  if (field === 'emailId') emailId = value;
                  return range;
                },
              };
              configure(range);
              return {
                take: async () => {
                  attemptReads.push({ index, emailId });
                  return (rows.attempts ?? {})[emailId] ?? [];
                },
              };
            },
          };
        }

        return {
          withIndex: (
            index: string,
            configure: (range: {
              eq: (field: string, value: string | undefined) => unknown;
              gt: (field: string, value: undefined) => unknown;
              lt: (field: string, value: number) => unknown;
            }) => unknown,
          ) => {
            const constraints: Constraint[] = [];
            const range = {
              eq(field: string, value: string | undefined) {
                constraints.push({ operation: 'eq', field, value });
                return range;
              },
              gt(field: string, value: undefined) {
                constraints.push({ operation: 'gt', field, value });
                return range;
              },
              lt(field: string, value: number) {
                constraints.push({ operation: 'lt', field, value });
                return range;
              },
            };
            configure(range);
            return {
              take: async (limit: number) => {
                reads.push({ index, constraints, limit });
                const status = constraints.find((item) => item.field === 'status')?.value;
                const missing = constraints.some(
                  (item) =>
                    item.operation === 'eq' &&
                    (item.field === 'sentAt' || item.field === 'failedAt') &&
                    item.value === undefined,
                );
                if (status === 'sent') return missing ? rows.missingSent ?? [] : rows.oldSent ?? [];
                if (status === 'cancelled') return rows.oldCancelled ?? [];
                return missing ? rows.missingFailed ?? [] : rows.oldFailed ?? [];
              },
            };
          },
        };
      },
      delete: async (id: string) => {
        deleted.push(id);
      },
      patch: async (id: string, value: Record<string, number>) => {
        patched.push({ id, value });
      },
    },
  };

  return { ctx, reads, attemptReads, deleted, patched };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('emailQueue terminal sweep', () => {
  it('deletes only timestamped terminal rows older than the retention window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
    const sweep = (emailQueue as Record<string, unknown>).sweepTerminal;
    expect(sweep).toBeTypeOf('function');
    if (typeof sweep !== 'function') return;

    const { ctx, reads, deleted, patched } = makeContext({
      oldSent: [{ _id: 'old-sent' }],
      oldFailed: [{ _id: 'old-failed' }],
    });
    const result = await (sweep as unknown as SweepMutation)._handler(ctx, {});

    expect(result).toEqual({ removed: 2, attemptsRemoved: 0, backfilled: 0 });
    expect(deleted).toEqual(['old-sent', 'old-failed']);
    expect(patched).toEqual([]);
    expect(reads).toEqual([
      {
        index: 'by_status_and_sent_at',
        constraints: [
          { operation: 'eq', field: 'status', value: 'sent' },
          { operation: 'gt', field: 'sentAt', value: undefined },
          {
            operation: 'lt',
            field: 'sentAt',
            value: Date.now() - 30 * 24 * 60 * 60 * 1000,
          },
        ],
        limit: 500,
      },
      {
        index: 'by_status_and_failed_at',
        constraints: [
          { operation: 'eq', field: 'status', value: 'failed' },
          { operation: 'gt', field: 'failedAt', value: undefined },
          {
            operation: 'lt',
            field: 'failedAt',
            value: Date.now() - 30 * 24 * 60 * 60 * 1000,
          },
        ],
        limit: 500,
      },
      {
        // Cancelled is a THIRD terminal state and was swept by nothing.
        // Its own timestamp, not failedAt: a cancellation is a decision a
        // person made, and reusing the failure clock would both miscount the
        // failure stats and start retention from the wrong moment.
        index: 'by_status_and_cancelled_at',
        constraints: [
          { operation: 'eq', field: 'status', value: 'cancelled' },
          { operation: 'gt', field: 'cancelledAt', value: undefined },
          {
            operation: 'lt',
            field: 'cancelledAt',
            value: Date.now() - 30 * 24 * 60 * 60 * 1000,
          },
        ],
        limit: 500,
      },
      {
        index: 'by_status_and_sent_at',
        constraints: [
          { operation: 'eq', field: 'status', value: 'sent' },
          { operation: 'eq', field: 'sentAt', value: undefined },
        ],
        limit: 500,
      },
      {
        index: 'by_status_and_failed_at',
        constraints: [
          { operation: 'eq', field: 'status', value: 'failed' },
          { operation: 'eq', field: 'failedAt', value: undefined },
        ],
        limit: 500,
      },
      {
        // Cancellations made before `cancelledAt` existed — the internal
        // retire-a-type path stamped `failedAt` instead, so those rows carry a
        // terminal status the cancelled sweep can never match and would keep
        // their bodies forever against a documented 30-day retention.
        index: 'by_status_and_cancelled_at',
        constraints: [
          { operation: 'eq', field: 'status', value: 'cancelled' },
          { operation: 'eq', field: 'cancelledAt', value: undefined },
        ],
        limit: 500,
      },
    ]);
  });

  it("deletes a message's attempt log with the message, and before it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
    const sweep = (emailQueue as Record<string, unknown>).sweepTerminal;
    if (typeof sweep !== 'function') return;

    const { ctx, attemptReads, deleted } = makeContext({
      oldSent: [{ _id: 'old-sent' }],
      oldCancelled: [{ _id: 'old-cancelled' }],
      attempts: {
        'old-sent': [{ _id: 'attempt-1' }, { _id: 'attempt-2' }],
        'old-cancelled': [{ _id: 'attempt-3' }],
      },
    });
    const result = await (sweep as unknown as SweepMutation)._handler(ctx, {});

    // `emailAttempts` is append-only and references rows this sweep deletes.
    // Without this it grew without bound, pointing at messages long gone.
    expect(result.attemptsRemoved).toBe(3);
    expect(attemptReads.map((r) => r.emailId)).toEqual(['old-sent', 'old-cancelled']);
    expect(attemptReads.every((r) => r.index === 'by_email')).toBe(true);

    // ORDER MATTERS, and is asserted rather than assumed: attempts go first,
    // so a mutation that fails partway leaves attempts without a parent —
    // invisible — rather than a message whose history has holes in it, which
    // is what an admin would see and misread as data loss.
    expect(deleted).toEqual([
      'attempt-1',
      'attempt-2',
      'old-sent',
      'attempt-3',
      'old-cancelled',
    ]);
  });

  it('backfills missing terminal timestamps instead of deleting legacy rows immediately', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
    const sweep = (emailQueue as Record<string, unknown>).sweepTerminal;
    expect(sweep).toBeTypeOf('function');
    if (typeof sweep !== 'function') return;

    const { ctx, deleted, patched } = makeContext({
      missingSent: [{ _id: 'legacy-sent' }],
      missingFailed: [{ _id: 'legacy-failed' }],
    });
    const result = await (sweep as unknown as SweepMutation)._handler(ctx, {});

    expect(result).toEqual({ removed: 0, attemptsRemoved: 0, backfilled: 2 });
    expect(deleted).toEqual([]);
    expect(patched).toEqual([
      { id: 'legacy-sent', value: { sentAt: Date.now() } },
      { id: 'legacy-failed', value: { failedAt: Date.now() } },
    ]);
  });
});
