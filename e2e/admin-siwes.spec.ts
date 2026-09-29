import { anyApi } from 'convex/server';
import { test, expect, manifest, storageStateFor } from './support/fixtures';
import { adminToken, client, createUser, destroyUser } from './support/orbit';
import { SCAFFOLD_COHORT, SCAFFOLD_DEPARTMENT } from './support/scaffold';

/**
 * SIWES administration: Cohorts, Departments, Interns — and the real stakes
 * behind `canReviewProfile` (convex/siwes.ts), which the Applications sub-tab
 * (already covered by application-intake.spec.ts) does not touch at all.
 *
 * Cohorts and departments have no delete, so both edits here round-trip a
 * non-identity field on the SHARED scaffold row rather than creating anything
 * — the same discipline scaffold.ts itself uses, just applied inline because
 * these are single-field toggles, not new rows.
 *
 * The interns test is the one with real privilege-escalation stakes: a
 * moderator's "My interns" queue is scoped to interns actually ASSIGNED to
 * them (`intern.iihSupervisorId === user._id`), not to the global `moderator`
 * role — a moderator who could browse every intern by typing a URL would be
 * exactly the escalation `canReviewProfile` exists to prevent.
 */

test.describe.configure({ mode: 'serial' });
test.use({ storageState: storageStateFor('admin') });

test("Cohorts: editing the scaffold cohort's cadence round-trips", async ({ page }) => {
  const convex = client();
  const token = await adminToken(convex);

  const before = (
    (await convex.query(anyApi.siwes.listCohorts, { token })) as {
      id: string;
      name: string;
      weeklySummaryRequired: boolean;
    }[]
  ).find((c) => c.name === SCAFFOLD_COHORT)!;

  await page.goto('/admin');
  await page.getByRole('button', { name: 'SIWES', exact: true }).first().click();
  await expect(page.getByText('SIWES Management')).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: SCAFFOLD_COHORT });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Edit' }).click();

  const toggle = page.getByLabel('Weekly summary required');
  // Flip and save, then flip back and save — a round trip, not a one-way
  // change, so the fixture's shape survives the test regardless of what it
  // was before.
  await toggle.setChecked(!before.weeklySummaryRequired);
  await page.getByRole('button', { name: 'Save Changes' }).click();

  await expect
    .poll(
      async () => {
        const cohorts = (await convex.query(anyApi.siwes.listCohorts, { token })) as {
          name: string;
          weeklySummaryRequired: boolean;
        }[];
        return cohorts.find((c) => c.name === SCAFFOLD_COHORT)?.weeklySummaryRequired;
      },
      { message: 'the cohort edit never saved', timeout: 20_000 },
    )
    .toBe(!before.weeklySummaryRequired);

  await row.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Weekly summary required').setChecked(before.weeklySummaryRequired);
  await page.getByRole('button', { name: 'Save Changes' }).click();

  await expect
    .poll(async () => {
      const cohorts = (await convex.query(anyApi.siwes.listCohorts, { token })) as {
        name: string;
        weeklySummaryRequired: boolean;
      }[];
      return cohorts.find((c) => c.name === SCAFFOLD_COHORT)?.weeklySummaryRequired;
    }, { timeout: 20_000 })
    .toBe(before.weeklySummaryRequired);
});

