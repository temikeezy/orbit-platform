import { anyApi } from 'convex/server';
import { test, expect, manifest, storageStateFor } from './support/fixtures';
import { adminToken, client } from './support/orbit';
import { SCAFFOLD_REVIEW_TASK } from './support/scaffold';

/**
 * /admin/submissions — the moderator's core screen, and guard-only until now
 * despite being 483 lines: status filter, search, and three decision types,
 * none of them exercised by anything in the suite.
 *
 * task-flow.spec.ts already proves the full accept -> submit -> review ->
 * points -> level loop end to end, on its own tasks. This file is deliberately
 * narrower and about the SCREEN rather than the loop: the status filter
 * actually filtering (it used to always reload the pending queue regardless of
 * the selection — see the comment in SubmissionReviewPage.tsx), search
 * narrowing the list, the empty state, and both non-approval decisions'
 * validation (feedback is mandatory for anything but an approval).
 *
 * `scaffold.reviewTaskId` belongs to this file alone — see scaffold.ts for
 * why sharing a task with another spec file would race it under
 * `fullyParallel`. A submission cannot be resubmitted once approved, so the
 * one narrative here is submit -> request changes -> resubmit -> approve
 * (with partial points); the reject decision's own validation is exercised
 * without spending the submission's one remaining life on a second terminal
 * state that would need a task of its own to reach.
 */

test.describe.configure({ mode: 'serial' });

/**
 * The queue row for this test's own submission, and only that one.
 *
 * `fullyParallel` runs task-flow.spec.ts against the SAME shared intern at the
 * same time, and its submissions sit in the same "Pending Review" queue this
 * file searches. A locator scoped only to the intern's name matched BOTH rows
 * whenever the two files overlapped — `getByRole('button', { name:
 * intern.fullName })` resolved to two elements and every click after it
 * either hit strict mode or, worse, clicked whichever row happened to render
 * first. Scoping to `SCAFFOLD_REVIEW_TASK`'s own title as well is what makes
 * this file's queries only ever see the task it owns.
 */
const theRow = (adminPage: import('@playwright/test').Page, fullName: string) =>
  adminPage.getByRole('button', { name: new RegExp(fullName) }).filter({ hasText: SCAFFOLD_REVIEW_TASK });

