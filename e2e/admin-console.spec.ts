import { anyApi } from 'convex/server';
import { test, expect, storageStateFor } from './support/fixtures';
import { adminToken, client } from './support/orbit';
import { SCAFFOLD_ADMIN_STREAM, SCAFFOLD_TASK } from './support/scaffold';

/**
 * The admin console's other eight tabs.
 *
 * smoke.spec.ts's route inventory now RENDERS every one of these for
 * admin/super_admin and refuses them (once, at the shared '/admin' guard) for
 * everyone else — see support/routes.ts. What it deliberately does not do is
 * click anything inside them, which is exactly where four of these tabs live:
 * Levels, Badges, Email Logs and Backup Management are reachable ONLY through
 * a callback from Gamification or Settings, never from a URL, so nothing
 * outside this file has ever exercised that wiring or proved the Back button
 * actually returns to the tab it came from.
 *
 * Streams and Tasks get their own dedicated fixture (SCAFFOLD_ADMIN_STREAM) or
 * read-only queries (SCAFFOLD_TASK) rather than touching the primary
 * scaffold — see scaffold.ts for why a second stream exists at all.
 */

test.describe.configure({ mode: 'serial' });
test.use({ storageState: storageStateFor('admin') });

test('Streams tab: deactivate and reactivate round-trip through the UI', async ({ page }) => {
  const convex = client();
  const token = await adminToken(convex);

  page.on('dialog', (d) => d.accept());

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Streams', exact: true }).first().click();
  await expect(page.getByText('Stream Management')).toBeVisible();

  const row = page
    .locator('div.bg-white.rounded-lg.shadow-sm.border.border-slate-200.p-6')
    .filter({ hasText: SCAFFOLD_ADMIN_STREAM });
  await expect(row).toBeVisible({ timeout: 20_000 });

  await row.getByRole('button', { name: 'Delete', exact: true }).click();

  // deleteStream deactivates rather than removing the row — the fixture stays
  // reusable for the next run.
  await expect
    .poll(
      async () => {
        const streams = (await convex.query(anyApi.streams.list, {
          token,
          includeInactive: true,
        })) as { name: string; isActive: boolean }[];
        return streams.find((s) => s.name === SCAFFOLD_ADMIN_STREAM)?.isActive;
      },
      { message: 'the stream was not deactivated', timeout: 20_000 },
    )
    .toBe(false);

  // Still listed — the management screen is the one place a deactivated
  // stream must remain visible, or there is no way back to it at all.
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Stream is active').check();
  await page.getByRole('button', { name: 'Update', exact: true }).click();

  await expect
    .poll(
      async () => {
        const streams = (await convex.query(anyApi.streams.list, {
          token,
          includeInactive: true,
        })) as { name: string; isActive: boolean }[];
        return streams.find((s) => s.name === SCAFFOLD_ADMIN_STREAM)?.isActive;
      },
      { message: 'the stream could not be reactivated', timeout: 20_000 },
    )
    .toBe(true);
});

