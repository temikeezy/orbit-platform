import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The stable scaffold: content the specs act ON but never own.
 *
 * It is created once and reused across runs, keyed by a fixed name, because
 * streams and tasks have NO delete — only deactivation — so creating them per
 * run would leave a permanent trail on the dev deployment that grows with every
 * CI build. Actors are disposable; the things they act on are not.
 */

export const SCAFFOLD_STREAM = 'E2E Scaffold Stream';
export const SCAFFOLD_TASK = 'E2E Scaffold Task';

/**
 * The level-up ladder: several maximum-value tasks, approved in sequence.
 *
 * Task points are bounded 1..20 (convex/lib/input.ts TASK_POINTS), and level 2
 * starts at 100 points, so no single approval can cross a boundary any more.
 * Rather than award points out of band, the flow spec approves these one after
 * another until the level actually changes, so the level-up is a real
 * consequence of a real review. Five 20-point tasks are enough for any baseline
 * (100 points), before badge bonuses are counted.
 */
export const SCAFFOLD_LEVEL_TASK_PREFIX = 'E2E Scaffold Level-Up Task';
export const LEVEL_TASK_POINTS = 20;
export const LEVEL_TASK_COUNT = 5;
export const scaffoldLevelTaskTitle = (n: number) => `${SCAFFOLD_LEVEL_TASK_PREFIX} ${n}`;

/**
 * The SIWES side of the scaffold.
 *
 * A logbook needs an intern PROFILE, and a profile needs a cohort. Neither
 * cohorts nor departments can be deleted, so both are fixed-name and reused
 * across runs for the same reason the stream and task are. The profile itself is
 * per-actor and disappears with them.
 */
/** Submission type 'file', for the upload specs. */
export const SCAFFOLD_FILE_TASK = 'E2E Scaffold File Task';

/**
 * Owned exclusively by submission-review.spec.ts.
 *
 * task-flow.spec.ts already drives `taskId` and `levelTaskId` through a full
 * accept -> submit -> review cycle for the shared intern actor, and
 * uploads.spec.ts does the same to `fileTaskId`. Every spec file runs against
 * the SAME intern (one actor per role per run), and `fullyParallel` runs spec
 * files concurrently — so a second file submitting to a task another file is
 * mid-review on would race the same submission row. A dedicated task is what
 * keeps submission-review.spec.ts's own accept/submit/review cycle from
 * colliding with theirs.
 */
export const SCAFFOLD_REVIEW_TASK = 'E2E Scaffold Review Task';

/**
 * Owned exclusively by admin-console.spec.ts, for the Streams management tab.
 *
 * Kept apart from SCAFFOLD_STREAM so a deactivate/reactivate cycle there can
 * never race stream-social.spec.ts's join/leave cycle on the real one.
 */
export const SCAFFOLD_ADMIN_STREAM = 'E2E Admin Console Stream';

export const SCAFFOLD_COHORT = 'E2E Scaffold Cohort';
export const SCAFFOLD_DEPARTMENT = 'E2E Scaffold Department';

/**
 * Task-id cache, because no uncapped task lookup exists for an admin.
 *
 * tasks.listForUser gives platform staff a newest-first 2000-row window, and
 * the dev deployment holds thousands of junk tasks from the integration suite,
 * so long-lived fixtures fall out of it and would be re-created every run.
 * Ids are remembered here (outside e2e/.auth, which teardown deletes) and
 * re-validated through tasks.getById, which is immune to the cap. A cache miss
 * or a stale entry just falls back to the windowed list and then to creating.
 */
const CACHE_FILE = path.join(process.cwd(), 'node_modules', '.cache', 'orbit-e2e', 'scaffold-tasks.json');

