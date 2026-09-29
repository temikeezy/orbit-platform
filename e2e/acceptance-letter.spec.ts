import { anyApi } from 'convex/server';
import { test, expect, storageStateFor } from './support/fixtures';
import { adminToken, client } from './support/orbit';
import path from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * F4 — the SIWES acceptance letter, end to end and on screen.
 *
 * The letter is the one artefact ORBIT produces that leaves the organisation
 * under its own name: a university's Industrial Liaison Unit files it, and a
 * wrong name or a missing department is discovered by them rather than by us.
 * Every other test of it is a unit test of `buildAcceptanceLetter`, which is
 * exactly the layer that cannot catch the two things that actually go wrong —
 * the application's fields arriving under the wrong keys, and the print view
 * rendering something other than what was built.
 *
 * So this drives the whole path: a SIWES application through the public form,
 * an approval through the admin screen, and the letter read back off the page.
 * The pronoun assertions are the sharpest part — they are only correct if
 * `gender` survived intake normalisation, the schema, `summaryShape`, the
 * snake_case adapter and `pronounsFor` without being dropped by any of them.
 */

test.describe.configure({ mode: 'serial' });

const runStamp = Date.now().toString(36);
const applicantEmail = `e2e-letter-${runStamp}@iih.ng`;
const applicantName = `E2E Letter ${runStamp}`;

/** A one-pixel PNG. The declared mime must match the bytes — intake checks. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A minimal but structurally real PDF, for the SIWES placement letter. */
const PDF_BASE64 = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
).toString('base64');

function fixture(name: string, base64: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-e2e-'));
  const file = path.join(dir, name);
  writeFileSync(file, Buffer.from(base64, 'base64'));
  return file;
}

/** Where the visual record of a run lands, so a human can open it. */
const SHOTS = path.join(process.cwd(), 'test-results', 'letters');

function shot(name: string): string {
  mkdirSync(SHOTS, { recursive: true });
  return path.join(SHOTS, name);
}

