import { anyApi } from 'convex/server';
import { test, expect, storageStateFor } from './support/fixtures';
import { adminToken, client, SITE_URL } from './support/orbit';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * F2 — the application funnel: a stranger applies, an admin finds it, moves it
 * through the pipeline, and opens the uploaded document.
 *
 * `/apply` is the only unauthenticated write in the platform, which makes it the
 * one surface a stranger can reach — and the whole module had no test of any
 * kind. Two of its rules are only observable from outside: the honeypot must
 * stay empty, and `applicationIntakePerEmail` allows three per hour, so the
 * address is stamped per run.
 *
 * The status vocabulary is the other reason this exists. The server accepted
 * `accepted`/`withdrawn` while the client sent `approved`/`converted`, so an
 * application could never actually be approved. Nothing caught it because
 * nothing ever drove the screen.
 */

test.describe.configure({ mode: 'serial' });

const runStamp = Date.now().toString(36);
const applicantEmail = `e2e-applicant-${runStamp}@iih.ng`;
const applicantName = `E2E Applicant ${runStamp}`;

/** A one-pixel PNG. The declared mime must match the bytes — intake checks. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function pngFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-e2e-'));
  const file = path.join(dir, 'passport.png');
  writeFileSync(file, Buffer.from(PNG_BASE64, 'base64'));
  return file;
}

test('a stranger applies and an admin moves the application through', async ({ browser }) => {
  const convex = client();
  const token = await adminToken(convex);

  // --- the public form ----------------------------------------------------
  const publicContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const publicPage = await publicContext.newPage();

  await publicPage.goto('/apply');

  // Internship rather than SIWES: SIWES additionally demands an institution,
  // matric number, dates and a placement letter, none of which this flow is
  // about. F3 covers the SIWES side.
  await publicPage.getByLabel(/Programme type/).selectOption('internship');
  await publicPage.getByLabel(/Full name/).fill(applicantName);
  await publicPage.getByLabel(/^Email/).fill(applicantEmail);
  await publicPage.getByLabel(/Phone number/).fill('08000000000');
  await publicPage.getByLabel(/Current location/).fill('Ilorin, Kwara State');
  await publicPage.getByLabel(/Passport photograph/).setInputFiles(pngFixture());
  await publicPage.getByLabel(/Emergency contact name/).fill('E2E Next of Kin');
  await publicPage.getByLabel(/Emergency contact phone/).fill('08111111111');
  await publicPage.locator('#consent-programme').check();
  await publicPage.locator('#consent-data-use').check();

  await publicPage.getByRole('button', { name: 'Submit application' }).click();
  await expect(publicPage.getByText('Application received')).toBeVisible();

  // --- the admin's queue --------------------------------------------------
  const adminContext = await browser.newContext({ storageState: storageStateFor('admin') });
  const adminPage = await adminContext.newPage();

  await adminPage.goto('/admin');
  // The GENERAL queue, not the SIWES one: this applicant is an internship, and
  // the SIWES section is scoped to SIWES candidates.
  await adminPage.getByRole('button', { name: 'Applications', exact: true }).first().click();

  await expect(adminPage.getByText(applicantName)).toBeVisible({ timeout: 20_000 });

  // --- the status the client and server used to disagree about ------------
  const stored = (await convex.query(anyApi.applications.list, {
    token,
    limit: 50,
  })) as { id: string; email: string; status: string }[];

  const mine = stored.find((a) => a.email === applicantEmail);
  expect(mine, 'the application never reached the database').toBeTruthy();
  // 'submitted' is the intake state. The client and the server used to disagree
  // about this vocabulary — the server's terminal states were accepted/withdrawn
  // while the screens sent approved/converted, so nothing could ever be
  // approved. This asserts the agreed set end to end.
  expect(mine!.status).toBe('submitted');

  // --- approved BY THE SCREEN ---------------------------------------------
  // Through the row's own Approve button rather than the API. That is the
  // version an admin actually uses. It replaced a status dropdown: there is one
  // decision and it is irreversible, and a select implies you can pick your way
  // back.
  adminPage.on('dialog', (d) => d.accept());
  const row = adminPage.getByRole('row').filter({ hasText: applicantName });
  await row.getByRole('button', { name: 'Approve' }).click();

  await expect
    .poll(
      async () => {
        const rows = (await convex.query(anyApi.applications.list, {
          token,
          limit: 50,
        })) as { email: string; status: string }[];
        return rows.find((a) => a.email === applicantEmail)?.status;
      },
      { message: 'the status change never reached the database', timeout: 20_000 },
    )
    .toBe('approved');

  // The row offers nothing further: approval is one-way, so once it lands there
  // is no control left to render. The absence of the button is the assertion —
  // it is the thing an admin would try to click twice.
  await expect(row.getByRole('button', { name: 'Approve' })).toHaveCount(0, { timeout: 20_000 });

  // The filter is exercised on the SAME page, without reloading.
  //
  // A reload starts a fresh Convex client, and read-your-writes is a per-client
  // guarantee — a new client may briefly observe a snapshot from just before
  // this write. That showed up as a spec that passed alone and failed under
  // parallel load, which is the worst kind. The write happened on this page's
  // client, so this page can see it.
  // Status is a segmented control now, not a dropdown: pending and approved are
  // different jobs — a decision queue and a record you print letters from — and
  // an option buried among the filters made them read as one list seen through
  // a lens. The remaining <select> on this screen is the sort order.
  await adminPage.getByRole('button', { name: /^Approved/ }).click();
  await expect(adminPage.getByRole('row').filter({ hasText: applicantName })).toHaveCount(1, {
    timeout: 20_000,
  });

  await adminPage.getByRole('button', { name: /^Submitted/ }).click();
  await expect(adminPage.getByRole('row').filter({ hasText: applicantName })).toHaveCount(0, {
    timeout: 20_000,
  });

  await publicContext.close();
  await adminContext.close();
});

test('the honeypot rejects a submission that filled the hidden field', async () => {
  const convex = client();
  const token = await adminToken(convex);
  const honeypotEmail = `e2e-honeypot-${Date.now().toString(36)}@iih.ng`;

  // Posted straight at the intake endpoint rather than through the form. The
  // honeypot is a SERVER rule, and the field it guards is one a human never
  // reaches — so the realistic caller is something posting JSON, not something
  // typing. Driving a hidden controlled input through React to prove a server
  // check would be testing React.
  const response = await fetch(`${SITE_URL}/applications/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      programme_type: 'internship',
      full_name: 'E2E Honeypot',
      email: honeypotEmail,
      phone: '08000000000',
      location: 'Ilorin',
      emergency_contact_name: 'E2E Next of Kin',
      emergency_contact_phone: '08111111111',
      consent_logbook: true,
      consent_data_use: true,
      website: 'https://spam.example',
      passport_photo: {
        name: 'passport.png',
        type: 'image/png',
        size: 70,
        data_url: `data:image/png;base64,${PNG_BASE64}`,
      },
      siwes_letter: null,
    }),
  });

  // Success, deliberately. A honeypot that announces itself teaches the next
  // attempt to leave the field alone; the endpoint replies exactly as it would
  // to a real applicant and simply writes nothing.
  expect(response.ok).toBe(true);
  expect(((await response.json()) as { success: boolean }).success).toBe(true);

  const stored = (await convex.query(anyApi.applications.list, {
    token,
    limit: 100,
  })) as { email: string }[];
  expect(stored.some((a) => a.email === honeypotEmail), 'the honeypot let a row through').toBe(
    false,
  );
});
