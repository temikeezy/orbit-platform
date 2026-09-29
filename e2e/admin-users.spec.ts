import { anyApi } from 'convex/server';
import { test, expect, storageStateFor } from './support/fixtures';
import { adminToken, client, createUser, destroyUser } from './support/orbit';

/**
 * Accounts this file creates THROUGH THE UI, torn down whether or not the test
 * that made them passed.
 *
 * The per-test `destroyUser` calls only run when a test reaches its final line.
 * The create/edit spec has been failing mid-way on CI for some time, so every
 * one of those runs left its account behind — the deployment now carries
 * hundreds of `E2E Created *` rows, and this page loads every user on the
 * deployment, so each leak makes the next run slower and the failure more
 * likely. The leak is what turns one flaky run into a trend.
 *
 * Registered by email, because a test can fail before it ever learns the id.
 */
const createdThroughUi: string[] = [];

test.afterEach(async () => {
  if (createdThroughUi.length === 0) return;

  const convex = client();
  const token = await adminToken(convex);
  const everyone = (await convex.query(anyApi.users.list, { token })) as {
    id: string;
    email: string;
  }[];

  for (const email of createdThroughUi.splice(0)) {
    const match = everyone.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) await destroyUser(convex, token, match.id);
  }
});

/**
 * The admin Users page.
 *
 * Two defects lived here at once, and neither was visible from inside the app:
 *
 * Deactivation was ONE-WAY. The control rendered only when `is_active` was
 * true, so deactivating someone made the button vanish and no screen could undo
 * it — while the server had always accepted `adminSetActive(isActive)` either
 * way.
 *
 * MCP access was INVISIBLE. `directoryShape` never returned `mcpEnabled`, so
 * every row read `undefined`: the badge never rendered, the toggle always
 * showed its off state, and an admin had no way to see which accounts held a
 * standing API credential.
 */

test.describe.configure({ mode: 'serial' });
test.use({ storageState: storageStateFor('super_admin') });

const rowFor = (page: import('@playwright/test').Page, name: string) =>
  page.getByRole('row').filter({ hasText: name });

test('an account can be deactivated and then activated again', async ({ page }) => {
  const convex = client();
  const token = await adminToken(convex);
  const subject = await createUser(convex, token, 'intern', 'act' + Date.now().toString(36).slice(-5));

  page.on('dialog', (d) => d.accept());

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Users', exact: true }).first().click();
  await page.getByPlaceholder(/search/i).first().fill(subject.fullName);

  const row = rowFor(page, subject.fullName);
  await expect(row).toHaveCount(1, { timeout: 20_000 });

  await row.getByRole('button', { name: `Deactivate ${subject.fullName}` }).click();
  await expect
    .poll(async () => {
      const u = await convex.query(anyApi.users.adminGetById, { token, userId: subject.id });
      return u.isActive;
    }, { timeout: 20_000 })
    .toBe(false);

  // The control that was missing. Without it, the row above is a dead end.
  await expect(row.getByRole('button', { name: `Activate ${subject.fullName}` })).toBeVisible({
    timeout: 20_000,
  });
  await row.getByRole('button', { name: `Activate ${subject.fullName}` }).click();

  await expect
    .poll(async () => {
      const u = await convex.query(anyApi.users.adminGetById, { token, userId: subject.id });
      return u.isActive;
    }, { message: 'the account could not be reactivated', timeout: 20_000 })
    .toBe(true);

  await destroyUser(convex, token, subject.id);
});

