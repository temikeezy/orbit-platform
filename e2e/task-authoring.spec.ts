import { anyApi } from 'convex/server';
import { test, expect, manifest, storageStateFor } from './support/fixtures';
import { adminToken, client } from './support/orbit';
import { SCAFFOLD_STREAM } from './support/scaffold';

/**
 * Task authoring: creating, editing and proposing tasks, and the one write
 * path in this group that has NO client-side guard at all.
 *
 * /streams/:id/add-task and /tasks/:id/edit gate on STREAM moderation, not the
 * global `moderator` role — smoke.spec.ts already proves both refuse the
 * scaffold moderator actor (who is a stream MEMBER, never granted the
 * stream-moderator row) exactly like an intern, and refuse with page-owned
 * prose that never says "denied". This file is the functional half: what an
 * actually-permitted admin can do through those forms, and — the highest-value
 * test here — what happens when /streams/:id/edit, which has no gate of its
 * own, is reached by someone the SERVER refuses anyway.
 *
 * Task titles double as the idempotency key for anything this file creates
 * permanently (tasks have no delete): each create-path checks for its own
 * fixed title before touching the form, so a re-run reuses the fixture rather
 * than growing the stream by one task per CI run.
 */

test.describe.configure({ mode: 'serial' });
test.use({ storageState: storageStateFor('admin') });

const ADD_TASK_FIXTURE = 'E2E Add-Task Form Fixture';
const APPROVED_PROPOSAL_FIXTURE = 'E2E Task Proposal Approved Fixture';

/**
 * A value the Deadline field will actually accept.
 *
 * The input is `type="datetime-local"`, which needs `YYYY-MM-DDTHH:mm` — a
 * date-only string makes `fill()` throw "Malformed value". This went unnoticed
 * because the test that uses it skips once its fixture task exists, so the form
 * was only ever driven on a deployment where the fixture was missing.
 */
function tomorrowPlus(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.toISOString().split('T')[0]}T23:59`;
}

test('an admin creates a task through the add-task form, once', async ({ page }) => {
  const { scaffold } = manifest();
  const convex = client();
  const token = await adminToken(convex);

  const already = (
    (await convex.query(anyApi.tasks.listForUser, { token })) as {
      title: string;
      streamId: string;
    }[]
  ).some((t) => t.title === ADD_TASK_FIXTURE && t.streamId === scaffold.streamId);

  if (already) {
    // Created by an earlier run. Re-submitting the form would create a SECOND
    // task with this title — tasks have no delete — so the fixture is reused
    // rather than grown, the same discipline as scaffold.ts's ensureTask.
    test.skip(true, 'the add-task fixture already exists from a previous run');
    return;
  }

  await page.goto(`/streams/${scaffold.streamId}/add-task`);

  // The route does not thread streamId into the component as a prop — it is
  // never read via useParams either — so the dropdown starts unselected and
  // has to be chosen by hand, not merely accepted as a preselected default.
  //
  // getByLabel('Stream') is a real trap here, not just a redundant one: the
  // fixed mobile tab bar (MobileTabBar.tsx) renders a `<button aria-label=
  // "Streams">` on every page, `md:hidden` but still attached to the DOM at
  // desktop widths, and "Stream" is a substring of "Streams". Immediately
  // after navigation the <select id="stream"> has not mounted yet (it is
  // behind the async loadStreams() fetch), so getByLabel('Stream') resolves
  // to exactly the nav button — a single, strict match — and Playwright locks
  // onto that element handle and polls its visibility for the full test
  // timeout, never re-resolving to notice the select appear moments later.
  // Scoping to role=combobox sidesteps the button entirely.
  await page.getByRole('combobox', { name: 'Stream' }).selectOption({ label: SCAFFOLD_STREAM });
  await page.getByLabel('Task Title').fill(ADD_TASK_FIXTURE);
  await page
    .getByLabel('Description')
    .fill('Created once by the e2e suite to prove the add-task form actually writes a task.');
  await page.getByLabel('Deadline').fill(tomorrowPlus(300));
  await page.getByRole('button', { name: 'Create Task' }).click();

  await expect
    .poll(
      async () => {
        const tasks = (await convex.query(anyApi.tasks.listForUser, { token })) as {
          title: string;
          streamId: string;
        }[];
        return tasks.some((t) => t.title === ADD_TASK_FIXTURE && t.streamId === scaffold.streamId);
      },
      { message: 'the add-task form never wrote a task', timeout: 20_000 },
    )
    .toBe(true);
});

