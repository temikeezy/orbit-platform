import { anyApi } from 'convex/server';
import type { BrowserContext } from '@playwright/test';
import { test, expect, manifest, storageStateFor } from './support/fixtures';
import { adminToken, client, createUser, destroyUser, signIn } from './support/orbit';
import { toOrbitUser } from '../src/lib/convexAdapters';

/**
 * /settings (733 untested lines), /notifications' unread badge, and
 * /users/:userId's one privacy-sensitive field.
 *
 * The password-change test is the reason this file exists on its own actor
 * rather than the shared intern: changing a password REVOKES every other
 * session for that account (see convex/users.ts), and the shared intern's
 * storageState is reused by every other spec file in this run. Doing this
 * against the shared actor would sign every other spec out from underneath
 * itself. A throwaway account, signed in via the HTTP helper rather than the
 * login FORM, costs nothing from the 15-per-15-minutes form-login budget and
 * cannot strand anyone else's session.
 */

test.describe.configure({ mode: 'serial' });
// The shared intern actor — overridden with a throwaway one only for the
// password-change test, which builds its own context explicitly.
test.use({ storageState: storageStateFor('intern') });

async function actorContext(browser: import('@playwright/test').Browser, session: {
  token: string;
  user: Parameters<typeof toOrbitUser>[0];
}): Promise<BrowserContext> {
  return browser.newContext({
    storageState: {
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
    },
  });
}

test('a throwaway user changes their own password through /settings', async ({ browser }) => {
  const convex = client();
  const su = await adminToken(convex);
  const runId = 'pwd' + Date.now().toString(36).slice(-6);
  const subject = await createUser(convex, su, 'intern', runId);

  const session = await signIn(subject.email, subject.password);
  const context = await actorContext(browser, session);
  const page = await context.newPage();

  const newPassword = `${subject.password}-changed-1`;

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Security', exact: true }).click();

  // No htmlFor/id on any of these three labels — position is the only handle
  // (same story as every other sibling-label form in this codebase). All
  // three stay type="password" unless their own eye-icon toggle is clicked,
  // which this test never does, so the selector stays valid throughout.
  const passwordInputs = page.locator('input[type="password"]');
  await passwordInputs.nth(0).fill(subject.password);
  await passwordInputs.nth(1).fill(newPassword);
  await passwordInputs.nth(2).fill(newPassword);
  await page.getByRole('button', { name: 'Change Password' }).click();

  await expect(page.getByText('Password changed successfully!')).toBeVisible({ timeout: 20_000 });

  // The server's answer, not the toast: the old password must be dead and the
  // new one live. Both through the same HTTP helper every other spec uses to
  // sign in, never the form — this is the one form-login budget this file
  // deliberately does not touch a second time.
  await expect(signIn(subject.email, subject.password)).rejects.toThrow();
  const resigned = await signIn(subject.email, newPassword);
  expect(resigned.token).toBeTruthy();

  await context.close();
  await destroyUser(convex, su, subject.id);
});