function readTaskCache(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeTaskCache(cache: Record<string, string>): void {
  try {
    mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // Only an optimisation.
  }
}

export interface Scaffold {
  streamId: string;
  taskId: string;
  /** Ordered; see LEVEL_TASK_COUNT. */
  levelTaskIds: string[];
  fileTaskId: string;
  reviewTaskId: string;
  adminStreamId: string;
  cohortId: string;
  departmentId: string;
}

/**
 * The task titles that anchor SCAFFOLD_STREAM. When two streams carry the
 * fixture name (it has happened — see resolveFixtureStream), the one these
 * tasks live in is the one the specs have been acting on all along.
 */
const SCAFFOLD_TASK_TITLES = [
  SCAFFOLD_TASK,
  ...Array.from({ length: LEVEL_TASK_COUNT }, (_, i) => scaffoldLevelTaskTitle(i + 1)),
  SCAFFOLD_FILE_TASK,
  SCAFFOLD_REVIEW_TASK,
];

interface StreamRow {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: number;
}

interface TaskRow {
  id: string;
  title: string;
  streamId: string;
  createdAt: number;
}

export async function ensureScaffold(
  convex: ConvexHttpClient,
  token: string,
): Promise<Scaffold> {
  // No unqualified streams.list here any more. It fetched 500 rows to find two
  // by name, and on this deployment it also tripped the cap warning on every
  // single run — the resolver below asks the by_name index for exactly the rows
  // it needs instead.
  //
  // Fetched before the streams are resolved, not after: the tasks are what
  // identify the real fixture stream below.
  const tasks = (await convex.query(anyApi.tasks.listForUser, { token })) as TaskRow[];

  /**
   * Resolves a fixture stream by name, deterministically — never by `find()`.
   *
   * An unqualified `streams.list` is `.order('desc').take(500)`, and this
   * deployment holds ~2,000 streams — the vitest integration suite mints ~12
   * "Client Swap" rows per run and streams have no delete — so the fixture used
   * to AGE OUT of the visible window entirely. When it did, this lookup found
   * nothing and minted a duplicate; every later run's `find()` then returned
   * whichever same-named row the newest-first list put first — the new, EMPTY
   * stream — while the scaffold tasks still lived in the invisible original.
   * The manifest's streamId and taskIds then disagreed, and stream-scoped
   * specs broke subtly (right tasks, wrong stream) rather than loudly. The
   * name lookup is indexed now, so the window cannot hide a fixture; the
   * arbitration below still stands because three duplicates had already
   * accumulated by the time it was.
   *
   * So the anchor tasks arbitrate: the stream the OLDEST anchor task lives in
   * is the fixture, looked up among the visible name matches first and then by
   * id through `streams.getById`, which is immune to the list cap. Only a
   * stream with no anchor tasks at all (the admin stream by design, the main
   * stream on a half-finished first run) falls back to a name match — the
   * OLDEST, so consecutive runs at least keep agreeing with each other.
   */
  const resolveFixtureStream = async (
    name: string,
    anchorTaskTitles: string[],
  ): Promise<StreamRow | undefined> => {
    // Served from the `by_name` index, NOT from the capped list above: the
    // fixture is looked up by a name we already know, and the list's 500-row
    // page trims oldest-first, which is exactly the end the long-lived fixtures
    // sit at once the deployment grows. Filtering the page here is what let a
    // fixture that had aged out look absent, so a duplicate was minted under
    // the same name while the tasks stayed in the original.
    const named = (
      (await convex.query(anyApi.streams.list, {
        token,
        name,
        includeInactive: true,
      })) as StreamRow[]
    ).sort((a, b) => a.createdAt - b.createdAt);

    if (named.length > 1) {
      // Loud, because the wrong choice here does not fail here — it fails
      // three specs later as a task that is mysteriously not in its stream.
      console.warn(
        `[e2e scaffold] ${named.length} streams are named "${name}" (${named
          .map((st) => st.id)
          .join(', ')}) — a past run minted a duplicate after the original aged out ` +
          'of streams.list\'s 500-row cap. Resolving by anchor-task correlation; ' +
          'the spares cannot be deleted from here (streams have no delete API).',
      );
    }

    const anchors = tasks
      .filter((t) => anchorTaskTitles.includes(t.title))
      .sort((a, b) => a.createdAt - b.createdAt);

    if (anchors.length > 0) {
      const home = anchors[0].streamId;
      const visible = named.find((st) => st.id === home);
      if (visible) return visible;

      const recovered = (await convex.query(anyApi.streams.getById, {
        token,
        streamId: home,
      })) as StreamRow | null;
      if (recovered && recovered.name === name) {
        console.warn(
          `[e2e scaffold] "${name}" (${recovered.id}) sits past streams.list's ` +
            "500-row cap; recovered it through its tasks' streamId rather than " +
            'minting another duplicate.',
        );
        return recovered;
      }
    }

    return named[0];
  };

  let stream = await resolveFixtureStream(SCAFFOLD_STREAM, SCAFFOLD_TASK_TITLES);

  if (!stream) {
    const created = await convex.mutation(anyApi.streams.create, {
      token,
      name: SCAFFOLD_STREAM,
      description: 'Fixture stream for the end-to-end suite. Safe to leave in place.',
      privacy: 'public',
      joinType: 'open',
    });
    stream = {
      id: created.id as string,
      name: SCAFFOLD_STREAM,
      isActive: true,
      createdAt: Date.now(),
    };
  } else if (!stream.isActive) {
    // A previous run may have deactivated it. Reactivate rather than create a
    // second one with the same name.
    await convex.mutation(anyApi.streams.reactivate, { token, streamId: stream.id });
  }

  // No anchor tasks by design — this stream exists precisely so the admin
  // console's deactivate/reactivate cycle touches nothing the task specs use.
  // If it ever ages past the cap it cannot be recovered the way the main
  // stream can, and a duplicate will be minted; see resolveFixtureStream.
  let adminStream = await resolveFixtureStream(SCAFFOLD_ADMIN_STREAM, []);
  if (!adminStream) {
    const created = await convex.mutation(anyApi.streams.create, {
      token,
      name: SCAFFOLD_ADMIN_STREAM,
      description: 'Fixture stream for the admin console e2e suite. Safe to leave in place.',
      privacy: 'public',
      joinType: 'open',
    });
    adminStream = {
      id: created.id as string,
      name: SCAFFOLD_ADMIN_STREAM,
      isActive: true,
      createdAt: Date.now(),
    };
  } else if (!adminStream.isActive) {
    await convex.mutation(anyApi.streams.reactivate, { token, streamId: adminStream.id });
  }

  const ensureTask = async (
    title: string,
    points: number,
    submissionType: 'text' | 'file' = 'text',
  ): Promise<string> => {
    const cache = readTaskCache();
    const remember = (id: string) => {
      writeTaskCache({ ...readTaskCache(), [`${stream!.id}:${title}`]: id });
      return id;
    };

    const cachedId = cache[`${stream!.id}:${title}`];
    if (cachedId) {
      const found = (await convex
        .query(anyApi.tasks.getById, { token, taskId: cachedId })
        .catch(() => null)) as { id: string; title: string; streamId: string; isActive: boolean } | null;
      if (found && found.title === title && found.streamId === stream!.id && found.isActive) {
        return found.id;
      }
    }

    const existing = tasks.find((t) => t.title === title && t.streamId === stream!.id);
    if (existing) return remember(existing.id);

    const created = await convex.mutation(anyApi.tasks.create, {
      token,
      streamId: stream!.id,
      title,
      description: 'Fixture task for the end-to-end suite.',
      submissionType,
      points,
      // Far enough out that it never expires mid-run and never enters the 48h
      // reminder window, which would email every scaffold member.
      deadline: Date.now() + 365 * 86_400_000,
      notify: false,
    });

    /**
     * PUBLISHED IMMEDIATELY, because this token is an MCP session.
     *
     * Tasks created over MCP are proposals awaiting a supervisor — that is the
     * approval gate working. But the lookup above uses `listForUser`, which
     * filters proposals out, so an unpublished fixture would never be found
     * again: every run would create another invisible proposal, and every
     * intern-facing spec would fail on a task the suite thinks it created.
     * Approving here is what makes the fixture a task the stream can see.
     */
    await convex.mutation(anyApi.tasks.approveProposal, {
      token,
      taskId: created.id,
    });

    return remember(created.id as string);
  };

  const cohorts = (await convex.query(anyApi.siwes.listCohorts, { token })) as {
    id: string;
    name: string;
  }[];

  let cohortId = cohorts.find((c) => c.name === SCAFFOLD_COHORT)?.id;
  if (!cohortId) {
    const created = await convex.mutation(anyApi.siwes.saveCohort, {
      token,
      name: SCAFFOLD_COHORT,
      description: 'Fixture cohort for the end-to-end suite. Safe to leave in place.',
      // Wide enough that a log dated today is always inside the window, whenever
      // the suite happens to run.
      startDate: '2020-01-01',
      endDate: '2099-12-31',
      status: 'active',
      defaultParticipationMode: 'hybrid',
      dailyLogsRequired: true,
      weeklySummaryRequired: true,
      signoffRequired: true,
    });
    cohortId = created.id as string;
  }

  // includeInactive: true — unlike streams.list above, this was omitted here,
  // and it matters: admin-siwes.spec.ts's Departments test deliberately drives
  // this row INACTIVE and back as part of its round trip. Any run that ended
  // between those two halves (a failure, an interrupted CI job) left the real
  // fixture inactive and therefore invisible to this lookup, so the NEXT run
  // could not find it and created another one with the same name — the
  // departments table accumulated five orphaned, permanently-inactive
  // duplicates on the shared dev deployment before this was caught. Departments
  // have no delete, so those orphans are not cleanable from here; this stops
  // the count growing further.
  const departments = (await convex.query(anyApi.siwes.listDepartments, {
    token,
    includeInactive: true,
  })) as {
    id: string;
    name: string;
    isActive: boolean;
  }[];

  const existingDepartment = departments.find((d) => d.name === SCAFFOLD_DEPARTMENT);
  let departmentId = existingDepartment?.id;
  if (!departmentId) {
    const created = await convex.mutation(anyApi.siwes.saveDepartment, {
      token,
      name: SCAFFOLD_DEPARTMENT,
      description: 'Fixture department for the end-to-end suite.',
      isActive: true,
    });
    departmentId = created.id as string;
  } else if (existingDepartment && !existingDepartment.isActive) {
    // A previous run's Departments test may have ended between deactivating
    // the fixture and reactivating it. Reactivate rather than leave every
    // later run starting from an inactive fixture the admin table cannot even
    // show (see convex/siwes.ts listDepartments — inactive rows are filtered
    // out by default).
    await convex.mutation(anyApi.siwes.saveDepartment, {
      token,
      departmentId,
      name: SCAFFOLD_DEPARTMENT,
      isActive: true,
    });
  }

  return {
    streamId: stream.id,
    taskId: await ensureTask(SCAFFOLD_TASK, 10),
    levelTaskIds: await Promise.all(
      Array.from({ length: LEVEL_TASK_COUNT }, (_, i) =>
        ensureTask(scaffoldLevelTaskTitle(i + 1), LEVEL_TASK_POINTS),
      ),
    ),
    fileTaskId: await ensureTask(SCAFFOLD_FILE_TASK, 5, 'file'),
    reviewTaskId: await ensureTask(SCAFFOLD_REVIEW_TASK, 8),
    adminStreamId: adminStream.id,
    cohortId,
    departmentId,
  };
}
