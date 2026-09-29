import { describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import * as tasks from '../../../convex/tasks';
import * as agentOps from '../../../convex/agentOps';
import * as messages from '../../../convex/messages';

type Row = { _id: string; [key: string]: unknown };
type Range = { eq: (field: string, value: unknown) => Range; gt: (field: string, value: number) => Range };
type Handler<T> = { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<T> };
const invoke = <T = Record<string, unknown>>(fn: unknown, ctx: unknown, args = {}) =>
  (fn as Handler<T>)._handler(ctx, args);

// Execute real handlers against local rows; no deployment or scheduler is contacted.
function database(seed: Record<string, Row[]>) {
  const tables = structuredClone(seed);
  const reads: Array<{ table: string; index: string; fields: string[] }> = [];
  const db = {
    get: async (id: string) => Object.values(tables).flat().find((r) => r._id === id) ?? null,
    insert: async (table: string, value: Record<string, unknown>) => {
      const rows = tables[table] ??= [];
      const id = `${table}-${rows.length}`;
      rows.push({ ...value, _id: id });
      return id;
    },
    patch: async (id: string, patch: Record<string, unknown>) => {
      const row = await db.get(id);
      if (!row) throw new Error(`Missing ${id}`);
      Object.assign(row, patch);
    },
    query: (table: string) => {
      let rows = [...(tables[table] ?? [])];
      let orderField = '_creationTime';
      const query = {
        withIndex: (index: string, configure?: (range: Range) => unknown) => {
          const fields: string[] = [];
          const range = {
            eq: (field: string, value: unknown) => {
              fields.push(field);
              rows = rows.filter((r) => r[field] === value);
              return range;
            },
            gt: (field: string, value: number) => {
              fields.push(field);
              rows = rows.filter((r) => Number(r[field]) > value);
              return range;
            },
          };
          configure?.(range);
          reads.push({ table, index, fields });
          orderField = index.includes('time') ? 'createdAt' : '_creationTime';
          if (index === 'by_status_and_reshare_prompted') {
            rows.sort((a, b) => Number(a.resharePromptedAt ?? -1) - Number(b.resharePromptedAt ?? -1));
          }
          return query;
        },
        order: (direction: string) => {
          rows.sort((a, b) => (Number(a[orderField] ?? 0) - Number(b[orderField] ?? 0)) *
            (direction === 'desc' ? -1 : 1));
          return query;
        },
        collect: async () => rows,
        // `for await (const row of ctx.db.query(...))`, as Convex queries allow.
        async *[Symbol.asyncIterator]() { yield* rows; },
        take: async (n: number) => rows.slice(0, n),
        first: async () => rows[0] ?? null,
        unique: async () => rows[0] ?? null,
        paginate: async ({ numItems, cursor }: { numItems: number; cursor: string | null }) => {
          const start = Number(cursor ?? 0);
          const end = Math.min(start + numItems, rows.length);
          return { page: rows.slice(start, end), isDone: end === rows.length, continueCursor: String(end) };
        },
      };
      return query;
    },
  };
  const ctx = {
    db,
    scheduler: { runAfter: vi.fn(async (_delay: number, _ref: Parameters<typeof getFunctionName>[0], _args: Record<string, unknown>) => 'scheduled') },
    runQuery: async (ref: Parameters<typeof getFunctionName>[0], args: Record<string, unknown>) =>
      invoke((agentOps as Record<string, unknown>)[getFunctionName(ref).split(':')[1]], ctx, args),
    runAction: async (ref: Parameters<typeof getFunctionName>[0], args: Record<string, unknown>) =>
      invoke((agentOps as Record<string, unknown>)[getFunctionName(ref).split(':')[1]], ctx, args),
    runMutation: async (ref: Parameters<typeof getFunctionName>[0], args: Record<string, unknown>) =>
      invoke((agentOps as Record<string, unknown>)[getFunctionName(ref).split(':')[1]], ctx, args),
  };
  return { ctx, tables, reads };
}

const task = { _id: 'task', title: 'Work', description: 'Brief', points: 10 };
const user = { _id: 'user', roles: ['intern'], totalPoints: 0, currentLevel: 1, isActive: true };
const submission = {
  _id: 'sub', taskId: 'task', userId: 'user', status: 'submitted',
  submissionText: 'The work', createdAt: 1,
};

describe('assessment corrections', () => {
  it('excludes both uploaded and linked work even when accompanied by text', async () => {
    const { ctx } = database({ tasks: [task], submissions: [submission,
      { ...submission, _id: 'file', submissionFileId: 'storage' },
      { ...submission, _id: 'link', submissionFileUrl: 'https://example.com/work' },
    ] });
    const result = await invoke<Array<{ submissionId: string }>>(tasks.pendingForAssessment, ctx);
    expect(result.map((r) => r.submissionId)).toEqual(['sub']);
  });

  it('reverses a former intern payment, preserves other points, and allows reassessment', async () => {
    const { ctx, tables } = database({ tasks: [task], users: [{ ...user, roles: ['admin'], totalPoints: 12 }],
      submissions: [{ ...submission, status: 'approved', score: 8 }],
      pointsLedger: [
        { _id: 'paid', userId: 'user', points: 8, referenceType: 'submission', referenceId: 'sub' },
        { _id: 'other', userId: 'user', points: 4, referenceType: 'badge', referenceId: 'sub' },
      ], levels: [{ _id: 'level', levelNumber: 1, pointsRequired: 0 }],
    });
    const result = await invoke(tasks.withdrawAssessment, ctx, { submissionId: 'sub', reason: 'unreadable' });
    expect(result).toEqual({ withdrawn: true, pointsReversed: 8 });
    expect(tables.pointsLedger.filter((r) => r.referenceType === 'submission')
      .reduce((n, r) => n + Number(r.points), 0)).toBe(0);
    expect(tables.users[0].totalPoints).toBe(4);
    expect(tables.submissions[0].score).toBeUndefined();
    expect(await invoke(tasks.withdrawAssessment, ctx, { submissionId: 'sub', reason: 'retry' }))
      .toMatchObject({ withdrawn: false, pointsReversed: 0 });
    expect(await invoke(tasks.applyAssessment, ctx,
      { submissionId: 'sub', score: 0, feedback: 'Re-read', assessor: 'test', notify: false }))
      .toEqual({ applied: true });
  });

  it.each([true, false])('scopes assessment ledger lookup to the submission (withdraw=%s)', async (withdraw) => {
    const { ctx, reads } = database({ tasks: [task], users: [user],
      submissions: [{ ...submission, status: withdraw ? 'approved' : 'submitted' }],
      pointsLedger: [{ _id: 'unrelated', userId: 'user', points: 100, referenceType: 'badge', referenceId: 'sub' }],
    });
    await invoke(withdraw ? tasks.withdrawAssessment : tasks.applyAssessment, ctx,
      { submissionId: 'sub', score: 0, feedback: 'OK', assessor: 'test', reason: 'wrong' });
    expect(reads.filter((r) => r.table === 'pointsLedger')).toEqual([
      { table: 'pointsLedger', index: 'by_user_and_reference', fields: ['userId', 'referenceType', 'referenceId'] },
    ]);
  });

  it.each([undefined, true, false])('defaults to notifying but supports notify=%s', async (notify) => {
    const { ctx } = database({ tasks: [task], users: [user], submissions: [submission] });
    await invoke(tasks.applyAssessment, ctx,
      { submissionId: 'sub', score: 0, feedback: 'OK', assessor: 'test', notify });
    expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(notify === false ? 0 : 1);
  });
});

describe('agent scan coverage', () => {
  const approved = [
    ...Array.from({ length: 1500 }, (_, i) => ({ ...submission, _id: `human-${i}`, status: 'approved', score: 10, reviewedBy: 'staff' })),
    ...Array.from({ length: 6 }, (_, i) => ({ ...submission, _id: `agent-${i}`, status: 'approved', score: 1 })),
  ];

  it('detects an anomaly after the first 1500 approvals', async () => {
    const { ctx } = database({ tasks: [task], submissions: approved });
    const runQuery = vi.fn(ctx.runQuery);
    const result = await invoke(agentOps.detectMarkOutliers, { runQuery });
    expect(result.assessedTotal).toBe(6);
    expect(result.flagged).toEqual([expect.objectContaining({ kind: 'task', count: 6, meanFraction: 0.1 })]);
    expect(runQuery.mock.calls.length).toBeGreaterThan(1);
  });

  it('includes later approvals in the distribution', async () => {
    const { ctx } = database({ tasks: [task], submissions: approved });
    const result = await invoke(agentOps.markDistribution, ctx);
    expect(result.overallMean).toBe(0.1);
    expect(result.byEvidence).toEqual([{ source: 'text', n: 6, mean: 0.1 }]);
  });

  it('compares evidence across page boundaries and reports through the scheduled action', async () => {
    const { ctx, tables } = database({ tasks: [task], users: [
      { ...user, roles: ['admin'], email: 'admin@example.com', fullName: 'Admin' },
    ], submissions: [
      ...Array.from({ length: 100 }, (_, i) => ({ ...submission, _id: `good-${i}`, status: 'approved', score: 8 })),
      ...Array.from({ length: 6 }, (_, i) => ({ ...submission, _id: `bad-${i}`, status: 'approved', score: 1,
        submissionFileUrl: 'https://docs.google.com/document/d/work' })),
    ] });
    const result = await invoke(agentOps.reportMarkOutliers, ctx);
    expect(result).toEqual({ flagged: 1, queued: 1 });
    expect(tables.emailQueue[0].bodyText).toContain('106 submissions');
    expect(tables.emailQueue[0].bodyText).toContain('docs.google.com');
  });

  it('continues scheduled scans beyond filtered pages and preserves the total nudge limit', async () => {
    const { ctx, tables } = database({ tasks: [task], users: [user], submissions: [
      ...Array.from({ length: 600 }, (_, i) => ({ ...submission, _id: `text-${i}` })),
      ...Array.from({ length: 5 }, (_, i) => ({ ...submission, _id: `link-${i}`,
        submissionFileUrl: 'https://docs.google.com/document/d/work/edit' })),
    ] });
    let args: Record<string, unknown> = { limit: 3 };
    let lastResult: Record<string, unknown> = {};
    for (let page = 0; page < 250; page++) {
      ctx.scheduler.runAfter.mockClear();
      lastResult = await invoke(agentOps.chaseUnreadableSubmissions, ctx, args);
      const scheduled = ctx.scheduler.runAfter.mock.calls[0];
      if (!scheduled) break;
      expect(getFunctionName(scheduled[1])).toBe('agentOps:chaseUnreadableSubmissions');
      args = scheduled[2];
    }
    expect(tables.notifications).toHaveLength(3);
    expect(lastResult.isDone).toBe(false);
    expect(lastResult.continueCursor).toBeTruthy();
    expect(tables.submissions.filter((r) => r.resharePromptedAt)).toHaveLength(3);
  });

  it('reaches never-prompted submissions before repeat nudges consume the daily budget', async () => {
    const { ctx, tables } = database({ tasks: [task], users: [user], submissions: [
      ...Array.from({ length: 40 }, (_, i) => ({ ...submission, _id: `repeat-${i}`,
        submissionFileUrl: 'https://docs.google.com/document/d/work',
        resharePromptedAt: Date.now() - 6 * 86_400_000 })),
      { ...submission, _id: 'new-link', submissionFileUrl: 'https://docs.google.com/document/d/new' },
    ] });
    await invoke(agentOps.chaseUnreadableSubmissions, ctx);
    expect(tables.submissions.find((r) => r._id === 'new-link')?.resharePromptedAt).toBeDefined();
    expect(tables.notifications).toHaveLength(40);
  });

  it('can reach an unreadable link beyond 600 text submissions without sending during dry run', async () => {
    const { ctx } = database({ tasks: [task], users: [user], submissions: [
      ...Array.from({ length: 600 }, (_, i) => ({ ...submission, _id: `text-${i}` })),
      { ...submission, _id: 'link', submissionFileUrl: 'https://docs.google.com/document/d/work/edit' },
    ] });
    let cursor: unknown = null;
    let chased = 0;
    for (let i = 0; i < 100; i++) {
      const result = await invoke(agentOps.chaseUnreadableSubmissions, ctx, { dryRun: true, cursor });
      chased += Number(result.chased);
      if (result.isDone !== false) break;
      cursor = result.continueCursor;
    }
    expect(chased).toBe(1);
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
});

describe('awaiting replies', () => {
  it('finds a later reply outside the global outbound window', async () => {
    const { ctx } = database({ users: [{ ...user, email: 'agent@example.com' }, { _id: 'other', fullName: 'Other' }],
      messages: [
        { _id: 'in', senderId: 'other', recipientId: 'user', content: 'Question', createdAt: 1, _creationTime: 1, isRead: false },
        { _id: 'reply', senderId: 'user', recipientId: 'other', content: 'Answer', createdAt: 2, _creationTime: 2 },
        ...Array.from({ length: 500 }, (_, i) => ({ _id: `out-${i}`, senderId: 'user', recipientId: 'elsewhere', createdAt: i + 3, _creationTime: i + 3 })),
      ],
    });
    expect(await invoke(messages.awaitingReply, ctx, { userEmail: 'agent@example.com' })).toEqual([]);
  });

  it('uses sent time for imported inbound rows and keeps unanswered conversations', async () => {
    const { ctx } = database({ users: [{ ...user, email: 'agent@example.com' }, { _id: 'other', fullName: 'Other' }],
      messages: [
        { _id: 'old', senderId: 'other', recipientId: 'user', content: 'Old question', createdAt: 1, _creationTime: 100, isRead: false },
        { _id: 'reply', senderId: 'user', recipientId: 'other', content: 'Answer', createdAt: 2, _creationTime: 101 },
        { _id: 'new', senderId: 'other', recipientId: 'user', content: 'New question', createdAt: 3, _creationTime: 50, isRead: false },
      ],
    });
    expect(await invoke(messages.awaitingReply, ctx, { userEmail: 'agent@example.com' }))
      .toEqual([{ otherUserId: 'other', otherName: 'Other', lastFromThem: 'New question', lastAt: 3, unread: 2 }]);
  });
});