test('the review screen: filters, search, validation, and points on approval', async ({
  browser,
}) => {
  const { scaffold, users } = manifest();
  const convex = client();
  const token = await adminToken(convex);
  const intern = users.find((u) => u.role === 'intern')!;

  const before = await convex.query(anyApi.users.adminGetById, { token, userId: intern.id });
  const pointsBefore = before.totalPoints ?? 0;

  const internContext = await browser.newContext({ storageState: storageStateFor('intern') });
  const internPage = await internContext.newPage();

  const adminContext = await browser.newContext({ storageState: storageStateFor('admin') });
  const adminPage = await adminContext.newPage();

  // --- the intern submits ---------------------------------------------------
  await internPage.goto(`/tasks/${scaffold.reviewTaskId}`);
  await internPage.getByRole('button', { name: 'Accept Task' }).click();
  await internPage.getByPlaceholder('Enter your submission here...').fill('E2E review attempt one');
  await internPage.getByRole('button', { name: 'Submit Task' }).click();
  // The COMMIT is what everything after this depends on, and neither the
  // button nor the typed text can witness it: the click swaps the button label
  // to "Submitting..." immediately (so `Submit Task` has count 0 milliseconds
  // later), and getByText on the submission text matches the TEXTAREA'S OWN
  // VALUE — the words this test just typed. Both were observed passing within
  // 1ms of the click while the write was still in flight, letting the
  // reviewer's half run against a submission that did not exist yet.
  //
  // The form unmounting is a real signal: handleSubmit awaits the mutation and
  // only then reloads, and the submitted state renders no form. "Submitted on"
  // belongs to the panel that replaces it.
  await expect(internPage.getByPlaceholder('Enter your submission here...')).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(internPage.getByText('Submitted on').first()).toBeVisible({ timeout: 20_000 });

  // --- the reviewer finds it under the default (Pending Review) filter -----
  await adminPage.goto('/admin/submissions');
  await adminPage.getByPlaceholder('Search submissions...').fill(intern.fullName);
  const row = theRow(adminPage, intern.fullName);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();

  // --- decision selection changes the feedback prompt -----------------------
  await adminPage.getByRole('button', { name: 'Reject' }).click();
  await expect(
    adminPage.getByPlaceholder('Explain why this submission is being rejected...'),
  ).toBeVisible();

  // --- feedback is mandatory for anything but an approval --------------------
  await adminPage.getByRole('button', { name: /submit review/i }).click();
  await expect(adminPage.getByText('Please provide feedback')).toBeVisible();

  // --- switch the decision to Request Changes and complete it ---------------
  await adminPage.getByRole('button', { name: 'Request Changes' }).click();
  await expect(
    adminPage.getByPlaceholder('Explain what changes are needed...'),
  ).toBeVisible();
  await adminPage.getByPlaceholder('Explain what changes are needed...').fill('Needs more detail.');

  await adminPage.getByRole('button', { name: /submit review/i }).click();

  await expect
    .poll(
      async () => {
        const rows = (await convex.query(anyApi.tasks.listSubmissions, {
          token,
          taskId: scaffold.reviewTaskId,
          userId: intern.id,
        })) as { status: string }[];
        return rows[0]?.status;
      },
      { message: 'the request-changes decision never reached the submission', timeout: 20_000 },
    )
    .toBe('changes_requested');

  /**
   * "A request-changes decision awards exactly zero" is NOT asserted here, and
   * deliberately so — it cannot be proved from this layer.
   *
   * It used to be, as a delta on the intern's `totalPoints` taken as tightly
   * around the click as possible. That is unprovable no matter how tight the
   * window: `totalPoints` is a per-USER global, every spec file runs against
   * the SAME intern (one actor per role per run — see scaffold.ts), and
   * `fullyParallel` runs task-flow.spec.ts's 100-point level-up approval
   * against that actor concurrently. The delta observed a real +115 from
   * task-flow's award landing inside the ~20s poll above and failed a spec
   * whose own subject was working correctly. Tightening the baseline narrows
   * the window; it never closes it, because the quantity being measured is
   * shared and the measurement is not atomic.
   *
   * The invariant is real and is now pinned where it can be exact, against
   * `reviewSubmission`'s returned `points` rather than a shared total:
   * src/test/integration/convex-client-swap.test.ts, "the points ledger pays
   * exactly once". Those tests also cover the reversal (-5, not merely
   * negative), re-scoring paying the difference, and the repeat approval
   * paying nothing — none of which this layer could ever distinguish.
   *
   * What this file keeps is what it alone can see: that the decision made
   * through the real screen actually reaches the submission, asserted by the
   * poll above.
   */

  // --- the status filter actually filters ------------------------------------
  await adminPage.getByPlaceholder('Search submissions...').fill('');
  // The one <select> on the page — its <label> is a sibling, not a wrapper or
  // an htmlFor/id pair, so it carries no accessible name for getByLabel.
  const statusFilter = adminPage.locator('select');

  /**
   * Select, then confirm the DOM actually took it, before doing anything else.
   *
   * Changing this filter re-fetches through SubmissionReviewPage's own
   * loading-gated render (`if (loading) return <spinner>`), which unmounts
   * and rebuilds this whole screen — the dev deployment's "Pending Review"
   * queue alone carries hundreds of rows left behind by past runs that never
   * tore down cleanly, so that rebuild is not always fast. A `selectOption`
   * issued while the PREVIOUS filter's fetch is still resolving has, in
   * practice, been silently lost — the select re-rendered back to the value
   * React's own state already held before the click landed. Confirming the
   * value here, and retrying once if it did not take, is what makes every
   * later assertion about "what the list shows" trustworthy.
   */
  async function selectStatus(status: string) {
    await expect
      .poll(
        async () => {
          await statusFilter.selectOption(status);
          return statusFilter.inputValue();
        },
        { message: `the status filter never settled on "${status}"`, timeout: 20_000 },
      )
      .toBe(status);
  }

  await selectStatus('changes_requested');
  await expect(theRow(adminPage, intern.fullName)).toBeVisible({ timeout: 20_000 });

  await selectStatus('approved');
  await expect(theRow(adminPage, intern.fullName)).toHaveCount(0, { timeout: 20_000 });

  // --- the empty state, forced with a search term rather than deleted data --
  await selectStatus('changes_requested');
  await adminPage.getByPlaceholder('Search submissions...').fill('zzz-nothing-matches-this-zzz');
  await expect(adminPage.getByText('No submissions found')).toBeVisible();
  await adminPage.getByPlaceholder('Search submissions...').fill('');

  // --- the intern resubmits — 'changes_requested' is the one non-approved
  // status the task detail page still offers a form for ------------------
  await internPage.reload();
  await internPage.getByPlaceholder('Enter your submission here...').fill('E2E review attempt two');
  await internPage.getByRole('button', { name: 'Submit Task' }).click();
  // Same as attempt one: the form unmounting is the commit signal. Under a
  // loaded machine the gap between the click and the commit stretched wide
  // enough for the whole reviewer flow to run inside it — the reviewer's
  // queue then legitimately reads 'changes_requested', shows no Approve
  // button, and nothing ever refetches.
  await expect(internPage.getByPlaceholder('Enter your submission here...')).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(internPage.getByText('Submitted on').first()).toBeVisible({ timeout: 20_000 });

  // --- the reviewer approves it, with PARTIAL points -------------------------
  /**
   * THE REGRESSION TEST FOR A REAL DEFECT THIS SPEC FOUND.
   *
   * `convex/tasks.ts`'s reviewQueue — what the "Pending Review" filter maps to
   * — ordered the `submitted` status by document `_creationTime` and capped at
   * 50 rows. Resubmitting PATCHES the existing row rather than inserting a new
   * one, so a resubmission kept the creation time of the member's FIRST
   * attempt. Once the pending backlog exceeded one page, resubmitted work was
   * reliably below the fold: the reviewer asks for changes, the member does
   * them, and the reviewer is never shown the result. No amount of waiting
   * fixes that, because the ordering itself was wrong.
   *
   * It only reproduces on a deployment with a real backlog — this one carries
   * 170+ stale `submitted` rows from runs that never tore down — which is
   * precisely why nobody found it by hand. reviewQueue now orders by
   * `submittedAt`, the field that actually moves on resubmission, via a
   * dedicated index. This assertion is what keeps it that way.
   */
  await selectStatus('submitted');
  await adminPage.getByPlaceholder('Search submissions...').fill(intern.fullName);
  await expect(theRow(adminPage, intern.fullName)).toBeVisible({ timeout: 20_000 });
  await theRow(adminPage, intern.fullName).click();

  await adminPage.getByRole('button', { name: 'Approve' }).click();
  // Same story as the status filter: "Points to Award" is a sibling label,
  // not an associated one, and this is the only number input on the page.
  const scoreInput = adminPage.locator('input[type="number"]');
  await scoreInput.fill('5');
  await adminPage
    .getByPlaceholder('Provide positive feedback (optional)')
    .fill('Better — approved with a partial score.');
  await adminPage.getByRole('button', { name: /submit review/i }).click();

  await expect
    .poll(
      async () => {
        const rows = (await convex.query(anyApi.tasks.listSubmissions, {
          token,
          taskId: scaffold.reviewTaskId,
          userId: intern.id,
        })) as { status: string; score?: number }[];
        return rows[0]?.status;
      },
      { message: 'the approval never reached the submission', timeout: 20_000 },
    )
    .toBe('approved');

  const submissionRows = (await convex.query(anyApi.tasks.listSubmissions, {
    token,
    taskId: scaffold.reviewTaskId,
    userId: intern.id,
  })) as { score?: number }[];
  expect(submissionRows[0].score).toBe(5);

  // Awarded, and not more than what was actually approved plus whatever badge
  // bonuses fire at this total — never less than the score just entered.
  const afterApproved = await convex.query(anyApi.users.adminGetById, { token, userId: intern.id });
  expect(afterApproved.totalPoints ?? 0).toBeGreaterThanOrEqual(pointsBefore + 5);

  await internContext.close();
  await adminContext.close();
});
