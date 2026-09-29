import { anyApi } from 'convex/server';
import { test, expect, manifest, storageStateFor } from './support/fixtures';
import { client } from './support/orbit';

/**
 * F6 — messaging: compose to several recipients, notify, read, reply, delete.
 *
 * Multi-recipient is the part worth driving through the UI. A message to three
 * people is three rows and three notifications, and the compose form builds that
 * list client-side — so "sent" appearing on screen says nothing about how many
 * of them actually received it.
 *
 * The send limit is 60 per 5 minutes; this spec sends four.
 */

test.describe.configure({ mode: 'serial' });

test('an admin messages two people, who each receive and can reply', async ({ browser }) => {
  const { users } = manifest();
  const convex = client();

  const intern = users.find((u) => u.role === 'intern')!;
  const moderator = users.find((u) => u.role === 'moderator')!;

  const body = `E2E message ${Date.now()}`;

  const adminContext = await browser.newContext({ storageState: storageStateFor('admin') });
  const adminPage = await adminContext.newPage();

  await adminPage.goto('/messages');
  await adminPage.getByRole('button', { name: 'Compose' }).click();

  for (const recipient of [intern, moderator]) {
    await adminPage.getByPlaceholder('Search for users by name or email...').fill(recipient.fullName);
    await adminPage.getByText(recipient.email).click();
  }

  await adminPage.getByPlaceholder('Type your message here...').fill(body);
  // The button names its own recipient count, which is the assertion that the
  // form built the list it is about to send to.
  await adminPage.getByRole('button', { name: 'Send to 2 recipients' }).click();

  // --- both really received it -------------------------------------------
  for (const recipient of [intern, moderator]) {
    await expect
      .poll(
        async () => {
          const inbox = (await convex.query(anyApi.messages.inbox, {
            token: recipient.token,
            limit: 20,
          })) as { content: string }[];
          return inbox.some((m) => m.content === body);
        },
        { message: `${recipient.role} never received the message`, timeout: 20_000 },
      )
      .toBe(true);
  }

  // --- the intern reads and replies ---------------------------------------
  const internContext = await browser.newContext({ storageState: storageStateFor('intern') });
  const internPage = await internContext.newPage();

  await internPage.goto('/messages');
  await internPage.getByText(body).first().click();

  const reply = `E2E reply ${Date.now()}`;
  await internPage.getByPlaceholder('Type your reply...').fill(reply);
  await internPage.getByRole('button', { name: /send/i }).first().click();

  await expect
    .poll(
      async () => {
        const inbox = (await convex.query(anyApi.messages.inbox, {
          token: users.find((u) => u.role === 'admin')!.token,
          limit: 20,
        })) as { content: string }[];
        return inbox.some((m) => m.content === reply);
      },
      { message: 'the reply never reached the sender', timeout: 20_000 },
    )
    .toBe(true);

  await adminContext.close();
  await internContext.close();
});