test('an approved SIWES applicant produces a letter that reads correctly', async ({ browser }, testInfo) => {
  /**
   * ~19s alone, and the default 45s is not enough once the suite runs it
   * alongside everything else.
   *
   * It drives the public intake form, an admin approval, the conversion sweep
   * and then renders and screenshots the letter — a long chain of round trips
   * against a shared dev deployment that has accumulated years of fixture data
   * (`streams.list` there already warns it is hitting its 500-row cap). Under
   * `fullyParallel` that stretches past the budget and fails with a bare
   * timeout naming no assertion, which reads like a broken letter rather than a
   * busy deployment.
   */
  test.setTimeout(150_000);

  const convex = client();
  const token = await adminToken(convex);

  // --- the public form, SIWES this time -----------------------------------
  // F2 deliberately applies as an internship to skip the SIWES-only fields.
  // Here those fields ARE the subject: the letter is built from the
  // institution, the course and the level, so an application without them
  // would prove nothing.
  const publicContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const publicPage = await publicContext.newPage();

  await publicPage.goto('/apply');

  await publicPage.getByLabel(/Programme type/).selectOption('siwes');
  await publicPage.getByLabel(/Full name/).fill(applicantName);
  await publicPage.getByLabel(/^Email/).fill(applicantEmail);
  await publicPage.getByLabel(/Phone number/).fill('08000000000');
  // The field this feature added. 'male' is what makes the letter say
  // "He will undergo his industrial training" rather than "He/She … his/her".
  await publicPage.getByLabel(/^Gender/).selectOption('male');
  await publicPage.getByLabel(/Current location/).fill('Ilorin, Kwara State');
  await publicPage.getByLabel(/Institution name/).fill('University of Ilorin');
  await publicPage.getByLabel(/Course or department/).fill('Computer Science');
  await publicPage.getByLabel(/Matriculation number/).fill(`19/30GC${runStamp}`);
  await publicPage.getByLabel(/Level or year/).fill('400 level');
  await publicPage.getByLabel(/SIWES start date/).fill('2026-09-01');
  await publicPage.getByLabel(/SIWES end date/).fill('2027-02-28');
  await publicPage.getByLabel(/Passport photograph/).setInputFiles(fixture('passport.png', PNG_BASE64));
  await publicPage
    .getByLabel(/SIWES form or placement letter/)
    .setInputFiles(fixture('placement.pdf', PDF_BASE64));
  await publicPage.getByLabel(/Emergency contact name/).fill('E2E Next of Kin');
  await publicPage.getByLabel(/Emergency contact phone/).fill('08111111111');
  await publicPage.locator('#consent-programme').check();
  await publicPage.locator('#consent-data-use').check();

  await publicPage.getByRole('button', { name: 'Submit application' }).click();
  await expect(publicPage.getByText('Application received')).toBeVisible({ timeout: 20_000 });

  // The gender reached the database as a normalised value, not as the raw
  // option text and not as undefined. Asserted here rather than inferred from
  // the letter, so a failure says which half of the path broke.
  const stored = (await convex.query(anyApi.applications.list, { token, limit: 50 })) as {
    email: string;
    gender?: string | null;
  }[];
  expect(stored.find((a) => a.email === applicantEmail)?.gender).toBe('male');

  // --- approve it through the screen --------------------------------------
  const adminContext = await browser.newContext({ storageState: storageStateFor('admin') });
  const adminPage = await adminContext.newPage();

  await adminPage.goto('/admin');
  await adminPage.getByRole('button', { name: 'SIWES' }).click();
  await adminPage.locator('[data-siwes-tab="applications"]').click();
  await expect(adminPage.getByText(applicantName)).toBeVisible({ timeout: 20_000 });

  adminPage.on('dialog', (d) => d.accept());
  const row = adminPage.getByRole('row').filter({ hasText: applicantName });
  await row.getByRole('button', { name: 'Approve' }).click();

  // --- the letter ----------------------------------------------------------
  // The approved row swaps its Approve button for this one. Waiting on the
  // button rather than on the database is deliberate: it is the same signal the
  // admin acts on.
  const letterButton = row.getByRole('button', { name: 'Acceptance letter' });
  await expect(letterButton).toBeVisible({ timeout: 20_000 });
  await letterButton.click();

  const letter = adminPage.locator('.orbit-letter-page').first();
  await expect(letter).toBeVisible({ timeout: 10_000 });

  // The address block, built from the institution the applicant typed.
  await expect(letter).toContainText('The Industrial Liaison Officer');
  await expect(letter).toContainText('Industrial Liaison Unit');
  await expect(letter).toContainText('University of Ilorin');

  // The RE: line, in capitals, from the name.
  await expect(letter).toContainText(
    `RE: ACCEPTANCE OF ${applicantName.toUpperCase()} FOR SIWES PLACEMENT`,
  );

  // The body. The level was typed as "400 level" and has to print as
  // "400-level"; the department came from the course field.
  await expect(letter).toContainText(
    `a 400-level student of the Department of Computer Science, University of Ilorin`,
  );

  // The template names the student again here — it does NOT say "accepted
  // him/her". This is the assertion that would have caught the original
  // implementation, which had a pronoun in this slot.
  await expect(letter).toContainText(`has accepted ${applicantName} for the Student Industrial`);

  // And the pronouns, resolved from the gender chosen on the public form.
  await expect(letter).toContainText('He will undergo his industrial training');
  await expect(letter).toContainText('supporting his professional development');
  await expect(letter).not.toContainText('He/She');
  await expect(letter).not.toContainText('his/her');

  // The sample's American spelling, which a British-spelling pass would break.
  await expect(letter).toContainText('at our organization');

  // --- the signatory, as CONFIGURED ----------------------------------------
  /**
   * Read, never typed.
   *
   * This used to fill the signatory fields itself, which masked the defect it
   * should have caught: the print toolbar let anyone who could print replace
   * the name on the document, defeating the super-admin control over who signs.
   * The fields are read-only now, so the letter shows whatever Settings holds —
   * and asserting on that is the only way this spec can notice if the stored
   * configuration stops reaching the page.
   */
  const signatory = adminPage.getByText(/Set in Admin → Settings/);
  await expect(signatory).toBeVisible({ timeout: 15_000 });
  await expect(adminPage.getByPlaceholder('Full name')).toHaveCount(0);

  // --- the visual record ---------------------------------------------------
  // Written to a stable path as well as attached: the attachment rides along
  // with the HTML report, and the file is what a human opens to check that a
  // document bound for a university actually looks like one.
  //
  // The scroll reset matters. An element screenshot scrolls its target into
  // view, and this view scrolls inside `.orbit-print-root` — so capturing the
  // letter first and the screen second yields a screen shot of a container
  // someone else already scrolled, with the date and address block above the
  // fold. Top first, then the letter.
  await adminPage.locator('.orbit-print-root').evaluate((el) => el.scrollTo(0, 0));
  await adminPage.screenshot({ path: shot('acceptance-letter-screen.png') });
  await letter.screenshot({ path: shot('acceptance-letter.png') });
  await testInfo.attach('acceptance-letter.png', {
    path: shot('acceptance-letter.png'),
    contentType: 'image/png',
  });

  // --- the batch run -------------------------------------------------------
  // Closed and reopened through the batch button, which reads every approved
  // applicant from the server rather than filtering the loaded table. The
  // applicant just approved has to appear in it.
  await adminPage.locator('.orbit-print-root').getByRole('button', { name: 'Close' }).click();
  await expect(adminPage.locator('.orbit-letter-page')).toHaveCount(0);

  await adminPage.getByRole('button', { name: 'Acceptance letters' }).click();
  await expect(adminPage.locator('.orbit-letter-page').first()).toBeVisible({ timeout: 20_000 });

  const batchPages = adminPage.locator('.orbit-letter-page');
  expect(await batchPages.count()).toBeGreaterThan(0);
  await expect(
    adminPage.locator('.orbit-letter-page').filter({ hasText: applicantName }),
  ).toHaveCount(1);

  await adminPage.locator('.orbit-print-root').evaluate((el) => el.scrollTo(0, 0));
  await adminPage.screenshot({ path: shot('acceptance-letters-batch.png') });
  await testInfo.attach('acceptance-letters-batch.png', {
    path: shot('acceptance-letters-batch.png'),
    contentType: 'image/png',
  });

  await publicContext.close();
  await adminContext.close();
});