test('Tasks tab: search and status filters combine, and an empty result explains why', async ({
  page,
}) => {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Tasks', exact: true }).first().click();
  await expect(page.getByText('Task Management')).toBeVisible();

  await page
    .getByPlaceholder('Search tasks by title, description, or stream...')
    .fill(SCAFFOLD_TASK);
  await expect(page.getByText(SCAFFOLD_TASK).first()).toBeVisible({ timeout: 20_000 });

  // The scaffold task is always active. Filtering to Inactive while searching
  // for it by name is a filter combination guaranteed to match nothing — an
  // empty state forced by a FILTER, not by anything being deleted.
  await page.getByRole('button', { name: 'Inactive Tasks' }).click();
  await expect(page.getByText('No Tasks Found')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Try adjusting your filters')).toBeVisible();
});

test('Gamification tab: Levels and Badges are reachable, and Back restores it', async ({
  page,
}) => {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Gamification', exact: true }).first().click();
  await expect(page.getByText('Gamification Management')).toBeVisible();

  await page.getByRole('button', { name: 'Manage Levels' }).click();
  await expect(page.getByText('Level Management')).toBeVisible();
  await page.getByRole('button', { name: 'Back to Gamification' }).click();
  await expect(page.getByText('Gamification Management')).toBeVisible();

  await page.getByRole('button', { name: 'Manage Badges' }).click();
  await expect(page.getByText('Badges Management')).toBeVisible();
  await page.getByRole('button', { name: 'Back to Gamification' }).click();
  await expect(page.getByText('Gamification Management')).toBeVisible();
});

test('Settings tab: Email Logs and Backup Management are reachable, and Back restores it', async ({
  page,
}) => {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await expect(page.getByText('Admin Settings')).toBeVisible();

  await page.getByRole('button', { name: 'Email Configuration', exact: true }).click();
  await page.getByRole('button', { name: 'View Email Logs' }).click();
  await expect(page.getByText('Email Logs', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Settings' }).click();
  await expect(page.getByText('Admin Settings')).toBeVisible();

  await page.getByRole('button', { name: 'Database Backup', exact: true }).click();
  await page.getByRole('button', { name: 'View All Backups' }).click();
  await expect(page.getByText('Backups', { exact: true })).toBeVisible();
  // The static replacement for the decommissioned Supabase backup mechanism —
  // there is no button here that could do anything, only instructions. Exact,
  // because the surrounding prose paragraph ("Run `npm run convex:export`
  // from a machine with...") also contains this string as a substring — a
  // loose match resolves to both and trips strict mode.
  await expect(page.getByText('npm run convex:export', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Settings' }).click();
  await expect(page.getByText('Admin Settings')).toBeVisible();
});

test('Email Logs: search narrows the list, to an explained empty state', async ({ page }) => {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Email Configuration', exact: true }).click();
  await page.getByRole('button', { name: 'View Email Logs' }).click();
  await expect(page.getByText('Email Logs', { exact: true })).toBeVisible();

  await page
    .getByPlaceholder('Search by recipient, subject, or type...')
    .fill('zzz-nothing-matches-this-zzz');
  await expect(page.getByText('No email logs found')).toBeVisible({ timeout: 20_000 });
});

test('Levels: a level can be created through the form and removed again', async ({ page }) => {
  const convex = client();
  const token = await adminToken(convex);

  // A level number nothing real would ever reach, so it cannot collide with
  // the platform's actual progression ladder.
  const levelNumber = 91;
  const levelName = 'E2E Throwaway Level';

  /**
   * Leftovers go BEFORE the form is driven, mirroring the badge test below
   * (which checks for its fixture before creating). Unlike the badge, this
   * fixture is deleted at the end of every healthy run — but a run dying
   * between create and delete leaves the row behind, the next run's Add Level
   * then mints a second one, the name-scoped locator below resolves to two
   * nodes, and `toBeVisible` throws a strict-mode violation on every run
   * after that until someone deletes the orphan on dev by hand. Levels have a
   * real delete (unlike badges), so the API can clear them; doing it before
   * `goto` also keeps the management screen from rendering rows this test
   * removed from underneath it.
   */
  const leftovers = (await convex.query(anyApi.levels.list, {})) as {
    id: string;
    levelNumber: number;
    name: string;
  }[];
  for (const leftover of leftovers) {
    if (leftover.levelNumber === levelNumber || leftover.name === levelName) {
      await convex.mutation(anyApi.levels.remove, { token, id: leftover.id });
    }
  }

  page.on('dialog', (d) => d.accept());

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Gamification', exact: true }).first().click();
  await page.getByRole('button', { name: 'Manage Levels' }).click();
  await page.getByRole('button', { name: 'Add Level' }).click();

  const modal = page.locator('div.fixed.inset-0');
  await expect(modal.getByText('Create New Level')).toBeVisible();

  const numberInputs = modal.locator('input[type="number"]');
  await numberInputs.nth(0).fill(String(levelNumber));
  await numberInputs.nth(1).fill('999999');
  await modal.getByPlaceholder('e.g., Orbit Master').fill(levelName);
  await modal
    .getByPlaceholder('Describe what this level represents...')
    .fill('Created and deleted by the e2e suite in the same run.');
  await modal.getByRole('button', { name: 'Create Level' }).click();

  await expect
    .poll(
      async () => {
        const levels = (await convex.query(anyApi.levels.list, {})) as {
          levelNumber: number;
        }[];
        return levels.some((l) => l.levelNumber === levelNumber);
      },
      { message: 'the level form never created a level', timeout: 20_000 },
    )
    .toBe(true);

  const row = page
    .locator('div.bg-white.rounded-xl.shadow-sm.p-6')
    .filter({ hasText: levelName });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByTitle('Delete level').click();

  await expect
    .poll(
      async () => {
        const levels = (await convex.query(anyApi.levels.list, {})) as {
          levelNumber: number;
        }[];
        return levels.some((l) => l.levelNumber === levelNumber);
      },
      { message: 'the level survived its own delete button', timeout: 20_000 },
    )
    .toBe(false);
});

test('Badges: deactivate and reactivate round-trip through the UI', async ({ page }) => {
  /**
   * Unlike a level, a badge's own "Delete" button does not delete —
   * `badgesApi.deleteBadge` calls `badges.deactivate` (see src/lib/api/badges.ts),
   * a hard delete having been replaced specifically so a revoked badge does not
   * orphan every `userBadges` row pointing at it. So this fixture is created
   * ONCE, like SCAFFOLD_ADMIN_STREAM, and every run exercises deactivate then
   * reactivate — never an actual delete, because there is none.
   */
  const convex = client();
  const token = await adminToken(convex);
  const badgeName = 'E2E Admin Console Badge';

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Gamification', exact: true }).first().click();
  await page.getByRole('button', { name: 'Manage Badges' }).click();

  const existing = (
    (await convex.query(anyApi.badges.list, { token, includeInactive: true })) as {
      name: string;
    }[]
  ).some((b) => b.name === badgeName);

  if (!existing) {
    await page.getByRole('button', { name: 'Create Badge' }).click();
    const modal = page.locator('div.fixed.inset-0');
    await expect(modal.getByText('Create New Badge')).toBeVisible();

    await modal.getByPlaceholder('e.g., Ajebutter Starter').fill(badgeName);
    await modal
      .getByPlaceholder(/Complete your first 3 tasks/)
      .fill('Fixture badge for the admin console e2e suite. Safe to leave in place.');
    await modal.getByPlaceholder('e.g., 3').fill('3');
    await modal.getByPlaceholder('e.g., 25').fill('5');
    await modal.getByRole('button', { name: 'Create Badge', exact: true }).click();

    await expect
      .poll(
        async () => {
          const badges = (await convex.query(anyApi.badges.list, {
            token,
            includeInactive: true,
          })) as { name: string }[];
          return badges.some((b) => b.name === badgeName);
        },
        { message: 'the badge form never created a badge', timeout: 20_000 },
      )
      .toBe(true);
  }

  page.on('dialog', (d) => d.accept());

  const row = page.getByRole('row').filter({ hasText: badgeName });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByTitle('Delete').click();

  await expect
    .poll(
      async () => {
        const badges = (await convex.query(anyApi.badges.list, {
          token,
          includeInactive: true,
        })) as { name: string; isActive: boolean }[];
        return badges.find((b) => b.name === badgeName)?.isActive;
      },
      { message: 'the badge was not deactivated', timeout: 20_000 },
    )
    .toBe(false);

  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByTitle('Edit').click();
  const modal = page.locator('div.fixed.inset-0');
  await modal.getByLabel(/Badge is active/).check();
  await modal.getByRole('button', { name: 'Update Badge' }).click();

  await expect
    .poll(
      async () => {
        const badges = (await convex.query(anyApi.badges.list, {
          token,
          includeInactive: true,
        })) as { name: string; isActive: boolean }[];
        return badges.find((b) => b.name === badgeName)?.isActive;
      },
      { message: 'the badge could not be reactivated', timeout: 20_000 },
    )
    .toBe(true);
});
