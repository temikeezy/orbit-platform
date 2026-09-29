import { anyApi } from 'convex/server';
import { test, expect, manifest, storageStateFor } from './support/fixtures';
import { client } from './support/orbit';

/**
 * F3 and F4 — the SIWES logbook and attendance.
 *
 * These replace 45 mocked assertions that only ever proved the client sent the
 * arguments the mock expected. What they could not check is the part that
 * actually broke: the RPC dispatcher in `src/lib/api/siwesRpc.ts` routes about
 * thirty Postgres RPC names onto Convex functions, and a wrong branch there
 * sends a real, well-formed call to the wrong mutation.
 *
 * That is not hypothetical. Attendance verification routed on `a.id`, which no
 * caller sends — so every supervisor action fell through to the intern's own
 * check-in path and wrote a bogus record against the SUPERVISOR's profile, with
 * a success toast. Mocked tests passed throughout, because the mock was asked
 * about the function the test already believed was being called.
 */

test.describe.configure({ mode: 'serial' });

const today = new Date().toISOString().slice(0, 10);

/**
 * `logbook.listAttendance` returns the profile's whole history — it takes no
 * date range, unlike listDailyLogs. Filtering by date here rather than assuming
 * position keeps these assertions honest on a profile that already has records.
 */
interface Attendance {
  attendanceDate: string;
  status: string;
  checkInTime?: number;
  checkOutTime?: number;
  activitySummary?: string;
}

test('an intern drafts a log, submits it, and a supervisor approves', async ({ browser }) => {
  const { userId, users } = manifest();
  const convex = client();
  const intern = users.find((u) => u.role === 'intern')!;
  const moderator = users.find((u) => u.role === 'moderator')!;

  const internContext = await browser.newContext({ storageState: storageStateFor('intern') });
  const internPage = await internContext.newPage();

  // Submitting asks for confirmation, and an unhandled dialog blocks every
  // subsequent action on the page rather than failing.
  internPage.on('dialog', (dialog) => dialog.accept());

  await internPage.goto('/logbook');

  const work = `E2E work done ${Date.now()}`;
  await internPage.getByPlaceholder("Brief title for today's work").fill('E2E daily log');
  await internPage.getByPlaceholder('Describe what you worked on today...').fill(work);

  // --- draft --------------------------------------------------------------
  await internPage.getByRole('button', { name: 'Save draft' }).click();

  await expect
    .poll(
      async () => {
        const logs = (await convex.query(anyApi.logbook.listDailyLogs, {
          token: intern.token,
          internUserId: userId,
          from: today,
          to: today,
        })) as { status: string; workDone: string }[];
        return logs.find((l) => l.workDone === work)?.status;
      },
      { message: 'the draft never reached the database', timeout: 20_000 },
    )
    // A draft is a draft. `status` used to be a value the CLIENT wrote, so an
    // intern could save their own log as 'approved'; it is a boolean the server
    // acts on now.
    .toBe('draft');

  // --- submit -------------------------------------------------------------
  await internPage.getByRole('button', { name: 'Submit for review' }).click();

  await expect
    .poll(async () => {
      const logs = (await convex.query(anyApi.logbook.listDailyLogs, {
        token: intern.token,
        internUserId: userId,
        from: today,
        to: today,
      })) as { status: string; workDone: string }[];
      return logs.find((l) => l.workDone === work)?.status;
    }, { timeout: 20_000 })
    .toBe('submitted');

  // --- the supervisor's queue ---------------------------------------------
  const modContext = await browser.newContext({ storageState: storageStateFor('moderator') });
  const modPage = await modContext.newPage();

  await modPage.goto('/review');

  // The moderator is this intern's assigned IIH supervisor, which is what puts
  // the log in their queue at all — `canReviewProfile` is assignment-based, not
  // role-based.
  // Cards, not table rows.
  const card = modPage
    .locator('div')
    .filter({ hasText: intern.fullName })
    .filter({ has: modPage.getByRole('button', { name: 'Review' }) })
    .last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole('button', { name: 'Review' }).click();

  await modPage.getByRole('button', { name: 'Approve' }).click();
  await modPage.getByPlaceholder('Add a note for the intern...').fill('Good detail.');
  // The modal's confirm button is labelled with the action it will take.
  await modPage.getByRole('button', { name: 'Approve' }).last().click();

  await expect
    .poll(
      async () => {
        const logs = (await convex.query(anyApi.logbook.listDailyLogs, {
          token: moderator.token,
          internUserId: userId,
          from: today,
          to: today,
        })) as { status: string; workDone: string }[];
        return logs.find((l) => l.workDone === work)?.status;
      },
      { message: 'the approval never reached the log', timeout: 20_000 },
    )
    .toBe('approved');

  await internContext.close();
  await modContext.close();
});