test('notification preferences persist through the server, not just the toggle', async ({
  page,
}) => {
  const { users } = manifest();
  const intern = users.find((u) => u.role === 'intern')!;

  /**
   * UserSettingsPage fires its OWN `notificationPreferences.get` on mount and
   * later replaces `preferences` WHOLESALE with whatever that query returns
   * (see UserSettingsPage.tsx's loadPreferences). If that request is still in
   * flight when this test toggles and saves, its late arrival clobbers the
   * save with the PRE-change server value — the toggle visibly flips, the
   * save genuinely succeeds, and then the switch silently reverts, because
   * the save conversation and the stale load are racing on the same client
   * state with no guard between them. `getByLabel`-then-click alone cannot
   * see this: the switch's hardcoded initial state happens to already match
   * the common case (defaults are all `true`), so a wait on its visual state
   * gives a false "loaded" reading. Waiting for the ACTUAL network response
   * this page's own mount effect fires is the only signal that is not
   * ambiguous with that coincidence.
   */
  const initialLoad = page.waitForResponse(
    (r) =>
      r.url().includes('/api/query') &&
      (r.request().postData() ?? '').includes('notificationPreferences:get'),
  );
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await initialLoad;

  const before = await client().query(anyApi.notificationPreferences.get, {
    token: intern.token,
  });

  const row = page
    .locator('.p-4.bg-slate-50.rounded-lg')
    .filter({ hasText: 'New Task Available' });
  const toggle = row.getByRole('button');

  await expect(toggle).toHaveClass(before.newTaskEnabled ? /bg-iih-green/ : /bg-slate-300/, {
    timeout: 20_000,
  });

  await toggle.click();
  await page.getByRole('button', { name: 'Save Preferences' }).click();

  // The button's accessible name cycles Save Preferences -> Saving... ->
  // Saved! and back, and "Saved!" lingers for 3s (see UserSettingsPage.tsx).
  // Waiting for it here, before the poll AND before the second click below,
  // is what stops that second `getByRole('button', { name: 'Save
  // Preferences' })` from racing its own still-visible "Saved!" state from
  // the first save.
  await expect(page.getByRole('button', { name: 'Saved!' })).toBeVisible({ timeout: 20_000 });

  await expect
    .poll(
      async () => {
        const prefs = await client().query(anyApi.notificationPreferences.get, {
          token: intern.token,
        });
        return prefs.newTaskEnabled;
      },
      { message: 'the preference toggle never reached the server', timeout: 20_000 },
    )
    .toBe(!before.newTaskEnabled);

  // Restored — this is the shared intern actor, reused by every other spec
  // file in the run. Same wait as above before clicking: the switch must show
  // the state the poll just confirmed, not merely be expected to.
  await expect(toggle).toHaveClass(!before.newTaskEnabled ? /bg-iih-green/ : /bg-slate-300/, {
    timeout: 20_000,
  });
  await toggle.click();
  await page.getByRole('button', { name: 'Save Preferences' }).click();
  await expect(page.getByRole('button', { name: 'Saved!' })).toBeVisible({ timeout: 20_000 });

  await expect
    .poll(async () => {
      const prefs = await client().query(anyApi.notificationPreferences.get, {
        token: intern.token,
      });
      return prefs.newTaskEnabled;
    }, { timeout: 20_000 })
    .toBe(before.newTaskEnabled);
});

test('the display-email toggle is honoured for a stranger and bypassed for staff', async ({
  page,
  browser,
}) => {
  const { users, userId } = manifest();
  const intern = users.find((u) => u.role === 'intern')!;
  const convex = client();
  const su = await adminToken(convex);

  // A second, unrelated intern — "cross-actor" means someone who is not staff
  // and not the profile owner, which the shared moderator actor cannot stand
  // in for (users.ts:36 already grants staff an unconditional read).
  const runId = 'peer' + Date.now().toString(36).slice(-6);
  const peer = await createUser(convex, su, 'intern', runId);
  const peerSession = await signIn(peer.email, peer.password);
  const peerContext = await actorContext(browser, peerSession);
  const peerPage = await peerContext.newPage();

  const original = (await convex.query(anyApi.users.me, { token: intern.token })).showEmail ?? false;

  // UserSettingsPage's own mount-time `users.me` query populates
  // `profileSettings.show_email` and then replaces it wholesale once that
  // request resolves (see the notification-preferences test above for the
  // full mechanics). Waiting for that exact response before touching the
  // toggle is what keeps this test's own click from being clobbered by that
  // late-arriving overwrite.
  const initialLoad = page.waitForResponse(
    (r) => r.url().includes('/api/query') && (r.request().postData() ?? '').includes('users:me'),
  );
  await page.goto('/settings');
  // Exact: the default-active Profile tab renders its own "Profile Settings"
  // h2 alongside the page's "Settings" h1, and a loose match resolves to both.
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await initialLoad;

  const emailToggle = page
    .locator('.p-4.bg-slate-50.rounded-lg')
    .filter({ hasText: 'Display Email Address' })
    .getByRole('button');

  // Driven from the server's own answer, not a class name sniffed off the
  // toggle — the button renders `bg-iih-green` when on, but reading a
  // Tailwind class back out of the DOM to infer state is exactly the kind of
  // thing that breaks quietly the day the class name changes for a reason
  // that has nothing to do with this test.
  if (original) await emailToggle.click();
  await page.getByRole('button', { name: 'Save Settings' }).click();

  await expect
    .poll(
      async () => {
        const me = await convex.query(anyApi.users.me, { token: intern.token });
        return me.showEmail;
      },
      { message: 'turning off Display Email Address never saved', timeout: 20_000 },
    )
    .toBe(false);

  await peerPage.goto(`/users/${userId}`);
  await expect(peerPage.getByRole('heading', { name: intern.fullName })).toBeVisible({
    timeout: 20_000,
  });
  await expect(peerPage.getByText(intern.email)).toHaveCount(0);

  // Staff bypass the flag — users.ts:36's `viewerIsStaff` check.
  const modContext = await browser.newContext({ storageState: storageStateFor('moderator') });
  const modPage = await modContext.newPage();
  await modPage.goto(`/users/${userId}`);
  await expect(modPage.getByText(intern.email)).toBeVisible({ timeout: 20_000 });

  // Restored to whatever it actually was before this test touched it. Same
  // load-race wait as the first navigation above.
  const restoreLoad = page.waitForResponse(
    (r) => r.url().includes('/api/query') && (r.request().postData() ?? '').includes('users:me'),
  );
  await page.goto('/settings');
  await restoreLoad;
  const toggleAgain = page
    .locator('.p-4.bg-slate-50.rounded-lg')
    .filter({ hasText: 'Display Email Address' })
    .getByRole('button');
  if (!original) {
    // Already false is the restored state — nothing to click.
  } else {
    await toggleAgain.click();
    await page.getByRole('button', { name: 'Save Settings' }).click();
  }
  await expect
    .poll(async () => (await convex.query(anyApi.users.me, { token: intern.token })).showEmail ?? false, {
      timeout: 20_000,
    })
    .toBe(original);

  await peerContext.close();
  await modContext.close();
  await destroyUser(convex, su, peer.id);
});

