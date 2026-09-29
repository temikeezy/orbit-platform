import { anyApi } from 'convex/server';
import { test, expect, manifest, storageStateFor } from './support/fixtures';
import { adminToken, client } from './support/orbit';
import { SCAFFOLD_TASK, scaffoldLevelTaskTitle } from './support/scaffold';

/**
 * The queue row for one specific submission, not merely "a row naming this
 * intern".
 *
 * `fullyParallel` runs submission-review.spec.ts and uploads.spec.ts against
 * the SAME shared intern actor at the same time as this file, and their own
 * submissions land in the same "Pending Review" admin queue this file
 * searches. `getByText(intern.fullName).first()` picked whichever row
 * happened to render first — sometimes another file's submission — so this
 * file could approve or reject the WRONG task's work while believing it had
 * acted on its own. Scoping to the owning task's title as well is what keeps
 * each test acting only on the submission it created.
 */
const theRow = (adminPage: import('@playwright/test').Page, fullName: string, taskTitle: string) =>
  adminPage.getByRole('button', { name: new RegExp(fullName) }).filter({ hasText: taskTitle });

/**
 * The badge celebration is a full-screen scrim (z-9997) shown on app mount when
 * the account has more badges than this browser last saw. The shared intern is
 * awarded badges by other spec files and by earlier approvals in this one, so
 * any navigation can land behind it and every click then times out on
 * "subtree intercepts pointer events". It is dismissed, not asserted on.
 */
async function dismissBadgeCelebration(page: import('@playwright/test').Page) {
  await page
    .getByRole('button', { name: /Claim Glory/ })
    .click({ timeout: 2_500 })
    .catch(() => {});
}

/**
 * F1 — the core value loop: accept -> submit -> review -> points -> level.
 *
 * This is the loop the whole platform exists for, and before this spec it was
 * untested at every layer. It is driven entirely through the UI on both sides —
 * intern and reviewer — because the defects that survived to production were in
 * the wiring between screens, not in the mutations.
 *
 * The ledger and the user record are read back through the API afterwards. A
 * green screen is not evidence the points landed: the Supabase version issued
 * the submission update, the ledger insert and the points increment as three
 * independent browser calls and checked none of their results, so "Approved"
 * could appear with no points awarded.
 */

test.describe.configure({ mode: 'serial' });

