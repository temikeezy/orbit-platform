import { afterEach, describe, expect, it, vi } from 'vitest';
import * as notifications from '../../../convex/notifications';

type Constraint =
  | { operation: 'eq'; field: string; value: boolean }
  | { operation: 'lt'; field: string; value: number };

type SweepMutation = {
  _handler: (
    ctx: {
      db: {
        query: (table: string) => {
          withIndex: (
            index: string,
            configure: (range: {
              eq: (field: string, value: boolean) => unknown;
              lt: (field: string, value: number) => unknown;
            }) => unknown,
          ) => { take: (limit: number) => Promise<Array<{ _id: string }>> };
        };
        delete: (id: string) => Promise<void>;
      };
    },
    args: Record<string, never>,
  ) => Promise<{ removed: number }>;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('notification retention sweep', () => {
  it('bounds deletion pages while retaining unread notifications longer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'));

    const sweep = (notifications as Record<string, unknown>).sweepExpired;
    expect(sweep).toBeTypeOf('function');
    if (typeof sweep !== 'function') return;

    const reads: Array<{ index: string; constraints: Constraint[]; limit: number }> = [];
    const deleted: string[] = [];
    const rowsByReadState: Record<string, Array<{ _id: string }>> = {
      true: [{ _id: 'old-read' }],
      false: [{ _id: 'very-old-unread' }],
    };

    const ctx = {
      db: {
        query: (table: string) => {
          expect(table).toBe('notifications');
          return {
            withIndex: (
              index: string,
              configure: (range: {
                eq: (field: string, value: boolean) => unknown;
                lt: (field: string, value: number) => unknown;
              }) => unknown,
            ) => {
              const constraints: Constraint[] = [];
              const range = {
                eq(field: string, value: boolean) {
                  constraints.push({ operation: 'eq', field, value });
                  return range;
                },
                lt(field: string, value: number) {
                  constraints.push({ operation: 'lt', field, value });
                  return range;
                },
              };
              configure(range);
              const readState = constraints.find((item) => item.field === 'isRead');
              return {
                take: async (limit: number) => {
                  reads.push({ index, constraints, limit });
                  return rowsByReadState[String(readState?.value)] ?? [];
                },
              };
            },
          };
        },
        delete: async (id: string) => {
          deleted.push(id);
        },
      },
    };

    const result = await (sweep as unknown as SweepMutation)._handler(ctx, {});

    expect(result).toEqual({ removed: 2 });
    expect(deleted).toEqual(['old-read', 'very-old-unread']);
    expect(reads).toEqual([
      {
        index: 'by_read_and_time',
        constraints: [
          { operation: 'eq', field: 'isRead', value: true },
          {
            operation: 'lt',
            field: 'createdAt',
            value: Date.now() - 30 * 24 * 60 * 60 * 1000,
          },
        ],
        limit: 500,
      },
      {
        index: 'by_read_and_time',
        constraints: [
          { operation: 'eq', field: 'isRead', value: false },
          {
            operation: 'lt',
            field: 'createdAt',
            value: Date.now() - 180 * 24 * 60 * 60 * 1000,
          },
        ],
        limit: 500,
      },
    ]);
  });
});
