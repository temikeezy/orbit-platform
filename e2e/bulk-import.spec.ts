import { anyApi } from 'convex/server';
import { test, expect, storageStateFor } from './support/fixtures';
import { adminToken, client, destroyUser } from './support/orbit';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * F7 — bulk import.
 *
 * The highest blast-radius operation an admin can perform: one file, up to 500
 * accounts, created in a single press. It had no test at any layer.
 *
 * Two of its properties are worth more than the happy path. A row that fails
 * validation must not stop the rows around it from importing — a batch that is
 * all-or-nothing on a typo in row 400 is unusable. And re-importing a file must
 * not create a second copy of everyone in it, because the natural response to a
 * partial-looking result is to run the same file again.
 */

test.describe.configure({ mode: 'serial' });
// SUPER ADMIN, not admin. `users.adminCreateUser` is super-admin-only by
// design — an admin who could create users could manufacture peer admins — so
// the import screens are now shown only to super admins, and this is the role
// that can actually complete the flow.
test.use({ storageState: storageStateFor('super_admin') });

const stamp = Date.now().toString(36);
const goodRows = [
  { name: `E2E Import One ${stamp}`, email: `e2e-import-1-${stamp}@iih.ng` },
  { name: `E2E Import Two ${stamp}`, email: `e2e-import-2-${stamp}@iih.ng` },
];

function csvFixture(rows: { name: string; email: string }[], extra = ''): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-import-'));
  const file = path.join(dir, 'import.csv');
  const body = rows.map((r) => `${r.name},${r.email}`).join('\n');
  writeFileSync(file, `Full Name,Email\n${body}${extra}\n`);
  return file;
}

async function cleanUp(emails: string[]) {
  const convex = client();
  const token = await adminToken(convex);
  const raw = await convex.query(anyApi.users.list, { token, includeInactive: true });
  const all = (Array.isArray(raw) ? raw : (raw.users ?? [])) as { id: string; email: string }[];

  for (const user of all.filter((u) => emails.includes(u.email))) {
    await destroyUser(convex, token, user.id);
  }
}

test.afterAll(async () => {
  await cleanUp([...goodRows.map((r) => r.email), `e2e-import-3-${stamp}@iih.ng`]);
});

test('imports a file through map and preview, and the accounts exist', async ({ page }) => {
  await page.goto('/admin');

  // Reached through the Overview quick action, not a URL — bulk import has no
  // route of its own, and this card is exactly where the wiring was broken: it
  // passed 'import' while the dashboard's switch expected 'bulk-import', so it
  // fell through to default and silently re-rendered Overview.
  await page.getByRole('button', { name: /Bulk Import/ }).first().click();
  await page.getByRole('button', { name: 'Bulk Import (CSV/Excel)' }).click();
  await page.getByRole('button', { name: 'Start Bulk Import' }).click();

  // A row with no email at all: it must be reported and skipped, not abort the
  // other two.
  await page
    .locator('input[type="file"]')
    .setInputFiles(csvFixture(goodRows, `\nE2E Import Three ${stamp},`));

  // The mapping step auto-detects the columns; Continue is disabled until name
  // and email are both mapped, so its being enabled is the assertion that
  // detection worked.
  const mapNext = page.getByRole('button', { name: 'Continue →' });
  await expect(mapNext).toBeEnabled({ timeout: 20_000 });
  await mapNext.click();

  // The preview counts only the rows it will actually import.
  await page.getByRole('button', { name: /Import 2 Users/ }).click();

  await expect(page.getByText('Imported')).toBeVisible({ timeout: 30_000 });

  const convex = client();
  const token = await adminToken(convex);

  await expect
    .poll(
      async () => {
        const raw = await convex.query(anyApi.users.list, { token, includeInactive: true });
        const all = (Array.isArray(raw) ? raw : (raw.users ?? [])) as { email: string }[];
        return goodRows.filter((r) => all.some((u) => u.email === r.email)).length;
      },
      { message: 'the imported accounts never appeared', timeout: 30_000 },
    )
    .toBe(2);

  // The invalid row created nothing. A bulk import that half-creates an account
  // for a row it reported as failed is worse than one that refuses outright.
  const raw = await convex.query(anyApi.users.list, { token, includeInactive: true });
  const all = (Array.isArray(raw) ? raw : (raw.users ?? [])) as { email: string }[];
  expect(all.some((u) => u.email === `e2e-import-3-${stamp}@iih.ng`)).toBe(false);
});

test('re-importing the same file does not duplicate anyone', async ({ page }) => {
  const convex = client();
  const token = await adminToken(convex);

  const countMatching = async () => {
    const raw = await convex.query(anyApi.users.list, { token, includeInactive: true });
    const all = (Array.isArray(raw) ? raw : (raw.users ?? [])) as { email: string }[];
    return all.filter((u) => goodRows.some((r) => r.email === u.email)).length;
  };

  expect(await countMatching()).toBe(2);

  await page.goto('/admin');
  await page.getByRole('button', { name: /Bulk Import/ }).first().click();
  await page.getByRole('button', { name: 'Bulk Import (CSV/Excel)' }).click();
  await page.getByRole('button', { name: 'Start Bulk Import' }).click();
  await page.locator('input[type="file"]').setInputFiles(csvFixture(goodRows));

  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Import \d+ Users?/ }).click();
  await expect(page.getByText(/Imported|Skipped|Failed/).first()).toBeVisible({ timeout: 30_000 });

  // Emails are the identity. Running the same file twice — the natural reaction
  // to a result that looks partial — must not produce two of everyone.
  expect(await countMatching()).toBe(2);
});

test.describe('a plain admin', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('is told up front that importing needs a super admin', async ({ page }) => {
    await page.goto('/admin');

    // The quick action is gone, rather than leading somewhere that refuses.
    await expect(page.getByRole('button', { name: /Bulk Import/ })).toHaveCount(0);
  });
});