test('an intern accepts and submits, an admin approves, and the points land and the level rises', async ({
  browser,
}) => {
  // One approval can no longer cross a level boundary (task points are capped
  // at 20), so this walks the scaffold's level-up ladder: submit + approve one
  // task at a time and stop at the approval that changes the level.
  test.setTimeout(240_000);

  const { scaffold, users } = manifest();
  const convex = client();
  const token = await adminToken(convex);

  const intern = users.find((u) => u.role === 'intern')!;

  // A BASELINE, not an assumption of zero: `fullyParallel` runs other spec
  // files against this same intern, so every check is a DELTA off this.
  const before = await convex.query(anyApi.users.adminGetById, { token, userId: intern.id });

  const internContext = await browser.newContext({ storageState: storageStateFor('intern') });
  const internPage = await internContext.newPage();
  const adminContext = await browser.newContext({ storageState: storageStateFor('admin') });
  const adminPage = await adminContext.newPage();

  const readUser = () => convex.query(anyApi.users.adminGetById, { token, userId: intern.id });

  let crossedAt = -1;
  let awardedByCrossing = 0;

  for (let i = 0; i < scaffold.levelTaskIds.length; i++) {
    const taskId = scaffold.levelTaskIds[i];
    const title = scaffoldLevelTaskTitle(i + 1);
    const levelBefore = (await readUser()).currentLevel as number;
    const pointsBefore = ((await readUser()).totalPoints ?? 0) as number;

    // --- the intern's half ---------------------------------------------
    await internPage.goto(`/tasks/${taskId}`);
    await expect(internPage.getByRole('button', { name: 'Accept Task' })).toBeVisible();
    await dismissBadgeCelebration(internPage);
    await internPage.getByRole('button', { name: 'Accept Task' }).click();
    await internPage
      .getByPlaceholder('Enter your submission here...')
      .fill(`E2E submission ${i + 1} ${Date.now()}`);
    await internPage.getByRole('button', { name: 'Submit Task' }).click();

    // The form unmounting is the commit signal (see the reject test below).
    await expect(internPage.getByPlaceholder('Enter your submission here...')).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(internPage.getByText('Submitted on').first()).toBeVisible({ timeout: 20_000 });

    // --- the reviewer's half -------------------------------------------
    await adminPage.goto('/admin/submissions');
    await expect(theRow(adminPage, intern.fullName, title)).toBeVisible({ timeout: 20_000 });
    await theRow(adminPage, intern.fullName, title).click();

    await adminPage.getByRole('button', { name: 'Approve' }).click();
    await adminPage
      .getByPlaceholder('Provide positive feedback (optional)')
      .fill('Approved by the E2E suite.');
    await adminPage.getByRole('button', { name: /submit review/i }).click();

    // The award is what has to have landed: at least this task's own points
    // (badge bonuses may add more, so not an exact total).
    await expect
      .poll(async () => ((await readUser()).totalPoints ?? 0) - pointsBefore, {
        message: `approval ${i + 1} never awarded its points`,
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(20);

    const levelAfter = (await readUser()).currentLevel as number;
    if (levelAfter > levelBefore) {
      crossedAt = i;
      awardedByCrossing = ((await readUser()).totalPoints ?? 0) - pointsBefore;
      break;
    }
  }

  expect(
    crossedAt,
    `${scaffold.levelTaskIds.length} approvals of 20 points never crossed a level boundary`,
  ).toBeGreaterThanOrEqual(0);
  expect(awardedByCrossing).toBeGreaterThanOrEqual(20);

  const after = await readUser();

  // The level must be what the real ladder says for the real total.
  const levelInfo = (await convex.query(anyApi.levels.infoForPoints, {
    points: after.totalPoints ?? 0,
  })) as { current: { levelNumber: number } } | null;
  expect(levelInfo, 'the level ladder must have at least one level configured').not.toBeNull();
  expect(after.currentLevel).toBe(levelInfo!.current.levelNumber);
  expect(after.currentLevel).toBeGreaterThan(before.currentLevel);

  // Badge chain off the back of the approvals.
  const earned = (await convex.query(anyApi.badges.listForUser, {
    token,
    userId: intern.id,
  })) as { name: string }[];
  expect(earned.map((b) => b.name)).toEqual(
    expect.arrayContaining(['First Steps', 'Rising Star']),
  );

  // --- the celebration ------------------------------------------------
  // The intern's session recorded the old level when it first rendered;
  // reloading now is the first time it sees the new one.
  await internPage.reload();
  await expect(internPage.getByText('Level Up! 🚀')).toBeVisible();
  await expect(internPage.getByText(/You've reached/)).toBeVisible();

  await internContext.close();
  await adminContext.close();
});

test('a rejected submission awards nothing', async ({ browser }) => {
  const { scaffold, users } = manifest();
  const convex = client();
  const token = await adminToken(convex);

  const intern = users.find((u) => u.role === 'intern')!;

  const internContext = await browser.newContext({ storageState: storageStateFor('intern') });
  const internPage = await internContext.newPage();

  await internPage.goto(`/tasks/${scaffold.taskId}`);
  await internPage.getByRole('button', { name: 'Accept Task' }).click();
  await internPage.getByPlaceholder('Enter your submission here...').fill('Deliberately poor work');
  await internPage.getByRole('button', { name: 'Submit Task' }).click();
  // Committed, not merely clicked — see the first test for why neither the
  // button nor the typed text is the signal it looks like.
  await expect(internPage.getByPlaceholder('Enter your submission here...')).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(internPage.getByText('Submitted on').first()).toBeVisible({ timeout: 20_000 });

  const adminContext = await browser.newContext({ storageState: storageStateFor('admin') });
  const adminPage = await adminContext.newPage();

  await adminPage.goto('/admin/submissions');
  await expect(theRow(adminPage, intern.fullName, SCAFFOLD_TASK)).toBeVisible({ timeout: 20_000 });
  await theRow(adminPage, intern.fullName, SCAFFOLD_TASK).click();

  await adminPage.getByRole('button', { name: 'Reject' }).click();
  // Feedback is mandatory for anything but an approval, and the server enforces
  // it too — a rejection with no reason is useless to the person receiving it.
  await adminPage
    .getByPlaceholder('Explain why this submission is being rejected...')
    .fill('Does not meet the brief.');
  await adminPage.getByRole('button', { name: /submit review/i }).click();

  // The panel closing is the UI's own commit signal — the review screen only
  // clears the selected submission after its mutation resolves, so the write
  // has round-tripped by the time the form is gone.
  await expect(adminPage.getByRole('button', { name: /submit review/i })).toHaveCount(0, {
    timeout: 20_000,
  });

  /**
   * Asserted on THIS submission, never on the intern's totalPoints. This used
   * to sleep 3s and then require the shared total's delta to be exactly zero —
   * but totalPoints is a per-USER global, every spec file runs against the
   * same shared intern, and `fullyParallel` means submission-review.spec.ts's
   * +5 partial approval or uploads.spec.ts's file-task award can land inside
   * that window and fail a rejection that worked perfectly. The submission row
   * is the fact this layer owns: its status is 'rejected', and it carries no
   * score — the reject flow sends none (SubmissionReviewPage only sends a
   * score for approvals), and the score is what the ledger pays. That the
   * ledger pays exactly the score, and pays nothing for a non-approval, is
   * pinned where it can be exact, against reviewSubmission's own return:
   * src/test/integration/convex-client-swap.test.ts's ledger-pays-once tests.
   */
  await expect
    .poll(
      async () => {
        const rows = (await convex.query(anyApi.tasks.listSubmissions, {
          token,
          taskId: scaffold.taskId,
          userId: intern.id,
        })) as { status: string }[];
        return rows[0]?.status;
      },
      { message: 'the rejection never reached the submission', timeout: 20_000 },
    )
    .toBe('rejected');

  const [submission] = (await convex.query(anyApi.tasks.listSubmissions, {
    token,
    taskId: scaffold.taskId,
    userId: intern.id,
  })) as { status: string; score?: number | null }[];
  expect(submission.score ?? 0, 'a rejected submission must carry no score').toBe(0);

  await internContext.close();
  await adminContext.close();
});