test('marking notifications read updates this one and shrinks the unread count', async ({
  page,
}) => {
  const { users } = manifest();
  const intern = users.find((u) => u.role === 'intern')!;
  const moderator = users.find((u) => u.role === 'moderator')!;

  // A real notification, from a real message — the same path
  // messaging.spec.ts drives through the UI, here sent directly since the
  // point of this test is /notifications, not compose.
  const body = `E2E notification badge ${Date.now()}`;
  await client().mutation(anyApi.messages.send, {
    token: moderator.token,
    recipientId: intern.id,
    content: body,
  });

  // THIS notification, found by its unique body — notifyNewMessage copies the
  // message content into the notification verbatim (well inside its 140-char
  // cap). The shared unreadCount cannot stand in for it: every parallel spec
  // file notifies this same intern, so a nonzero count is not evidence the
  // message above produced anything.
  const myNotification = async () => {
    const rows = (await client().query(anyApi.notifications.list, {
      token: intern.token,
      limit: 100,
    })) as { id: string; content: string; isRead: boolean }[];
    return rows.find((n) => n.content === body) ?? null;
  };

  await page.goto('/');
  await expect
    .poll(async () => (await myNotification()) !== null, {
      message: 'sending the message never created a notification',
      timeout: 20_000,
    })
    .toBe(true);

  // Some unread count exists — ours at minimum — so the badge must show. This
  // is safe against parallel specs because they only ever ADD unread rows for
  // this actor; nothing but this test's own click removes them.
  await page.reload();
  await expect(page.getByLabel(/Notifications \(\d+ unread\)/)).toBeVisible({ timeout: 20_000 });

  await page.goto('/notifications');
  const row = page.locator('div.bg-white.rounded-xl').filter({ hasText: body });
  await expect(row).toBeVisible({ timeout: 20_000 });

  // Read as late as possible: the count below only has to DECREASE from this
  // reading, and every second between it and the click is a second in which a
  // parallel spec can widen the gap the wrong way.
  const before = (await client().query(anyApi.notifications.unreadCount, {
    token: intern.token,
  })) as number;

  await page.getByRole('button', { name: 'Mark all as read' }).click();

  /**
   * Per-entity first, then a delta — never "the count reached zero". This used
   * to poll the shared unreadCount to exactly 0 and then assert the no-unread
   * nav label, but unreadCount is a per-USER global on the shared intern, and
   * one notification arriving from a parallel spec mid-flight pins the count
   * above zero for the full poll timeout (or resurrects the badge) and fails a
   * mark-all-read that worked. THIS notification turning read is the fact the
   * click owns; the count merely has to have gone DOWN from the pre-click
   * reading, which a fresh unread arrival cannot retroactively undo.
   */
  await expect
    .poll(async () => (await myNotification())?.isRead, {
      message: 'mark-all-as-read never reached this notification',
      timeout: 20_000,
    })
    .toBe(true);

  // The row's own affordance agrees: "Mark read" renders only beside unread
  // rows (NotificationsPage.tsx), and the list is live over the Convex
  // subscription, so the button drops off without a reload.
  await expect(row.getByRole('button', { name: 'Mark read' })).toHaveCount(0, {
    timeout: 20_000,
  });

  await expect
    .poll(
      async () => client().query(anyApi.notifications.unreadCount, { token: intern.token }),
      { message: 'the unread count never fell below its pre-click reading', timeout: 20_000 },
    )
    .toBeLessThan(before);
});
