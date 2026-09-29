import { test, expect, manifest, storageStateFor } from './support/fixtures';
import { ALL_ROLES, SCREENS, resolvePath, type RouteContext } from './support/routes';

/**
 * The route x role matrix.
 *
 * Before this existed, 40 pages had never been rendered by any test — nothing
 * in the repo would catch a page that throws on mount. That is the whole point
 * here: navigate, then assert no uncaught error and no error boundary. It is
 * shallow by design and it is the highest catch rate per line in the suite.
 *
 * The inventory itself lives in support/routes.ts, shared with the visual
 * capture sweep, precisely so this file cannot drift back into the 15-screen
 * blind spot the two inline arrays it replaced had grown.
 */

for (const role of ALL_ROLES) {
  test.describe(`${role}`, () => {
    test.use({ storageState: storageStateFor(role) });

    for (const screen of SCREENS) {
      if (screen.public) continue; // covered once, unauthenticated, below.

      const permitted = screen.allowedRoles.includes(role);

      if (permitted) {
        test(`${screen.id}: renders for ${role}`, async ({ page, pageErrors }) => {
          const ctx: RouteContext = { manifest: manifest() };
          await page.goto(resolvePath(screen, ctx), { waitUntil: 'networkidle' });

          // The error boundary renders this. Catching it explicitly gives a far
          // better failure message than a generic "element not found" later.
          await expect(page.getByText('Something went wrong')).toHaveCount(0);

          if (screen.prepare) await screen.prepare(page, ctx);

          // ProtectedRoute's denial panel — a permitted role must never see it,
          // admin sub-tab or not.
          await expect(page.getByText('Access Denied')).toHaveCount(0);
          // Chrome present means the app mounted rather than white-screening.
          await expect(page.locator('nav').first()).toBeVisible();

          if (screen.ready) await screen.ready(page);

          pageErrors.assertClean();
        });
      } else if (screen.denial && !screen.skipDenialCheck) {
        test(`${screen.id}: refuses ${role}`, async ({ page, pageErrors }) => {
          // Deliberately no `prepare()` here: a denied role is stopped by the
          // guard before whatever `prepare` would click even exists.
          const ctx: RouteContext = { manifest: manifest() };
          await page.goto(resolvePath(screen, ctx));
          await expect(page.getByText('Something went wrong')).toHaveCount(0);

          const denial = screen.denial!;
          if (denial.kind === 'protected-route') {
            // The guard must actually deny, not merely hide a nav link. A role
            // that can reach an admin screen by typing the URL is the failure
            // this assertion exists for.
            await expect(page.getByText('Access Denied', { exact: true })).toBeVisible();
          } else {
            await expect(page.getByText(denial.text)).toBeVisible();
          }

          pageErrors.assertClean();
        });
      }
    }
  });
}

test.describe('unauthenticated', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const screen of SCREENS.filter((s) => s.public)) {
    test(`renders public route ${screen.id}`, async ({ page, pageErrors }) => {
      await page.goto(resolvePath(screen, { manifest: manifest() }));
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
      pageErrors.assertClean();
    });
  }

  test('shows the sign-in page for a protected route', async ({ page, pageErrors }) => {
    await page.goto('/tasks');
    // ProtectedRoute renders LoginPage inline rather than redirecting, so the
    // URL stays put and the form appears.
    await expect(page.getByLabel(/email/i)).toBeVisible();
    pageErrors.assertClean();
  });

  test('switches between password and magic-link sign-in, client-side only', async ({
    page,
    pageErrors,
  }) => {
    // LoginPage's variants are client-side state with no URL of their own —
    // see the note beside PUBLIC_SCREENS in support/routes.ts for why they can
    // never be Screens. Only the toggle is driven here, and NOTHING submits:
    // the login backend allows 15 requests per account per 15 minutes, and
    // auth.spec.ts is the one file budgeted to spend them.
    await page.goto('/');
    await expect(page.getByLabel('Password')).toBeVisible();

    await page.getByRole('button', { name: /magic link instead/i }).click();
    // The magic-link variant drops the password field for a send-a-link action.
    await expect(page.getByRole('button', { name: /send magic link/i })).toBeVisible();
    await expect(page.getByLabel('Password')).toHaveCount(0);

    await page.getByRole('button', { name: /password instead/i }).click();
    await expect(page.getByLabel('Password')).toBeVisible();

    pageErrors.assertClean();
  });
});
