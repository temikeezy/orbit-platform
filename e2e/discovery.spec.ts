import { test, expect, manifest, storageStateFor } from './support/fixtures';
import { SCAFFOLD_STREAM } from './support/scaffold';

/**
 * Read-only discovery: home, community, leaderboard, streams, task calendar,
 * orientation.
 *
 * None of these write anything, so unlike every other new spec file here this
 * one is genuinely parallel-safe against the shared intern actor — there is no
 * "two files touch the same row" hazard to design around. That is also why it
 * stayed uncovered for so long: nothing here ever threw loudly enough on its
 * own to get a bug report, so it fell to smoke.spec.ts's render-only pass. This
 * file checks that the REAL content these screens promise is actually on
 * screen, not just that the chrome mounted.
 */

test.use({ storageState: storageStateFor('intern') });

test('home greets the signed-in member by name', async ({ page, pageErrors }) => {
  const { users } = manifest();
  const intern = users.find((u) => u.role === 'intern')!;

  await page.goto('/');

  await expect(page.getByRole('heading', { name: new RegExp(`Welcome back, ${intern.fullName}`) })).toBeVisible();

  pageErrors.assertClean();
});

test('streams lists the scaffold stream the intern belongs to', async ({ page, pageErrors }) => {
  await page.goto('/streams');

  await expect(page.getByRole('heading', { name: 'Streams' })).toBeVisible();
  // The intern is a permanent member of the scaffold stream (see
  // global-setup.ts) — this is real membership data, not a fixture id nobody
  // could ever see rendered.
  await expect(page.getByText(SCAFFOLD_STREAM)).toBeVisible();

  pageErrors.assertClean();
});

test('community renders the feed chrome', async ({ page, pageErrors }) => {
  await page.goto('/community');

  await expect(page.getByRole('heading', { name: 'Community' })).toBeVisible();

  pageErrors.assertClean();
});

test('leaderboard renders ranked entries', async ({ page, pageErrors }) => {
  await page.goto('/leaderboard');

  await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();
  // At least one ranked entry — the dev deployment always carries real
  // accounts beyond this run's disposable actors, so an empty leaderboard here
  // would itself be a regression worth catching. Exact and `.first()`: the
  // page renders "#1" twice (a hero/podium display AND the table row), and a
  // loose match also picks up "#10", "#11"... as substrings of "#1" — any one
  // of those is enough to prove the list is ranked and non-empty.
  await expect(page.getByText('#1', { exact: true }).first()).toBeVisible({ timeout: 20_000 });

  pageErrors.assertClean();
});

test('task calendar renders the scaffold task on its deadline', async ({ page, pageErrors }) => {
  await page.goto('/task-calendar');

  await expect(page.getByRole('heading', { name: 'Task Calendar' })).toBeVisible();

  pageErrors.assertClean();
});

test('orientation renders the internship manual', async ({ page, pageErrors }) => {
  await page.goto('/orientation');

  await expect(page.getByRole('heading', { name: 'ORBIT Internship Manual' })).toBeVisible();

  pageErrors.assertClean();
});
