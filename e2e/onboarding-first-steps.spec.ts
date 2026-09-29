import { anyApi } from 'convex/server';
import { test, expect, manifest, storageStateFor, watchForErrors } from './support/fixtures';
import { adminToken, client, destroyUser, SITE_URL } from './support/orbit';

/**
 * F9 — onboarding first steps: derived, never recorded.
 *
 * "Set your password" and "Read the orientation manual" render in two places —
 * the home checklist (OnboardingChecklist) and task-shaped cards above the
 * filter bar on /tasks (FirstStepsTasks) — off ONE server source,
 * `onboarding.status`, which derives each step from the member's own record:
 * `passwordHash` exists, `orientationReadAt` is set. NOTHING is written when a
 * step completes. There is no task row, no submission and no review anywhere in
 * the flow, and that absence is the design (see convex/onboarding.ts for what
 * real rows would have cost). It is also the thing most likely to break
 * silently: someone "simplifying" these into real tasks keeps every screen
 * green while quietly reintroducing every cost the design note lists. So this
 * spec proves the derivation from the outside: do the real action, watch the
 * card flip, and assert the database gained no rows in between.
 *
 * A DEDICATED ACTOR, not the shared intern fixture, for two reasons that
 * compound:
 *
 *  - The shared intern CANNOT show the undone state. Fixture users come from
 *    `users.adminCreateUser`, which writes `passwordHash` at creation
 *    (convex/users.ts), so their password step is born done. The only creation
 *    path that produces a passwordless intern is application conversion
 *    (`convertApprovedApplications`: "NO passwordHash and NO tempPassword") —
 *    which is also exactly the population this feature exists for.
 *  - Setting a password is a real, irreversible state change — nothing ever
 *    un-sets a passwordHash — and `changePassword` revokes every OTHER session
 *    on the account. Doing either to the one intern every parallel spec file
 *    shares is sabotage, even where it happens to survive.
 *
 * So the spec walks the real journey: apply through the public intake, be
 * approved, be converted, sign in by the magic link, and then do the first
 * step the checklist asks for. Slower than seeding, but every hop is one a
 * production member actually makes, and the hops are what broke before
 * (`/settings` landing on the Profile tab, hiding the form the link promised).
 */

/** A one-pixel PNG. Intake verifies magic bytes, not just the declared mime. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const stamp = Date.now().toString(36);
const applicantEmail = `e2e-onboarding-${stamp}@iih.ng`;
const applicantName = `E2E Onboarding ${stamp}`;

/** Set once the conversion lands, so teardown can remove the real account. */
let memberId: string | undefined;

test.afterAll(async () => {
  if (!memberId) return;
  const convex = client();
  const su = await adminToken(convex);
  await destroyUser(convex, su, memberId);
});