test("an admin's edit round-trips a task's description and leaves its title alone", async ({
  page,
}) => {
  const { scaffold } = manifest();
  const convex = client();
  const token = await adminToken(convex);

  const before = await convex.query(anyApi.tasks.getById, { token, taskId: scaffold.taskId });
  const original = before.description as string;
  const deadlineBefore = before.deadline as number;
  const updated = `${original} (edited by e2e ${Date.now()})`;

  await page.goto(`/tasks/${scaffold.taskId}/edit`);
  await page.getByLabel('Description').fill(updated);
  await page.getByRole('button', { name: 'Update Task' }).click();

  await expect
    .poll(
      async () => {
        const task = await convex.query(anyApi.tasks.getById, { token, taskId: scaffold.taskId });
        return task.description;
      },
      { message: 'the edit never reached the task', timeout: 20_000 },
    )
    .toBe(updated);

  /**
   * The deadline must survive an edit that never touched it. EditTaskPage only
   * sends `deadline` when the field was actually edited (its deadlineDirty
   * ref), so this description-only update sends none — which is exactly the
   * shape of convex/lib/patch.ts's failure mode: `ctx.db.patch` REMOVES a
   * field passed as `undefined`, so an update handler that forwarded absent
   * args unconditionally would wipe the deadline on every such edit. The unit
   * test for deadline preservation asserts only against a stubbed client
   * payload; this read-back is the one place a server-side wipe shows up.
   */
  const afterEdit = await convex.query(anyApi.tasks.getById, { token, taskId: scaffold.taskId });
  expect(afterEdit.deadline, 'a description-only edit must not move the deadline').toBe(
    deadlineBefore,
  );

  // Restored. SCAFFOLD_TASK's TITLE is the lookup key ensureScaffold uses on
  // every future run — this test never touches it — but leaving the
  // description permanently mutated would still make every later run's first
  // read of "the scaffold task" a slightly different fixture than the last.
  await page.goto(`/tasks/${scaffold.taskId}/edit`);
  await page.getByLabel('Description').fill(original);
  await page.getByRole('button', { name: 'Update Task' }).click();

  await expect
    .poll(async () => {
      const task = await convex.query(anyApi.tasks.getById, { token, taskId: scaffold.taskId });
      return task.description;
    }, { timeout: 20_000 })
    .toBe(original);
});

