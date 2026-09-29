import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../convex/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('../../../convex/lib/auth')>(
    '../../../convex/lib/auth',
  );

  return {
    ...actual,
    requireModerator: vi.fn(async () => ({
      _id: 'admin',
      email: 'admin@example.com',
      roles: ['admin'],
    })),
    requireUser: vi.fn(async (_ctx: unknown, token: string) => {
      if (token === 'invalid') throw new Error('Invalid or expired session');
      return { _id: 'lead', roles: ['moderator'] };
    }),
    isMcpSession: vi.fn(async () => false),
  };
});

import {
  approveProposal,
  autoApproveOverdueProposals,
  create,
  programmeState,
  update,
} from '../../../convex/tasks';
import {
  evaluateTaskProgramme,
  selectCurrentTaskProgramme,
} from '../../../convex/lib/taskProgramme';

type CohortFixture = Parameters<typeof selectCurrentTaskProgramme>[0][number];

const cohort = (overrides: Partial<CohortFixture> = {}): CohortFixture =>
  ({
    status: 'active',
    startDate: '2026-08-17',
    createdAt: 100,
    ...overrides,
  }) as CohortFixture;

/** Convex registers this runtime hook but intentionally omits it from its client-facing type. */
function registeredHandler(registered: unknown) {
  return (
    registered as {
      _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>;
    }
  )._handler;
}

describe('current task programme selection', () => {
  it('uses only active cohorts and picks the latest programme start', () => {
    const selected = selectCurrentTaskProgramme([
      cohort({ status: 'inactive', startDate: '2027-01-05', createdAt: 500 }),
      cohort({ startDate: '2026-08-10', createdAt: 300 }),
      cohort({ startDate: '2026-08-17', createdAt: 100 }),
    ]);

    expect(selected?.startDate).toBe('2026-08-17');
  });

  it('uses the newest record to break equal-start ties deterministically', () => {
    const selected = selectCurrentTaskProgramme([
      cohort({ startDate: '2026-08-17', createdAt: 100 }),
      cohort({ startDate: '2026-08-17', createdAt: 200 }),
    ]);

    expect(selected?.createdAt).toBe(200);
  });

  it('does not fall back to an inactive cohort', () => {
    expect(
      selectCurrentTaskProgramme([
        cohort({ status: 'completed', startDate: '2026-08-17' }),
      ]),
    ).toBeNull();
  });
});

describe('task programme gate', () => {
  it('refuses before the active programme starts', () => {
    const decision = evaluateTaskProgramme(
      cohort({ startDate: '2026-08-17' }),
      Date.UTC(2026, 7, 16, 22, 59, 59, 999),
    );

    expect(decision).toEqual({
      allowed: false,
      startDate: '2026-08-17',
      error:
        'Tasks cannot be created or assigned until the programme starts on 2026-08-17.',
    });
  });

  it('allows exactly when the active programme starts in WAT', () => {
    const decision = evaluateTaskProgramme(
      cohort({ startDate: '2026-08-17' }),
      Date.UTC(2026, 7, 16, 23, 0),
    );

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.startDate).toBe('2026-08-17');
      expect(decision.defaultDeadline).toBeTypeOf('number');
    }
  });

  it('refuses when there is no active programme', () => {
    const decision = evaluateTaskProgramme(null, Date.UTC(2026, 7, 19, 9));

    expect(decision).toEqual({
      allowed: false,
      startDate: null,
      error: 'Tasks cannot be created or assigned because no active programme cohort is configured.',
    });
  });

  it('derives the default from the active cohort cadence', () => {
    const decision = evaluateTaskProgramme(
      cohort({ weeklySummaryDueDay: 2, weeklySummaryDueHourWat: 14 }),
      Date.UTC(2026, 7, 17, 9), // Monday 10:00 WAT.
    );

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.defaultDeadline).toBe(Date.UTC(2026, 7, 18, 13, 59, 59, 999));
    }
  });
});