test("Departments: editing the scaffold department's active flag round-trips", async ({
  page,
}) => {
  const { scaffold } = manifest();
  const convex = client();
  const token = await adminToken(convex);

  /**
   * By ID, not by name.
   *
   * `listDepartments` filters inactive rows out by default (see
   * convex/siwes.ts), and this test deliberately drives the fixture INTO that
   * state and back. Departments have no delete, and the dev deployment
   * already carries several orphaned "E2E Scaffold Department" rows from
   * earlier runs that ended mid-test with the real one left inactive (see
   * scaffold.ts's ensureScaffold, which used to have the same missing-
   * includeInactive bug and could no longer find the real row to reuse it —
   * that is fixed now, but the orphans it already created cannot be deleted).
   * A NAME match against that list is not guaranteed to land on the same row
   * `scaffold.departmentId` names; an ID match always does.
   */
  const departmentsById = (departments: { id: string; isActive: boolean }[]) =>
    departments.find((d) => d.id === scaffold.departmentId);

  const before = departmentsById(
    (await convex.query(anyApi.siwes.listDepartments, {
      token,
      includeInactive: true,
    })) as { id: string; isActive: boolean }[],
  )!;

  await page.goto('/admin');
  await page.getByRole('button', { name: 'SIWES', exact: true }).first().click();
  await page.getByRole('button', { name: 'Departments', exact: true }).click();

  // Scoped to the fixture's own description text as well as its name: the
  // orphaned duplicates above share the exact same name and description, but
  // are inactive and therefore filtered out of this admin table's own fetch
  // (which does not pass includeInactive — see departmentsApi.getDepartments'
  // doc comment, which claims admins see inactive rows too; the RPC glue
  // behind it never actually requests them, so they do not). Only one row can
  // ever be visible here at a time, so `.first()` always means the real one.
  const row = page.getByRole('row').filter({ hasText: SCAFFOLD_DEPARTMENT }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Edit' }).click();

  await page.getByLabel('Department is active').setChecked(!before.isActive);
  await page.getByRole('button', { name: 'Save Changes' }).click();

  await expect
    .poll(
      async () => {
        const departments = (await convex.query(anyApi.siwes.listDepartments, {
          token,
          includeInactive: true,
        })) as { id: string; isActive: boolean }[];
        return departmentsById(departments)?.isActive;
      },
      { message: 'the department edit never saved', timeout: 20_000 },
    )
    .toBe(!before.isActive);

  /**
   * Restoring active -> active is a mutation, not a UI round trip.
   *
   * If the flip above just made the fixture INACTIVE, this admin table's own
   * fetch (see the comment above `row`) can no longer show a row for it at
   * all — there is no "show inactive" control anywhere on this screen, so
   * there is no way to reach Edit through the UI to reactivate it. That is a
   * real product gap: an admin who deactivates a department from this screen
   * has no way back in from this screen. Restoring through the API is what
   * keeps this test from leaving the shared fixture permanently invisible for
   * every run after it, without pretending the UI gap does not exist.
   */
  await convex.mutation(anyApi.siwes.saveDepartment, {
    token,
    departmentId: scaffold.departmentId,
    name: SCAFFOLD_DEPARTMENT,
    isActive: before.isActive,
  });

  await expect
    .poll(async () => {
      const departments = (await convex.query(anyApi.siwes.listDepartments, {
        token,
        includeInactive: true,
      })) as { id: string; isActive: boolean }[];
      return departmentsById(departments)?.isActive;
    }, { timeout: 20_000 })
    .toBe(before.isActive);
});

test('Interns: an admin assigns a new intern, and only their real supervisor can review them', async ({
  page,
  browser,
}) => {
  const convex = client();
  const token = await adminToken(convex);
  const runId = 'siwes' + Date.now().toString(36).slice(-6);
  const { users: scaffoldUsers } = manifest();
  const scaffoldIntern = scaffoldUsers.find((u) => u.role === 'intern')!;

  // Deliberately never assigned to anyone — the point of this fixture is to be
  // an intern NO supervisor can review yet.
  const stranger = await createUser(convex, token, 'intern', runId);

  await page.goto('/admin');
  await page.getByRole('button', { name: 'SIWES', exact: true }).first().click();
  await page.getByRole('button', { name: 'Interns', exact: true }).click();
  await page.getByRole('button', { name: 'Assign Intern' }).click();

  const modal = page.locator('div.fixed.inset-0');
  /**
   * Cohort is addressed by id; the rest are still positional.
   *
   * Position used to be the only handle, and it broke the moment a Programme
   * select was added above Cohort — every index shifted by one and the failure
   * read as a timeout on an unrelated control. The selects that matter now
   * carry ids for that reason.
   */
  const selects = modal.locator('select');
  await selects.nth(0).selectOption({ label: `${stranger.fullName} (${stranger.email})` });
  await modal.locator('#assign-cohort').selectOption({ label: SCAFFOLD_COHORT });
  // IIH Supervisor stays "None" — assigning one here is the thing under test.
  await modal.locator('#assign-department').selectOption({ label: SCAFFOLD_DEPARTMENT });
  await modal.getByRole('button', { name: 'Assign Intern' }).click();

  await expect
    .poll(
      async () => {
        const profiles = (await convex.query(anyApi.siwes.listProfiles, { token })) as {
          intern: { id: string } | null;
          cohortId?: string;
        }[];
        return profiles.some((p) => p.intern?.id === stranger.id);
      },
      { message: 'the assignment never reached the intern roster', timeout: 20_000 },
    )
    .toBe(true);

  // --- the moderator who is NOT their supervisor ----------------------------
  const modContext = await browser.newContext({ storageState: storageStateFor('moderator') });
  const modPage = await modContext.newPage();

  await modPage.goto('/review');
  await modPage.getByRole('button', { name: 'My interns' }).click();

  // The scaffold intern IS assigned to this moderator (see global-setup.ts) —
  // proving the tab actually lists someone is what makes the stranger's
  // absence mean "scoped", not "broken".
  await expect(modPage.getByText(scaffoldIntern.fullName)).toBeVisible({ timeout: 20_000 });
  await expect(modPage.getByText(stranger.fullName)).toHaveCount(0);

  // --- an admin, who reviews everyone ---------------------------------------
  const adminProfiles = (await convex.query(anyApi.siwes.listProfiles, { token })) as {
    intern: { id: string; fullName: string } | null;
  }[];
  expect(adminProfiles.some((p) => p.intern?.id === stranger.id)).toBe(true);

  await modContext.close();
  await destroyUser(convex, token, stranger.id);
});