test('an intern checks in and out, and the record is their own', async ({ browser }) => {
  const { userId, users } = manifest();
  const convex = client();
  const intern = users.find((u) => u.role === 'intern')!;

  const internContext = await browser.newContext({ storageState: storageStateFor('intern') });
  const page = await internContext.newPage();
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto('/logbook');
  await page.getByRole('button', { name: 'Attendance' }).click();

  await page.getByRole('button', { name: 'Check in' }).click();
  await expect(page.getByText(/Checked in at/)).toBeVisible({ timeout: 20_000 });

  const summary = `E2E attendance ${Date.now()}`;
  await page.getByPlaceholder('Brief summary of what you did today...').fill(summary);
  await page.getByRole('button', { name: 'Check out' }).click();

  await expect
    .poll(
      async () => {
        const rows = (await convex.query(anyApi.logbook.listAttendance, {
          token: intern.token,
          internUserId: userId,
        })) as Attendance[];
        const mine = rows.find((r) => r.attendanceDate === today);
        return Boolean(mine?.checkInTime && mine?.checkOutTime);
      },
      { message: 'check-in and check-out did not both land', timeout: 20_000 },
    )
    .toBe(true);

  const rows = (await convex.query(anyApi.logbook.listAttendance, {
    token: intern.token,
    internUserId: userId,
  })) as Attendance[];
  const forToday = rows.filter((r) => r.attendanceDate === today);

  expect(forToday[0].activitySummary).toBe(summary);

  // Exactly one record for the day. Check-out is an update to the morning's row,
  // not a second row — the two used to go through one RPC distinguished by a
  // status string the client chose.
  expect(forToday).toHaveLength(1);

  await internContext.close();
});

test("a supervisor's verification writes to the INTERN's record, not their own", async () => {
  const { userId, users } = manifest();
  const convex = client();
  const moderator = users.find((u) => u.role === 'moderator')!;

  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  await convex.mutation(anyApi.logbook.verifyAttendance, {
    token: moderator.token,
    internUserId: userId,
    attendanceDate: yesterday,
    status: 'excused',
  });

  const rows = (await convex.query(anyApi.logbook.listAttendance, {
    token: moderator.token,
    internUserId: userId,
  })) as Attendance[];
  const forDay = rows.filter((r) => r.attendanceDate === yesterday);

  // Keyed on (profile, date) and upserted. The original took an `attendanceId`
  // no caller had, so the client fell through to the intern check-in path and
  // recorded attendance against the supervisor. The row has to exist HERE, on
  // the intern's profile, with the status the supervisor chose.
  expect(forDay).toHaveLength(1);
  expect(forDay[0].status).toBe('excused');

  // Idempotent: verifying the same day twice corrects the row rather than
  // adding a second one.
  await convex.mutation(anyApi.logbook.verifyAttendance, {
    token: moderator.token,
    internUserId: userId,
    attendanceDate: yesterday,
    status: 'absent',
  });

  const after = (await convex.query(anyApi.logbook.listAttendance, {
    token: moderator.token,
    internUserId: userId,
  })) as Attendance[];
  const afterDay = after.filter((r) => r.attendanceDate === yesterday);
  expect(afterDay).toHaveLength(1);
  expect(afterDay[0].status).toBe('absent');
});
