import { test, expect } from './support/fixtures';
import { adminToken, client, createUser, destroyUser, SITE_URL } from './support/orbit';
import { anyApi } from 'convex/server';

/**
 * F8 — sign-in.
 *
 * These are the only specs that drive the login FORM. Everything else seeds a
 * session through storageState, because the `login` rate limit is 15 per 15
 * minutes per account and a per-spec sign-in would trip it partway through a
 * run — surfacing as a wrong-password failure, which is a bad way to learn you
 * have a rate limit.
 *
 * Not covered, and not coverable: magic-link REDEMPTION and Zoho SSO. The magic
 * token is only ever written to `emailQueue` and never returned to a caller, and
 * Zoho needs a live OAuth round-trip against a third party. The request side of
 * both is asserted here; the redemption half is a documented manual check.
 */

// Serial: these share one disposable account, and its rate-limit budget.
test.describe.configure({ mode: 'serial' });

test.use({ storageState: { cookies: [], origins: [] } });

let actor: { id: string; email: string; password: string };
let convex: ReturnType<typeof client>;
let token: string;

test.beforeAll(async () => {
  convex = client();
  token = await adminToken(convex);
  const runId = test.info().project.name + Date.now().toString(36).slice(-5);
  actor = await createUser(convex, token, 'intern', runId);
});

test.afterAll(async () => {
  if (actor) await destroyUser(convex, token, actor.id);
});