describe('registered task programme state query', () => {
  function queryContext(programme: CohortFixture | null) {
    const query = vi.fn(() => ({
      withIndex: vi.fn(() => ({
        collect: vi.fn(async () => (programme ? [programme] : [])),
      })),
    }));

    return { ctx: { db: { query } }, query };
  }

  it('returns the allowed union from the caller-supplied instant', async () => {
    const calls = queryContext(cohort({ name: 'Autumn programme' }));
    const now = Date.UTC(2026, 7, 17, 9); // Monday 10:00 WAT.

    await expect(
      registeredHandler(programmeState)(calls.ctx, { token: 'token', now }),
    ).resolves.toEqual({
      allowed: true,
      cohortName: 'Autumn programme',
      startDate: '2026-08-17',
      defaultDeadline: Date.UTC(2026, 7, 20, 22, 59, 59, 999),
    });
  });

  it('returns the refused union from the caller-supplied instant', async () => {
    const calls = queryContext(cohort({ name: 'Autumn programme' }));
    const now = Date.UTC(2026, 7, 16, 22, 59, 59, 999);

    await expect(
      registeredHandler(programmeState)(calls.ctx, { token: 'token', now }),
    ).resolves.toEqual({
      allowed: false,
      cohortName: 'Autumn programme',
      startDate: '2026-08-17',
      defaultDeadline: null,
      error: 'Tasks cannot be created or assigned until the programme starts on 2026-08-17.',
    });
  });

  it('authenticates before reading cohorts', async () => {
    const calls = queryContext(cohort());

    await expect(
      registeredHandler(programmeState)(calls.ctx, {
        token: 'invalid',
        now: Date.UTC(2026, 7, 17, 9),
      }),
    ).rejects.toThrow('Invalid or expired session');

    expect(calls.query).not.toHaveBeenCalled();
  });
});

describe('registered task mutation refusals', () => {
  const futureProgramme = cohort({
    name: 'Autumn programme',
    startDate: '2026-08-17',
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 16, 22, 59, 59, 999));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function mutationContext(existingTask?: Record<string, unknown>) {
    const query = vi.fn((table: string) => {
      if (table === 'cohorts') {
        return {
          withIndex: vi.fn(() => ({
            collect: vi.fn(async () => [futureProgramme]),
          })),
        };
      }

      if (table === 'adminSettings') {
        return {
          withIndex: vi.fn(() => ({
            unique: vi.fn(async () => ({ settingValue: 48 })),
          })),
        };
      }

      if (table === 'tasks') {
        return {
          withIndex: vi.fn(() => ({
            take: vi.fn(async () => []),
          })),
        };
      }

      throw new Error(`Refused mutation unexpectedly read ${table}`);
    });
    const insert = vi.fn();
    const patch = vi.fn();
    const runMutation = vi.fn();
    const runAfter = vi.fn();

    return {
      ctx: {
        db: {
          get: vi.fn(async () => existingTask ?? null),
          query,
          insert,
          patch,
        },
        runMutation,
        scheduler: { runAfter },
      },
      query,
      insert,
      patch,
      runMutation,
      runAfter,
    };
  }

  it('refused create reaches neither insertion nor notification', async () => {
    const calls = mutationContext();

    await expect(
      registeredHandler(create)(calls.ctx, {
        token: 'token',
        streamId: 'stream' as never,
        title: 'Task',
        description: 'Work',
        submissionType: 'text',
        points: 10,
      }),
    ).rejects.toMatchObject({
      data: 'Tasks cannot be created or assigned until the programme starts on 2026-08-17.',
    });

    expect(calls.insert).not.toHaveBeenCalled();
    expect(calls.runMutation).not.toHaveBeenCalled();
  });

  it('refused proposal approval reaches neither patch nor notification', async () => {
    const calls = mutationContext({
      _id: 'task',
      streamId: 'stream',
      approvalStatus: 'pending',
      isActive: true,
      deadline: Date.UTC(2026, 7, 20),
    });

    await expect(
      registeredHandler(approveProposal)(calls.ctx, {
        token: 'token',
        taskId: 'task' as never,
      }),
    ).resolves.toEqual({
      success: false,
      error: 'Tasks cannot be created or assigned until the programme starts on 2026-08-17.',
    });

    expect(calls.patch).not.toHaveBeenCalled();
    expect(calls.runMutation).not.toHaveBeenCalled();
  });

  it('refused auto-approval reads no pending tasks and performs no side effect', async () => {
    const calls = mutationContext();

    await expect(registeredHandler(autoApproveOverdueProposals)(calls.ctx, {})).resolves.toEqual({
      published: 0,
      expired: 0,
      scheduled: 0,
    });

    expect(calls.query).toHaveBeenCalledTimes(1);
    expect(calls.query).toHaveBeenCalledWith('cohorts');
    expect(calls.patch).not.toHaveBeenCalled();
    expect(calls.runAfter).not.toHaveBeenCalled();
  });

  it('refused reactivation reaches no patch', async () => {
    const calls = mutationContext({
      _id: 'task',
      streamId: 'stream',
      isActive: false,
    });

    await expect(
      registeredHandler(update)(calls.ctx, {
        token: 'token',
        taskId: 'task' as never,
        isActive: true,
      }),
    ).resolves.toEqual({
      success: false,
      error: 'Tasks cannot be created or assigned until the programme starts on 2026-08-17.',
    });

    expect(calls.patch).not.toHaveBeenCalled();
  });
});