test('a moderator declines a proposal, which deletes it, and approves another, which publishes it', async ({
  page,
}) => {
  const { scaffold } = manifest();
  const convex = client();
  const token = await adminToken(convex);

  // --- decline: always fresh, always self-cleaning -------------------------
  //
  // declineProposal DELETES the row (see convex/tasks.ts) — there is nothing
  // to leak, so this half needs no existence guard.
  const declineTitle = `E2E Proposal Decline ${Date.now()}`;
  const declined = await convex.mutation(anyApi.tasks.create, {
    token,
    streamId: scaffold.streamId,
    title: declineTitle,
    description: 'Drafted by the e2e suite to be declined.',
    submissionType: 'text',
    points: 8,
    deadline: Date.now() + 30 * 86_400_000,
    notify: false,
  });
  // Created over the MCP session, so it lands as a pending proposal (see
  // scaffold.ts's ensureTask comment on why that token always proposes).
  expect(declined.approvalStatus).toBe('pending');

  await page.goto('/tasks/proposals');
  const declineCard = page.locator('li').filter({ hasText: declineTitle });
  await expect(declineCard).toBeVisible({ timeout: 20_000 });
  await declineCard.getByRole('button', { name: 'Decline' }).click();
  await declineCard.getByRole('button', { name: 'Confirm decline' }).click();

  await expect
    .poll(
      async () => (await convex.query(anyApi.tasks.getById, { token, taskId: declined.id })) === null,
      { message: 'the declined proposal was not deleted', timeout: 20_000 },
    )
    .toBe(true);

  // --- approve: idempotent, because publishing is permanent -----------------
  const existingApproved = (
    (await convex.query(anyApi.tasks.listForUser, { token })) as { title: string }[]
  ).some((t) => t.title === APPROVED_PROPOSAL_FIXTURE);

  if (existingApproved) {
    test.skip(true, 'the approve fixture was already published by a previous run');
    return;
  }

  const proposal = await convex.mutation(anyApi.tasks.create, {
    token,
    streamId: scaffold.streamId,
    title: APPROVED_PROPOSAL_FIXTURE,
    description: 'Drafted by the e2e suite to be approved and published, once.',
    submissionType: 'text',
    points: 8,
    deadline: Date.now() + 30 * 86_400_000,
    notify: false,
  });
  expect(proposal.approvalStatus).toBe('pending');

  await page.goto('/tasks/proposals');
  const approveCard = page.locator('li').filter({ hasText: APPROVED_PROPOSAL_FIXTURE });
  await expect(approveCard).toBeVisible({ timeout: 20_000 });
  await approveCard.getByRole('button', { name: 'Approve and publish' }).click();

  await expect
    .poll(
      async () => {
        const task = await convex.query(anyApi.tasks.getById, { token, taskId: proposal.id });
        return task?.approvalStatus;
      },
      { message: 'the approval never reached the task', timeout: 20_000 },
    )
    .toBe('approved');

  // Published means visible to the stream, not merely flagged internally.
  const forMembers = (await convex.query(anyApi.tasks.listForUser, {
    token,
  })) as { title: string }[];
  expect(forMembers.some((t) => t.title === APPROVED_PROPOSAL_FIXTURE)).toBe(true);
});

test.describe('editing a stream with no client-side guard', () => {
  test.use({ storageState: storageStateFor('intern') });

  test("the server refuses an intern's edit, and the stream is unchanged", async ({ page }) => {
    /**
     * The highest-value test in this file. EditStreamPage.tsx renders its form
     * for ANY signed-in role — there is no permission check on the page at all,
     * unlike every other authoring screen here. The only thing standing between
     * an intern and renaming a public stream is convex/streams.ts's `update`
     * mutation throwing 'Admin or stream moderator access required'. This
     * proves both halves: the write is refused, AND nothing changed — a screen
     * that merely swallowed the error while still looking like it saved would
     * pass a test that checked only the first half.
     */
    const { scaffold } = manifest();
    const convex = client();
    const token = await adminToken(convex);

    const before = await convex.query(anyApi.streams.getById, {
      token,
      streamId: scaffold.streamId,
    });

    await page.goto(`/streams/${scaffold.streamId}/edit`);
    await page.getByLabel('Description').fill(`Hijacked by an intern ${Date.now()}`);
    await page.getByRole('button', { name: 'Save Changes' }).click();

    await expect(page.getByText(/admin or stream moderator access required/i)).toBeVisible({
      timeout: 20_000,
    });

    const after = await convex.query(anyApi.streams.getById, {
      token,
      streamId: scaffold.streamId,
    });
    expect(after.description).toBe(before.description);
    // The name is the lookup key every future run's ensureScaffold uses — it
    // must survive a REJECTED edit even more certainly than an accepted one.
    expect(after.name).toBe(SCAFFOLD_STREAM);
  });
});