/**
 * An approved applicant who is not on SIWES gets no SIWES letter.
 *
 * The letter is titled "FOR SIWES PLACEMENT" and addressed to a university's
 * Industrial Liaison Unit. Volunteers, NYSC members and interns are approved
 * through the same queue and have no such office — the first version of this
 * feature offered every approved row a letter, which would have posted a SIWES
 * acceptance for a volunteer to a university that had never heard of them.
 *
 * Asserted through the screen because the absence of a control is the whole
 * behaviour: there is nothing to click, so there is nothing else to observe.
 */
test('an approved volunteer is offered no acceptance letter', async ({ browser }) => {
  const convex = client();
  const token = await adminToken(convex);
  const volunteerEmail = `e2e-volunteer-${runStamp}@iih.ng`;
  const volunteerName = `E2E Volunteer ${runStamp}`;

  const publicContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const publicPage = await publicContext.newPage();

  await publicPage.goto('/apply');
  await publicPage.getByLabel(/Programme type/).selectOption('volunteer');
  await publicPage.getByLabel(/Full name/).fill(volunteerName);
  await publicPage.getByLabel(/^Email/).fill(volunteerEmail);
  await publicPage.getByLabel(/Phone number/).fill('08000000000');
  await publicPage.getByLabel(/Current location/).fill('Ilorin, Kwara State');
  await publicPage.getByLabel(/Passport photograph/).setInputFiles(fixture('passport.png', PNG_BASE64));
  await publicPage.getByLabel(/Emergency contact name/).fill('E2E Next of Kin');
  await publicPage.getByLabel(/Emergency contact phone/).fill('08111111111');
  await publicPage.locator('#consent-programme').check();
  await publicPage.locator('#consent-data-use').check();
  await publicPage.getByRole('button', { name: 'Submit application' }).click();
  await expect(publicPage.getByText('Application received')).toBeVisible({ timeout: 20_000 });

  const adminContext = await browser.newContext({ storageState: storageStateFor('admin') });
  const adminPage = await adminContext.newPage();
  await adminPage.goto('/admin');
  // The GENERAL queue: a volunteer is not a SIWES candidate and does not
  // appear in the SIWES section at all.
  await adminPage.getByRole('button', { name: 'Applications', exact: true }).first().click();
  await expect(adminPage.getByText(volunteerName)).toBeVisible({ timeout: 20_000 });

  adminPage.on('dialog', (d) => d.accept());
  const row = adminPage.getByRole('row').filter({ hasText: volunteerName });
  await row.getByRole('button', { name: 'Approve' }).click();

  // Approved, and the row settles to plain text with no letter offered.
  await expect(row.getByText('Approved', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(row.getByRole('button', { name: 'Acceptance letter' })).toHaveCount(0);

  // Nor does the batch run sweep them up.
  await adminPage.getByRole('button', { name: 'Acceptance letters' }).click();
  await expect(adminPage.locator('.orbit-letter-page').first()).toBeVisible({ timeout: 20_000 });
  await expect(
    adminPage.locator('.orbit-letter-page').filter({ hasText: volunteerName }),
  ).toHaveCount(0);

  // The token proves the row really is approved, so the absence above is the
  // rule doing its job rather than the approval having failed.
  const rows = (await convex.query(anyApi.applications.list, { token, limit: 100 })) as {
    email: string;
    status: string;
  }[];
  expect(rows.find((a) => a.email === volunteerEmail)?.status).toBe('approved');

  await publicContext.close();
  await adminContext.close();
});