test('MCP access is visible on the row, and the toggle reflects the truth', async ({ page }) => {
  const convex = client();
  const token = await adminToken(convex);
  const subject = await createUser(convex, token, 'admin', 'mcp' + Date.now().toString(36).slice(-5));

  // Granted server-side, so the page is being asked to REPORT state it did not
  // set — which is exactly what it previously could not do.
  await convex.mutation(anyApi.users.adminSetMcpAccess, {
    token,
    userId: subject.id,
    enabled: true,
  });

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Users', exact: true }).first().click();
  await page.getByPlaceholder(/search/i).first().fill(subject.fullName);

  const row = rowFor(page, subject.fullName);
  await expect(row).toHaveCount(1, { timeout: 20_000 });

  // The badge, and a toggle that offers to REVOKE rather than to grant.
  // Exact: the button's own accessible label also contains "MCP access".
  await expect(row.getByText('MCP', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(row.getByRole('button', { name: `Disable MCP access for ${subject.fullName}` })).toBeVisible();
  // State is exposed to assistive tech too, not only as colour.
  await expect(
    row.getByRole('button', { name: `Disable MCP access for ${subject.fullName}` }),
  ).toHaveAttribute('aria-pressed', 'true');

  await destroyUser(convex, token, subject.id);
});

test('the full trash lifecycle works from the page: trash, restore, delete forever', async ({
  page,
}) => {
  const convex = client();
  const token = await adminToken(convex);
  const subject = await createUser(convex, token, 'intern', 'trash' + Date.now().toString(36).slice(-5));

  page.on('dialog', (d) => d.accept());

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Users', exact: true }).first().click();
  await page.getByPlaceholder(/search/i).first().fill(subject.fullName);

  await rowFor(page, subject.fullName)
    .getByRole('button', { name: `Move ${subject.fullName} to trash` })
    .click();

  // Gone from the directory — trashing is not a soft flag the list still shows.
  await expect(rowFor(page, subject.fullName)).toHaveCount(0, { timeout: 20_000 });

  // --- restore -------------------------------------------------------------
  await page.getByRole('button', { name: /view trash/i }).click();
  const trashed = rowFor(page, subject.fullName);
  await expect(trashed).toHaveCount(1, { timeout: 20_000 });

  await trashed.getByRole('button', { name: 'Restore' }).click();
  await expect
    .poll(async () => {
      const u = await convex.query(anyApi.users.adminGetById, { token, userId: subject.id });
      return u?.isDeleted;
    }, { message: 'restore did not bring the account back', timeout: 20_000 })
    .toBe(false);

  // --- and permanently ------------------------------------------------------
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Users', exact: true }).first().click();
  await page.getByPlaceholder(/search/i).first().fill(subject.fullName);
  await rowFor(page, subject.fullName)
    .getByRole('button', { name: `Move ${subject.fullName} to trash` })
    .click();
  await expect(rowFor(page, subject.fullName)).toHaveCount(0, { timeout: 20_000 });

  await page.getByRole('button', { name: /view trash/i }).click();
  await expect(rowFor(page, subject.fullName)).toHaveCount(1, { timeout: 20_000 });
  await rowFor(page, subject.fullName).getByRole('button', { name: 'Delete Forever' }).click();

  await expect
    .poll(async () => {
      const trash = (await convex.query(anyApi.users.adminListTrash, { token })) as {
        id: string;
      }[];
      return trash.some((u) => u.id === subject.id);
    }, {
      // adminPermanentlyDeleteUser walks every AUTHORSHIP_REFERENCES table
      // before it deletes — the most expensive write in this file — and 20s
      // was occasionally too tight for that under a full, `fullyParallel` run
      // sharing the same dev deployment with everything else.
      message: 'the account survived a permanent delete',
      timeout: 30_000,
    })
    .toBe(false);
});

test('the password-reset action actually queues a mail', async ({ page }) => {
  const convex = client();
  const token = await adminToken(convex);
  const subject = await createUser(convex, token, 'intern', 'pwd' + Date.now().toString(36).slice(-5));

  page.on('dialog', (d) => d.accept());

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Users', exact: true }).first().click();
  await page.getByPlaceholder(/search/i).first().fill(subject.fullName);

  await rowFor(page, subject.fullName)
    .getByRole('button', { name: `Send password reset to ${subject.fullName}` })
    .click();

  // A toast is not evidence. The mail has to exist.
  await expect
    .poll(
      async () => {
        const { logs } = (await convex.query(anyApi.emailQueue.adminList, {
          token,
          limit: 200,
        })) as { logs: { recipientEmail: string }[] };
        return logs.some((l) => l.recipientEmail === subject.email);
      },
      { message: 'the reset button queued nothing', timeout: 30_000 },
    )
    .toBe(true);

  await destroyUser(convex, token, subject.id);
});

test('export produces a CSV of the rows on screen', async ({ page }) => {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Users', exact: true }).first().click();

  const download = page.waitForEvent('download', { timeout: 20_000 });
  await page.getByRole('button', { name: /export/i }).first().click();
  const file = await download;

  expect(file.suggestedFilename()).toMatch(/\.csv$/);

  const stream = await file.createReadStream();
  const body = await new Promise<string>((resolve, reject) => {
    let out = '';
    stream.on('data', (c) => (out += c));
    stream.on('end', () => resolve(out));
    stream.on('error', reject);
  });

  // A header and at least the real accounts. An empty file would still be a
  // "successful" download.
  expect(body.split('\n')[0]).toContain('email');
  expect(body.split('\n').length).toBeGreaterThan(1);
});

test('bulk selection drives the bulk actions', async ({ page }) => {
  // Creates two accounts and drives a bulk deactivation through the UI — the
  // same cross-region round-trip cost as the create/edit spec below.
  test.setTimeout(120_000);

  const convex = client();
  const token = await adminToken(convex);
  const a = await createUser(convex, token, 'intern', 'bulka' + Date.now().toString(36).slice(-4));
  const b = await createUser(convex, token, 'intern', 'bulkb' + Date.now().toString(36).slice(-4));

  page.on('dialog', (d) => d.accept());

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Users', exact: true }).first().click();

  for (const u of [a, b]) {
    await page.getByPlaceholder(/search/i).first().fill(u.fullName);
    await expect(rowFor(page, u.fullName)).toHaveCount(1, { timeout: 20_000 });
    await rowFor(page, u.fullName).getByRole('button', { name: 'Select user' }).click();
  }

  await page.getByPlaceholder(/search/i).first().fill('');
  await page.getByRole('button', { name: /deactivate/i }).first().click();

  for (const u of [a, b]) {
    await expect
      .poll(async () => {
        const row = await convex.query(anyApi.users.adminGetById, { token, userId: u.id });
        return row?.isActive;
      }, { message: `${u.email} was not deactivated in bulk`, timeout: 25_000 })
      .toBe(false);
  }

  await destroyUser(convex, token, a.id);
  await destroyUser(convex, token, b.id);
});

test('Add User creates an account, and Edit updates one', async ({ page }) => {
  /**
   * The default 45s budget is not enough for this one on CI — necessary, but
   * NOT on its own sufficient. See the note on the password assertion below.
   *
   * It drives two full round trips through the admin UI — create (itself
   * adminCreateUser followed by adminGetById) and then a complete edit — over a
   * page that renders every user on the deployment, with two workers competing
   * on a runner that reaches eu-west-1 cross-region. ~14s locally.
   */
  test.setTimeout(120_000);

  const convex = client();
  const token = await adminToken(convex);
  const stamp = Date.now().toString(36).slice(-5);
  const email = `e2e-created-${stamp}@iih.ng`;
  const name = `E2E Created ${stamp}`;
  // Registered BEFORE the UI is driven, so a failure part-way through still
  // tears the account down — see createdThroughUi.
  createdThroughUi.push(email);

  page.on('dialog', (d) => d.accept());

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Users', exact: true }).first().click();

  // --- create --------------------------------------------------------------
  await page.getByRole('button', { name: /add user/i }).click();
  await page.getByLabel('Full Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  /**
   * The modal now stops on a show-once password panel rather than closing.
   *
   * Deliberate, and the assertion is the point of it. The generated password is
   * no longer stored on the user record — a cleartext credential at rest — so
   * this response is the only place it ever exists. An earlier attempt at this
   * called the parent's refresh before rendering the panel, which set `loading`
   * and made the page swap its whole subtree for a spinner, unmounting the
   * modal before it could show anything: the password was lost exactly as it
   * had been. Asserting on the panel here is what stops that returning.
   */
  /**
   * A minute, because the round trip behind this genuinely takes that long on
   * CI — and only on CI.
   *
   * The captured snapshot at failure showed the modal open with Create
   * `[disabled]`, i.e. `loading` still true: the submit had fired and
   * `usersApi.createUser` (an adminCreateUser mutation followed by an
   * adminGetById read) had not come back after 20s. The account was created
   * server-side every time, so this was never a broken password panel — the
   * client was still waiting for its confirmation.
   *
   * Two contributors were fixed first rather than papered over, which is why
   * this is a timeout and not a shrug: the spec leaked an account on every
   * failed run (cleanup only ran on success — now an afterEach), and the
   * accumulated leak made this all-users page heavier every run. Clearing 395
   * abandoned fixture accounts took the deployment from 561 users to 162 and
   * the whole suite from 10.0m to 6.9m. What is left is latency on a two-core
   * runner reaching eu-west-1 cross-region, which no amount of test hygiene
   * removes.
   *
   * If this starts failing at 60s, the round trip has regressed — treat it as a
   * real signal rather than raising it again.
   */
  await expect(page.getByText(/only time this password will be shown/i)).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: /i have copied it/i }).click();

  const created = await expect
    .poll(
      async () => {
        const raw = await convex.query(anyApi.users.list, { token, includeInactive: true });
        const all = (Array.isArray(raw) ? raw : []) as { id: string; email: string }[];
        return all.find((u) => u.email === email)?.id ?? null;
      },
      { message: 'Add User created nothing', timeout: 30_000 },
    )
    .not.toBeNull()
    .then(async () => {
      const raw = await convex.query(anyApi.users.list, { token, includeInactive: true });
      const all = (Array.isArray(raw) ? raw : []) as { id: string; email: string }[];
      return all.find((u) => u.email === email)!.id;
    });

  // --- edit ----------------------------------------------------------------
  await page.getByPlaceholder(/search/i).first().fill(name);
  await expect(rowFor(page, name)).toHaveCount(1, { timeout: 20_000 });
  await rowFor(page, name).getByRole('button', { name: `Edit ${name}` }).click();

  const renamed = `${name} Renamed`;
  await page.getByLabel('Full Name').fill(renamed);
  await page.getByRole('button', { name: 'Update', exact: true }).click();

  await expect
    .poll(
      async () => {
        const u = await convex.query(anyApi.users.adminGetById, { token, userId: created });
        return u?.fullName;
      },
      { message: 'Edit saved nothing', timeout: 30_000 },
    )
    .toBe(renamed);

  await destroyUser(convex, token, created);
});
