import { test, expect, watchForErrors } from './support/fixtures';
import { adminToken, client, createUser, destroyUser, signIn } from './support/orbit';
import { toOrbitUser } from '../src/lib/convexAdapters';

/**
 * The cache holds the SNAKE_CASE user, not the login response.
 *
 * `/auth/login` answers in Convex camelCase; the app persists what
 * `src/lib/auth.ts` writes. Storing the raw response gives a user with no
 * `full_name`, and Navigation renders `user?.full_name.charAt(0)` on every
 * page — so every route dies on a crash screen. Same adapter global-setup uses.
 */
function storageFor(session: { token: string; user: Parameters<typeof toOrbitUser>[0] }) {
  return {
    cookies: [],
    origins: [
      {
        origin: 'http://localhost:5173',
        localStorage: [
          { name: 'orbit_auth_token_v2', value: session.token },
          { name: 'orbit_user_v2', value: JSON.stringify(toOrbitUser(session.user)) },
        ],
      },
    ],
  };
}

/**
 * F5 — ORBIT is not a SIWES-only platform.
 *
 * Two thirds of what arrives through intake is an internship, a volunteer or an
 * NYSC application, and until this was fixed all of them were treated as SIWES
 * after conversion: the programme type was recorded on the application and
 * dropped on the way to the account, so nothing downstream could tell them
 * apart. Volunteers were shown a SIWES logbook, counted against it on the
 * supervisor's dashboard, and emailed about it every expected weekday on a
 * notification path that consults no preference key.
 *
 * The rule is in `convex/lib/programme.ts` and unit-tested there. This file
 * exists for the half a unit test cannot reach: what a real member actually
 * sees when they sign in.
 */

test.describe.configure({ mode: 'serial' });

const runStamp = Date.now().toString(36);

test('a volunteer keeps attendance and is not shown a SIWES logbook', async ({ browser }) => {
  const convex = client();
  const token = await adminToken(convex);

  // A volunteer, made the way an admin would make one.
  const volunteer = await createUser(convex, token, 'intern', `vol-${runStamp}`, 'volunteer');

  const session = await signIn(volunteer.email, volunteer.password);
  const context = await browser.newContext({ storageState: storageFor(session) });
  const page = await context.newPage();

  // Attached by hand: the `pageErrors` fixture binds to the DEFAULT `page`,
  // and both tests here build their own context for their own actor, so that
  // fixture never sees these pages at all. Without this watcher a mount-time
  // console error in the volunteer's attendance-only logbook — the very screen
  // this file exists to check — would pass silently.
  const pageErrors = watchForErrors(page);

  await page.goto('/logbook');

  // They land on Attendance, not on a daily-log form. Whether the card or the
  // "hybrid and physical only" note renders depends on the cohort's default
  // participation mode, which is not what this test is about — either way the
  // attendance SECTION is what a volunteer is put in front of.
  await expect(
    page.getByRole('button', { name: 'Attendance' }).or(page.getByText(/attendance tracking applies/i)),
  ).toBeVisible({ timeout: 20_000 });

  // The SIWES logbook does not. Both the tabs AND what they render — hiding the
  // buttons alone left the daily-log form on screen underneath them, because
  // 'today' is the default tab.
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Weekly', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toHaveCount(0);
  await expect(page.getByPlaceholder("Brief title for today's work")).toHaveCount(0);
  await expect(page.getByPlaceholder('Describe what you worked on today...')).toHaveCount(0);

  pageErrors.assertClean();
  await context.close();
  // Created by this spec, so removed by it — the shared fixtures are torn down
  // by global teardown, but these two are not.
  await destroyUser(convex, token, volunteer.id);
});

test('a SIWES intern still gets the whole logbook', async ({ browser }) => {
  const convex = client();
  const token = await adminToken(convex);

  // `createUser` stamps interns as SIWES — see the comment there.
  const siwes = await createUser(convex, token, 'intern', `siw-${runStamp}`);

  const session = await signIn(siwes.email, siwes.password);
  const context = await browser.newContext({ storageState: storageFor(session) });
  const page = await context.newPage();

  // Same hand-attached watcher as the volunteer test, for the same reason.
  const pageErrors = watchForErrors(page);

  await page.goto('/logbook');

  // The form they are expected to fill in every working day, on the tab they
  // land on without clicking anything.
  await expect(page.getByPlaceholder("Brief title for today's work")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('button', { name: 'Weekly', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();

  pageErrors.assertClean();
  await context.close();
  await destroyUser(convex, token, siwes.id);
});
