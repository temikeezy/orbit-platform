import { anyApi } from 'convex/server';
import { test, expect, manifest, storageStateFor } from './support/fixtures';
import { adminToken, client } from './support/orbit';

/**
 * F5 — a stream as a member experiences it: join, post, like, comment, chat,
 * leave.
 *
 * The membership half is worth its own attention. Guards used `.first()` on the
 * memberships table while listings used `.collect().filter()`, and those two
 * disagree the moment a duplicate row exists — so "am I a member" and "who are
 * the members" could return different answers about the same person. Everything
 * now goes through convex/lib/membership.ts, and these specs drive both sides of
 * that answer through the UI in one pass.
 */

test.describe.configure({ mode: 'serial' });
test.use({ storageState: storageStateFor('moderator') });

test('a member joins, posts, likes, comments, then leaves', async ({ page, pageErrors }) => {
  const { scaffold, users } = manifest();
  const convex = client();
  const token = await adminToken(convex);
  const moderator = users.find((u) => u.role === 'moderator')!;

  await page.goto(`/streams/${scaffold.streamId}`);

  // --- join ---------------------------------------------------------------
  await page.getByRole('button', { name: 'Join Stream' }).click();
  await expect(page.getByRole('button', { name: 'Leave Stream' })).toBeVisible();

  // The server's answer, not the button's. These are the two reads that used to
  // be able to disagree.
  await expect
    .poll(async () => {
      const members = (await convex.query(anyApi.streams.members, {
        token,
        streamId: scaffold.streamId,
      })) as { id: string }[];
      return members.filter((m) => m.id === moderator.id).length;
    })
    // Exactly one: joining twice must collapse rather than accumulate, because a
    // duplicate row is what made the two membership reads disagree.
    .toBe(1);

  // --- post ---------------------------------------------------------------
  const body = `E2E post ${Date.now()}`;
  await page.getByPlaceholder('Share your thoughts… use @ to mention someone').fill(body);
  await page.getByRole('button', { name: 'Post', exact: true }).click();

  const post = page.getByText(body);
  await expect(post).toBeVisible();

  // --- like ---------------------------------------------------------------
  const article = page.locator('div').filter({ hasText: body }).last();
  await article.getByRole('button', { name: 'Like post' }).click();
  await expect(article.getByRole('button', { name: 'Unlike post' })).toBeVisible();

  // Idempotent, not a counter: clicking again unlikes rather than adding a
  // second like.
  await article.getByRole('button', { name: 'Unlike post' }).click();
  await expect(article.getByRole('button', { name: 'Like post' })).toBeVisible();

  // --- comment ------------------------------------------------------------
  await article.getByRole('button', { name: /Show comments/ }).click();
  const comment = `E2E comment ${Date.now()}`;
  await page.getByPlaceholder('Add a comment...').fill(comment);
  await page.keyboard.press('Enter');
  await expect(page.getByText(comment)).toBeVisible();

  await page.getByRole('button', { name: 'Close' }).click();

  // --- leave --------------------------------------------------------------
  await page.getByRole('button', { name: 'Leave Stream' }).click();
  await expect(page.getByRole('button', { name: 'Join Stream' })).toBeVisible();

  await expect
    .poll(async () => {
      const members = (await convex.query(anyApi.streams.members, {
        token,
        streamId: scaffold.streamId,
      })) as { id: string }[];
      return members.some((m) => m.id === moderator.id);
    })
    .toBe(false);

  pageErrors.assertClean();
});

test('a non-member sees the join prompt rather than the contents', async ({ page }) => {
  const { scaffold } = manifest();

  await page.goto(`/streams/${scaffold.streamId}`);

  // Left over from the previous spec, which leaves the stream.
  await expect(page.getByRole('button', { name: 'Join Stream' })).toBeVisible();
  // The composer belongs to members. A non-member seeing it would offer an
  // action the server is going to refuse.
  await expect(
    page.getByPlaceholder('Share your thoughts… use @ to mention someone'),
  ).toHaveCount(0);
});

test('a non-member is not offered the Chat tab, which used to crash the page', async ({
  page,
  pageErrors,
}) => {
  /**
   * Reported from production by a moderator: clicking Chat on a stream he had
   * not joined replaced the whole page with "Something went wrong".
   *
   * Stream chat is members-only and the SERVER enforces that — it used to be
   * readable by anyone who knew a stream id, and the check that closed it is
   * still right. What was wrong is that the tab was offered anyway, so the
   * refusal arrived as a thrown query and reached the error boundary.
   *
   * Runs after the spec above, which leaves the stream, so this page is a
   * genuine non-member view.
   */
  const { scaffold } = manifest();

  await page.goto(`/streams/${scaffold.streamId}`);
  await expect(page.getByRole('button', { name: 'Join Stream' })).toBeVisible();

  // Absent, not merely inert.
  await expect(page.getByRole('button', { name: 'Chat' })).toHaveCount(0);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);

  pageErrors.assertClean();
});