test('signs in with a password and lands authenticated', async ({ page, pageErrors }) => {
  await page.goto('/');

  await page.getByLabel('Email').fill(actor.email);
  await page.getByLabel('Password').fill(actor.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();

  // The nav only renders for an authenticated user, so its appearance is the
  // assertion that the session took — not just that the form submitted.
  await expect(page.locator('nav').first()).toBeVisible();
  await expect(page.getByLabel('Password')).toHaveCount(0);

  pageErrors.assertClean();
});

test('refuses a wrong password without saying which half was wrong', async ({ page }) => {
  await page.goto('/');

  await page.getByLabel('Email').fill(actor.email);
  await page.getByLabel('Password').fill('definitely-not-the-password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();

  const error = page.getByText(/invalid email or password/i);
  await expect(error).toBeVisible();
  // A message naming the email as valid is an account-existence oracle. The
  // server returns one string for both halves; this asserts the UI shows it.
  await expect(page.getByText(/no such account|user not found|wrong password/i)).toHaveCount(0);
});

test('refuses an unknown address with the same message', async ({ page }) => {
  await page.goto('/');

  await page.getByLabel('Email').fill('nobody-at-all@iih.ng');
  await page.getByLabel('Password').fill('whatever-123');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();

  await expect(page.getByText(/invalid email or password/i)).toBeVisible();
});

test('refuses a deactivated account', async ({ page }) => {
  const runId = 'deact' + Date.now().toString(36).slice(-5);
  const victim = await createUser(convex, token, 'intern', runId);

  await convex.mutation(anyApi.users.adminSetActive, {
    token,
    userId: victim.id,
    isActive: false,
  });

  // Wait for the deactivation to be observable before trying to sign in.
  // The mutation goes through this client; the login goes through the browser's
  // own, and read-your-writes is a per-client guarantee — so under parallel
  // load the sign-in could reach a snapshot from just before the write and
  // succeed, failing this spec for a reason that is not about deactivation.
  await expect
    .poll(
      async () => {
        const u = await convex.query(anyApi.users.adminGetById, { token, userId: victim.id });
        return u?.isActive;
      },
      { message: 'the deactivation never landed', timeout: 20_000 },
    )
    .toBe(false);

  await page.goto('/');
  await page.getByLabel('Email').fill(victim.email);
  await page.getByLabel('Password').fill(victim.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();

  // Deliberately the SAME message as a wrong password, and returned before the
  // hash is compared. A distinct "your account is inactive" shown only after a
  // correct password confirms both that the account exists and that the
  // password was right.
  await expect(page.getByText(/invalid email or password/i)).toBeVisible();
  await expect(page.locator('nav').first()).toHaveCount(0);

  await destroyUser(convex, token, victim.id);
});

test('switches to the magic-link form and accepts a request', async ({ page, pageErrors }) => {
  await page.goto('/');

  await page.getByRole('button', { name: /magic link instead/i }).click();
  await page.getByLabel('Email').fill(actor.email);
  await page.getByRole('button', { name: /send magic link/i }).click();

  // Always an acknowledgement, never "no such account" — the response must not
  // reveal whether the address is registered.
  await expect(page.getByText('Check your email')).toBeVisible();

  pageErrors.assertClean();
});

test('offers Zoho SSO as a real button', async ({ page }) => {
  await page.goto('/');
  // Redemption is not drivable here, but a missing or broken button is — this
  // is how every staff member signs in.
  await expect(page.getByLabel('Sign in with Zoho')).toBeVisible();
});

test('signing out clears the session and revokes the token server-side', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(actor.email);
  await page.getByLabel('Password').fill(actor.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.locator('nav').first()).toBeVisible();

  const sessionToken = await page.evaluate(() => localStorage.getItem('orbit_auth_token_v2'));
  expect(sessionToken).toBeTruthy();

  await page.getByLabel('User profile menu').click();
  await page.getByRole('button', { name: 'Sign Out' }).click();

  await expect(page.getByLabel('Password')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('orbit_auth_token_v2'))).toBeNull();

  // Clearing localStorage is not signing out. The token must be dead on the
  // server too, or anyone who captured it still holds a live session.
  //
  // Polled rather than asserted once: `authService.logout` clears local state
  // first and dispatches the revocation fire-and-forget, so that a network
  // failure cannot strand a user on a page they cannot leave. The revocation is
  // therefore a moment behind the redirect — but it does have to arrive.
  await expect
    .poll(
      () =>
        convex.query(anyApi.users.me, { token: sessionToken as string }).then(
          () => true,
          () => false,
        ),
      { message: 'the token still authenticates after sign-out', timeout: 15_000 },
    )
    .toBe(false);
});

test('a raw Zoho callback is forwarded to Convex, not to the old Supabase path', async ({
  page,
}) => {
  /**
   * The regression this exists for.
   *
   * Zoho's registered redirect URI is the plain app URL, so Zoho drops the
   * browser on /oauthredirect carrying ?code=&state=. That page recognises "a
   * code with no success flag" as a raw Zoho callback and forwards it to the
   * endpoint that holds the client secret.
   *
   * It used to forward to `/api/zoho-oauth-callback`, a Supabase edge function
   * reached through an `/api/* -> functions/v1/*` proxy in netlify.toml. That
   * proxy was deliberately removed at cutover, so the forward landed on a path
   * that no longer existed — and Zoho is how every staff member signs in. There
   * was no error: just the app URL with an authorization code stuck in the query
   * string.
   *
   * The state below is deliberately invalid, so the flow stops at the state
   * check and never reaches Zoho's token endpoint. What is being asserted is
   * WHERE the browser was sent, not that a fake login succeeds.
   */
  await page.goto('/oauthredirect?code=fake-authorization-code&state=fake-state');

  await page.waitForURL(/zoho\/callback|oauthredirect\?success=false/, { timeout: 20_000 });

  const seen = page.url();
  expect(seen, 'the callback still points at the removed Supabase proxy').not.toContain(
    '/api/zoho-oauth-callback',
  );
  // Either mid-forward at the Convex endpoint, or already bounced back with the
  // state refusal — both prove the forward reached a route that exists.
  expect(seen).toMatch(/zoho\/callback|success=false/);
});

test('a magic link can actually be redeemed, and only once', async ({ page, pageErrors }) => {
  /**
   * The half that could not be automated until now.
   *
   * The magic token is written only to `emailQueue` and never returned to any
   * caller — deliberately, since anything that hands it back turns "request a
   * link" into "sign in as that address". So redeeming one requires reading the
   * queued email, and `emailQueue.adminGetBody` is super-admin only and writes
   * an audit row every time it is used.
   *
   * That is exactly what the dev deployment's MCP actor is, which is why this
   * runs here and cannot run against production. It was previously written down
   * as a permanent manual check; it is not.
   */
  const convex = client();
  const su = await adminToken(convex);

  const runId = 'magic' + Date.now().toString(36).slice(-5);
  const subject = await createUser(convex, su, 'intern', runId);

  // --- request, through the form ------------------------------------------
  await page.goto('/');
  await page.getByRole('button', { name: /magic link instead/i }).click();
  await page.getByLabel('Email').fill(subject.email);
  await page.getByRole('button', { name: /send magic link/i }).click();
  await expect(page.getByText('Check your email')).toBeVisible();

  // --- read the queued email ----------------------------------------------
  const magicUrlFor = async (email: string): Promise<string | null> => {
    // `{ stats, logs }`, not a bare array — the stats are computed over the
    // whole table rather than the page, so the dashboard cannot report "3
    // failed" when the page happens to hold three of forty.
    const { logs } = (await convex.query(anyApi.emailQueue.adminList, {
      token: su,
      limit: 200,
    })) as { logs: { id: string; recipientEmail: string }[] };

    const mine = logs.find((r) => r.recipientEmail === email);
    if (!mine) return null;

    const body = (await convex.mutation(anyApi.emailQueue.adminGetBody, {
      token: su,
      emailId: mine.id,
    })) as { success: boolean; bodyHtml?: string; bodyText?: string };
    if (!body.success) return null;

    const text = `${body.bodyHtml ?? ''} ${body.bodyText ?? ''}`;
    // The dot is significant: a magic token is `selector.verifier`, and a
    // character class without it silently truncates to the selector — which
    // then fails to redeem for a reason that looks nothing like the cause.
    return text.match(/https?:\/\/[^\s"'<>]*\/magic[#?]token=[A-Za-z0-9_.-]+/)?.[0] ?? null;
  };

  await expect
    .poll(() => magicUrlFor(subject.email), {
      message: 'no magic-link email was queued',
      timeout: 30_000,
    })
    .not.toBeNull();

  const link = (await magicUrlFor(subject.email))!;

  // The email points at the deployment's configured APP_URL, which is not the
  // preview server this suite drives. Only the token travels.
  // The emailed link carries the token in the FRAGMENT now — a query string
  // reaches the web server's logs and can travel in a Referer header.
  const parsed = new URL(link);
  const token =
    new URLSearchParams(parsed.hash.replace(/^#/, '')).get('token') ??
    parsed.searchParams.get('token')!;
  expect(token.length).toBeGreaterThan(20);

  // --- redeem --------------------------------------------------------------
  await page.goto(`/magic#token=${token}`);

  // Signed in: the nav only renders for an authenticated user.
  await expect(page.locator('nav').first()).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => localStorage.getItem('orbit_auth_token_v2'))).toBeTruthy();

  pageErrors.assertClean();

  // --- single use ----------------------------------------------------------
  //
  // Redemption is an HTTP action, not a mutation: Convex records function
  // arguments in its logs, so passing a live sign-in credential as one wrote it
  // into the logs for as long as the link was valid.
  const replay = await fetch(`${SITE_URL}/auth/magic-link/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  // The link is consumed on redemption. An emailed URL sits in an inbox
  // forever; replayable, it is a permanent credential for that account.
  expect(((await replay.json()) as { success: boolean }).success).toBe(false);

  await destroyUser(convex, su, subject.id);
});
