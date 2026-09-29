import { test, expect, storageStateFor } from './support/fixtures';

/**
 * F6 — finding one person in a long list.
 *
 * The admissions queue holds a couple of hundred applications on a live
 * deployment and had no search at all; the interns roster and the cohort and
 * department lists were the same. This covers the two that matter most, and the
 * distinction that makes admissions search worth having: it runs on the SERVER,
 * across the whole status, rather than filtering the page you happen to be
 * looking at.
 */

test.use({ storageState: storageStateFor('admin') });

test('the admissions queue searches every application, not just the page', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/admin');
  await page.getByRole('button', { name: 'SIWES' }).first().click();
  await page.locator('[data-siwes-tab="applications"]').click();

  const search = page.getByPlaceholder(/Search name, email or reference/);
  await expect(search).toBeVisible({ timeout: 20_000 });

  /**
   * Proves the list actually narrowed, rather than that a matching row happened
   * to be on screen already.
   *
   * The demo applicants are visible before anything is typed, so asserting one
   * is visible after typing proves nothing — the search is debounced, and that
   * assertion passes against the pre-search list. The real evidence is a row
   * that was there BEFORE and is gone AFTER.
   */
  const anchor = page.getByRole('row').filter({ hasText: '@iih.ng' }).first();
  await expect(anchor).toBeVisible({ timeout: 20_000 });
  const anchorText = ((await anchor.textContent()) ?? '').slice(0, 40);

  await search.fill('demo.');

  // The non-matching row disappears — that is the filtering, observed.
  await expect(page.getByRole('row').filter({ hasText: anchorText })).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(page.getByRole('row').filter({ hasText: 'demo.' }).first()).toBeVisible({
    timeout: 20_000,
  });

  // A term that matches nothing explains itself rather than looking like an
  // empty platform — and says the status filter is also in play, which is the
  // usual reason a name someone can see in the database does not appear.
  await search.fill('zzz-no-such-applicant-zzz');
  await expect(page.getByText(/Nothing matches/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/status filter/i)).toBeVisible();

  // Clearing restores the list.
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('row').filter({ hasText: 'demo.' }).first()).toBeVisible({
    timeout: 20_000,
  });
});

test('the interns roster filters as you type, and says how many matched', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/admin');
  await page.getByRole('button', { name: 'SIWES' }).first().click();
  await page.locator('[data-siwes-tab="interns"]').click();

  const search = page.getByPlaceholder(/Search name, email, matric or institution/);
  await expect(search).toBeVisible({ timeout: 20_000 });

  await search.fill('zzz-no-such-intern-zzz');
  // The count beside the box is the point: it distinguishes "nothing matched"
  // from "nothing is here", which look identical without it.
  await expect(page.getByText(/^0 of \d+$/)).toBeVisible({ timeout: 20_000 });
});

test('settings sections are a readable list, not a horizontal scroller', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();

  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(nav).toBeVisible({ timeout: 20_000 });

  // All eight, reachable without scrolling a strip. These names are why the row
  // overflowed in the first place.
  for (const label of [
    'General Settings',
    'Email Configuration',
    'OAuth Settings',
    'Task Submissions',
    'Database Backup',
    'Audit Log',
    'Security',
    'Seed / Demo Data',
  ]) {
    await expect(nav.getByRole('button', { name: label })).toBeVisible();
  }

  // And the rail actually switches the panel beside it.
  await nav.getByRole('button', { name: 'Security' }).click();
  await expect(nav.getByRole('button', { name: 'Security' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('applications live in their own admin section; SIWES shows only SIWES', async ({ page }) => {
  test.setTimeout(120_000);

  /**
   * Every programme's applications used to land under a tab labelled SIWES,
   * which on the live platform is two thirds wrong — internship, volunteer and
   * NYSC applicants were filed under a heading that did not describe them.
   */
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Applications', exact: true }).first().click();

  await expect(page.getByText('All Applications')).toBeVisible({ timeout: 20_000 });
  // The general queue carries every type, so the badges are mixed.
  await expect(page.getByText('Volunteer', { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });

  // The SIWES section is scoped, and says so.
  await page.getByRole('button', { name: 'SIWES' }).first().click();
  await page.locator('[data-siwes-tab="applications"]').click();
  await expect(page.getByText('SIWES Applications')).toBeVisible({ timeout: 20_000 });

  // Anchored on a SIWES row FIRST. A `toHaveCount(0)` resolves immediately, so
  // asserting the absence of volunteers while the table is still loading would
  // pass against anything — including a broken scope.
  await expect(page.getByText('SIWES', { exact: true }).first()).toBeVisible({ timeout: 20_000 });

  // Scoped on the SERVER, so nothing non-SIWES can appear here at all.
  await expect(page.getByText('Volunteer', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Internship', { exact: true })).toHaveCount(0);
});

test('the status control separates the decision queue from the record', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Applications', exact: true }).first().click();

  // Pending and approved are different jobs, so they are tabs with counts
  // rather than options buried in a filter dropdown.
  const submitted = page.getByRole('button', { name: /^Submitted/ });
  await expect(submitted).toBeVisible({ timeout: 20_000 });
  await expect(submitted).toHaveAttribute('aria-current', 'true');

  await page.getByRole('button', { name: /^Approved/ }).click();
  await expect(page.getByRole('button', { name: /^Approved/ })).toHaveAttribute(
    'aria-current',
    'true',
  );
});