test('a converted applicant sets a password and the card derives done — with no rows written', async ({
  page,
  pageErrors,
}) => {
  // The journey spans the intake funnel, a scheduled conversion, an email
  // round-trip through the queue and four screens. Each wait below is bounded;
  // this is their sum, not a hope.
  test.setTimeout(180_000);

  const convex = client();
  const su = await adminToken(convex);

  // --- a passwordless intern can only be MADE through the funnel ----------
  const submitted = (await (
    await fetch(`${SITE_URL}/applications/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        programme_type: 'internship', // not SIWES: no letter, no dates needed
        full_name: applicantName,
        email: applicantEmail,
        phone: '08000000000',
        location: 'Ilorin, Kwara State',
        emergency_contact_name: 'E2E Next of Kin',
        emergency_contact_phone: '08111111111',
        consent_logbook: true,
        consent_data_use: true,
        passport_photo: {
          name: 'passport.png',
          type: 'image/png',
          data_url: `data:image/png;base64,${PNG_BASE64}`,
        },
        // `website` (the honeypot) is deliberately absent.
      }),
    })
  ).json()) as { success?: boolean; reference_code?: string; error?: string };

  expect(submitted.success, `intake refused the application: ${submitted.error}`).toBe(true);
  // A tripped honeypot also answers success — but without a reference code.
  expect(submitted.reference_code, 'the honeypot swallowed the application').toBeTruthy();

  let applicationId: string | undefined;
  await expect
    .poll(
      async () => {
        const rows = (await convex.query(anyApi.applications.list, {
          token: su,
          limit: 200,
        })) as { id: string; email: string }[];
        applicationId = rows.find((a) => a.email === applicantEmail)?.id;
        return applicationId;
      },
      { message: 'the application never reached the queue', timeout: 20_000 },
    )
    .toBeTruthy();

  // Approved via the API: the admissions SCREEN is application-intake.spec.ts's
  // subject, not a prerequisite this spec should re-run.
  const approved = (await convex.mutation(anyApi.applications.updateStatus, {
    token: su,
    applicationId,
    status: 'approved',
  })) as { success: boolean; error?: string };
  expect(approved.success, `approval failed: ${approved.error}`).toBe(true);

  // Conversion is scheduled (`runAfter(0)`), so it is observable only as the
  // account coming into being. The admin register is users.list — there is no
  // narrower admin lookup by email.
  await expect
    .poll(
      async () => {
        const users = (await convex.query(anyApi.users.list, {
          token: su,
          includeInactive: true,
        })) as { id: string; email?: string }[];
        memberId = users.find((u) => u.email === applicantEmail)?.id;
        return memberId;
      },
      { message: 'the approved application never converted into an account', timeout: 30_000 },
    )
    .toBeTruthy();

  // --- in by magic link: the only door with no password set ----------------
  await fetch(`${SITE_URL}/auth/magic-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: applicantEmail }),
  });

  // The token is only ever written into the queued email. Conversion queues an
  // acceptance email for this same address (carrying a PLACEHOLDER link, minted
  // for real only at send time), so the search is pinned to emailType
  // 'magic_link' rather than trusting "first email for this recipient".
  const magicTokenFor = async (): Promise<string | null> => {
    const { logs } = (await convex.query(anyApi.emailQueue.adminList, {
      token: su,
      limit: 200,
    })) as { logs: { id: string; recipientEmail: string; emailType?: string }[] };

    const mine = logs.find(
      (r) => r.recipientEmail === applicantEmail && r.emailType === 'magic_link',
    );
    if (!mine) return null;

    const body = (await convex.mutation(anyApi.emailQueue.adminGetBody, {
      token: su,
      emailId: mine.id,
    })) as { success: boolean; bodyHtml?: string; bodyText?: string };
    if (!body.success) return null;

    // The dot matters: a magic token is `selector.verifier`, and a character
    // class without it truncates to the selector (see auth.spec.ts).
    const link = `${body.bodyHtml ?? ''} ${body.bodyText ?? ''}`.match(
      /https?:\/\/[^\s"'<>]*\/magic[#?]token=[A-Za-z0-9_.-]+/,
    )?.[0];
    if (!link) return null;

    const parsed = new URL(link);
    return (
      new URLSearchParams(parsed.hash.replace(/^#/, '')).get('token') ??
      parsed.searchParams.get('token')
    );
  };

  await expect
    .poll(magicTokenFor, { message: 'no magic-link email was queued', timeout: 30_000 })
    .not.toBeNull();

  await page.goto(`/magic#token=${await magicTokenFor()}`);
  await expect(page.locator('nav').first()).toBeVisible({ timeout: 20_000 });

  const memberToken = (await page.evaluate(() =>
    localStorage.getItem('orbit_auth_token_v2'),
  )) as string;
  expect(memberToken).toBeTruthy();

  // --- the source of truth, before -----------------------------------------
  const before = (await convex.query(anyApi.onboarding.status, {
    token: memberToken,
  })) as {
    applicable: boolean;
    complete: boolean;
    steps: { key: string; done: boolean; href: string | null }[];
  };
  expect(before.applicable).toBe(true);
  expect(before.complete).toBe(false);
  const pwBefore = before.steps.find((s) => s.key === 'password');
  expect(pwBefore?.done, 'a converted applicant must not arrive with a password').toBe(false);
  expect(pwBefore?.href).toBe('/settings?tab=security');

  // The steps are not rows: the member can see no task named for either step,
  // and owns no submissions at all. Asserted BEFORE the action so the same
  // check after it can only be explained by derivation, not by cleanup.
  const stepTitles = ['Set your password', 'Read the orientation manual'];
  const tasksBefore = (await convex.query(anyApi.tasks.listForUser, {
    token: memberToken,
  })) as { title: string }[];
  expect(tasksBefore.map((t) => t.title)).not.toEqual(expect.arrayContaining([stepTitles[0]]));
  expect(tasksBefore.map((t) => t.title)).not.toEqual(expect.arrayContaining([stepTitles[1]]));
  expect(
    (await convex.query(anyApi.tasks.mySubmissions, { token: memberToken })) as unknown[],
  ).toEqual([]);

  // --- the home checklist ---------------------------------------------------
  await page.goto('/');
  const checklist = page.locator('section[aria-labelledby="onboarding-heading"]');
  await expect(checklist.getByRole('heading', { name: 'Your first steps' })).toBeVisible();
  await expect(checklist.getByText('Set your password')).toBeVisible();
  await expect(checklist.getByText('Read the orientation manual')).toBeVisible();
  // Sign-in is derived done by definition; password and manual remain.
  await expect(checklist.getByText('2 left')).toBeVisible();

  // --- the task-shaped cards on /tasks -------------------------------------
  await page.goto('/tasks');
  const firstSteps = page.locator('section[aria-labelledby="first-steps-heading"]');
  await expect(firstSteps.getByRole('heading', { name: 'First steps' })).toBeVisible();
  await expect(firstSteps.getByText('Set your password')).toBeVisible();
  await expect(firstSteps.getByText('Read the orientation manual')).toBeVisible();
  await expect(firstSteps.getByText('Completes on its own — nothing to submit')).toHaveCount(2);
  await expect(firstSteps.getByText('2 to go')).toBeVisible();

  // NOT in the task list the filter bar enumerates. The cards exist once, in
  // their own section above the bar — and the data the filters count comes from
  // tasks.listForUser, which was asserted above to know nothing of either step.
  await expect(page.getByText('Set your password')).toHaveCount(1);
  await page.getByRole('button', { name: 'My Submitted' }).click();
  // A filter click reshapes the LIST; the derived cards are outside it and stay.
  await expect(firstSteps.getByText('Set your password')).toBeVisible();
  await expect(page.getByText('Set your password')).toHaveCount(1);
  await page.getByRole('button', { name: 'All Tasks' }).click();

  // --- the card links to the SECURITY tab, not Profile (the real bug) ------
  await firstSteps.locator('a[href="/settings?tab=security"]').click();
  await page.waitForURL(/\/settings\?tab=security/);
  await expect(page.getByRole('heading', { name: 'Security Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Profile Settings' })).toHaveCount(0);
  await expect(page.getByLabel('New Password', { exact: true })).toBeVisible();
  // First password: nothing exists to confirm, so the form must not demand a
  // "current" password the account has never had.
  await expect(page.getByLabel('Current Password', { exact: true })).toHaveCount(0);

  // --- the real action ------------------------------------------------------
  const newPassword = `E2E-first-pw-${stamp}!`;
  await page.getByLabel('New Password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm New Password', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'Change Password' }).click();
  await expect(page.getByText('Password changed successfully!')).toBeVisible({ timeout: 20_000 });

  // --- the flip, at the source ---------------------------------------------
  // Polled: the browser's mutation resolved, but this reads through a second
  // client, and read-your-writes is a per-client guarantee.
  await expect
    .poll(
      async () => {
        const s = (await convex.query(anyApi.onboarding.status, { token: memberToken })) as {
          steps: { key: string; done: boolean }[];
        };
        return s.steps.find((x) => x.key === 'password')?.done;
      },
      { message: 'the password step never derived done', timeout: 20_000 },
    )
    .toBe(true);

  // THE PROPERTY THIS SPEC EXISTS FOR. The step completed, and the member
  // still owns no submissions and can still see no task named for it: nothing
  // was submitted, nothing was reviewed, no row was written. The only thing
  // that changed is users.passwordHash — which is what the member came to do.
  expect(
    (await convex.query(anyApi.tasks.mySubmissions, { token: memberToken })) as unknown[],
  ).toEqual([]);
  const tasksAfter = (await convex.query(anyApi.tasks.listForUser, {
    token: memberToken,
  })) as { title: string }[];
  expect(tasksAfter.map((t) => t.title)).not.toEqual(expect.arrayContaining([stepTitles[0]]));
  expect(tasksAfter.map((t) => t.title)).not.toEqual(expect.arrayContaining([stepTitles[1]]));

  // --- both surfaces agree, having each refetched the one source -----------
  await page.goto('/tasks');
  await expect(firstSteps.getByText('1 to go')).toBeVisible();
  await expect(firstSteps.getByText('Set your password')).toBeVisible();
  await expect(firstSteps.getByText('Done', { exact: true })).toBeVisible();
  // Only the manual card still offers anything; the done card stops being a
  // link entirely — there is nowhere left to send anyone.
  await expect(firstSteps.getByText('Completes on its own — nothing to submit')).toHaveCount(1);
  await expect(firstSteps.locator('a[href="/settings?tab=security"]')).toHaveCount(0);

  await page.goto('/');
  await expect(checklist.getByText('1 left')).toBeVisible();
  await expect(checklist.getByText('Set your password')).toBeVisible();

  pageErrors.assertClean();
});

test('staff see neither the checklist nor the first-steps cards', async ({ browser }) => {
  const convex = client();

  // The server contract first: `applicable: false` for staff is what GUARANTEES
  // the surfaces render nothing — both components early-return on it. The UI
  // absence checks below document the surfaces, but an absence assertion alone
  // can pass while a fetch is still in flight; this cannot.
  const { users } = manifest();
  const admin = users.find((u) => u.role === 'admin')!;
  const status = (await convex.query(anyApi.onboarding.status, { token: admin.token })) as {
    applicable: boolean;
    steps: unknown[];
  };
  expect(status.applicable).toBe(false);
  expect(status.steps).toEqual([]);

  const adminContext = await browser.newContext({ storageState: storageStateFor('admin') });
  const adminPage = await adminContext.newPage();
  const errors = watchForErrors(adminPage);

  await adminPage.goto('/');
  // Anchor on the loaded page before asserting an absence on it.
  await expect(adminPage.getByText(/Welcome back/)).toBeVisible();
  await expect(adminPage.locator('section[aria-labelledby="onboarding-heading"]')).toHaveCount(0);
  await expect(adminPage.getByText('Set your password')).toHaveCount(0);

  await adminPage.goto('/tasks');
  // The filter bar only renders once loading resolves, so it anchors the page.
  await expect(adminPage.getByRole('button', { name: 'All Tasks' })).toBeVisible();
  await expect(adminPage.locator('section[aria-labelledby="first-steps-heading"]')).toHaveCount(0);
  await expect(adminPage.getByText('Completes on its own — nothing to submit')).toHaveCount(0);

  errors.assertClean();
  await adminContext.close();
});
