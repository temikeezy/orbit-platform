import { anyApi } from 'convex/server';
import { test, expect, manifest, storageStateFor } from './support/fixtures';

test.use({ storageState: storageStateFor('intern') });
import { client, CONVEX_URL, DEV_DEPLOYMENT, SITE_URL, deploymentOf } from './support/orbit';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * Uploads.
 *
 * No test anywhere sent a file before this one. That matters more here than for
 * most features, because Convex storage has NO ownership model:
 * `ctx.storage.delete(id)` succeeds for anyone holding an id, and ids are
 * plainly visible inside every profilePhotoUrl the member directory returns.
 *
 * The `uploads` claim table in convex/files.ts is the whole defence. These specs
 * drive it directly, because the interesting cases — claiming someone else's
 * object, re-using a claim — are things a browser UI will not do for you.
 */

test.describe.configure({ mode: 'serial' });

/** A one-pixel PNG, 70 bytes. Small enough to be free, real enough to validate. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const pngBytes = () => Buffer.from(PNG_BASE64, 'base64');

function pngFixture(name = 'photo.png'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-upload-'));
  const file = path.join(dir, name);
  writeFileSync(file, pngBytes());
  return file;
}

/** Uploads bytes to storage and returns the raw storage id, unattached. */
async function putObject(token: string): Promise<string> {
  const convex = client();
  const { uploadUrl } = (await convex.mutation(anyApi.files.generateUploadUrl, { token })) as {
    uploadUrl: string;
  };

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: pngBytes(),
  });

  return ((await response.json()) as { storageId: string }).storageId;
}

test('a profile photo uploaded through the UI is served back', async ({ page }) => {
  const { users } = manifest();
  const intern = users.find((u) => u.role === 'intern')!;
  const convex = client();

  await page.goto('/profile/edit');

  // The second file input is the avatar; the first is the cover photo. Neither
  // uploads on selection — both are staged and sent when the page is saved.
  await page.locator('input[type="file"]').nth(1).setInputFiles(pngFixture());
  await page.getByRole('button', { name: 'Save Changes' }).click();

  await expect
    .poll(
      async () => {
        const me = (await convex.query(anyApi.users.me, { token: intern.token })) as {
          profilePhotoUrl?: string;
        };
        return Boolean(me.profilePhotoUrl);
      },
      { message: 'the profile photo never attached', timeout: 30_000 },
    )
    .toBe(true);

  const me = (await convex.query(anyApi.users.me, { token: intern.token })) as {
    profilePhotoUrl?: string;
  };

  // Served, not merely recorded. A url on the record that 404s is the same
  // outcome as no photo, and only a real fetch tells them apart.
  const fetched = await fetch(me.profilePhotoUrl!);
  expect(fetched.ok).toBe(true);
  expect(fetched.headers.get('content-type')).toMatch(/image/);
});

test('an object claimed by one user cannot be attached by another', async () => {
  const { users } = manifest();
  const intern = users.find((u) => u.role === 'intern')!;
  const moderator = users.find((u) => u.role === 'moderator')!;
  const convex = client();

  const storageId = await putObject(intern.token);

  // The intern claims it by attaching it to their own record.
  const claimed = await convex.mutation(anyApi.files.setProfilePhoto, {
    token: intern.token,
    storageId,
    kind: 'profile' as const,
  });
  expect(claimed.success).toBe(true);

  // The moderator now knows the id — it is inside the intern's photo URL, which
  // the member directory hands to every authenticated user. Attaching it must
  // fail, and must NOT delete the object out from under its owner, which is
  // exactly what the delete-on-reject path did before the claim table existed.
  const stolen = await convex.mutation(anyApi.files.setProfilePhoto, {
    token: moderator.token,
    storageId,
    kind: 'profile' as const,
  });
  expect(stolen.success).toBe(false);

  const owner = (await convex.query(anyApi.users.me, { token: intern.token })) as {
    profilePhotoUrl?: string;
  };
  expect(owner.profilePhotoUrl).toBeTruthy();
  expect((await fetch(owner.profilePhotoUrl!)).ok).toBe(true);
});

test('a failed re-attach of your own object does not destroy it', async () => {
  const { scaffold, users } = manifest();
  const intern = users.find((u) => u.role === 'intern')!;
  const convex = client();

  // A PDF: acceptable as a submission, never as a profile photo.
  const { uploadUrl } = (await convex.mutation(anyApi.files.generateUploadUrl, {
    token: intern.token,
  })) as { uploadUrl: string };
  const put = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: Buffer.from('%PDF-1.4\n% E2E fixture\n'),
  });
  const { storageId } = (await put.json()) as { storageId: string };

  await convex.mutation(anyApi.tasks.acceptTask, {
    token: intern.token,
    taskId: scaffold.fileTaskId,
  });

  const attached = await convex.mutation(anyApi.files.attachSubmissionFile, {
    token: intern.token,
    taskId: scaffold.fileTaskId,
    storageId,
  });
  expect(attached.success).toBe(true);

  // Now offer the SAME object to a surface that will refuse it. The refusal is
  // expected; what matters is that the reject path does not delete an object
  // this call did not claim. Deleting it would take out the submission file that
  // is still pointing at it — destroying evidence of someone's work because they
  // picked the wrong file on a different screen.
  const refused = await convex.mutation(anyApi.files.setProfilePhoto, {
    token: intern.token,
    storageId,
    kind: 'profile' as const,
  });
  expect(refused.success).toBe(false);

  const url = `${SITE_URL}/submissions/file?submissionId=${attached.id}`;
  const still = await fetch(url, { headers: { Authorization: `Bearer ${intern.token}` } });
  expect(still.ok, 'the failed re-attach deleted the submission file').toBe(true);
});

test('an object whose real bytes are not an image is refused', async () => {
  const { users } = manifest();
  const intern = users.find((u) => u.role === 'intern')!;
  const convex = client();

  const { uploadUrl } = (await convex.mutation(anyApi.files.generateUploadUrl, {
    token: intern.token,
  })) as { uploadUrl: string };

  // Declared as a PNG, actually a script. The browser-side accept="image/*" is
  // a courtesy to the user, not a control — the server reads the STORED
  // object's metadata rather than trusting what the upload claimed.
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-shellscript' },
    body: Buffer.from('#!/bin/sh\necho not a picture\n'),
  });
  const { storageId } = (await response.json()) as { storageId: string };

  const result = await convex.mutation(anyApi.files.setProfilePhoto, {
    token: intern.token,
    storageId,
    kind: 'profile' as const,
  });
  expect(result.success).toBe(false);
});

test('a submission file is readable by its author and by a reviewer, not by a stranger', async () => {
  const { scaffold, users } = manifest();
  const convex = client();
  const intern = users.find((u) => u.role === 'intern')!;
  const moderator = users.find((u) => u.role === 'moderator')!;
  const admin = users.find((u) => u.role === 'admin')!;

  // The scaffold's file task, not a fresh one. Tasks have no delete, so a spec
  // that creates one leaves a row behind on every CI run forever.
  await convex.mutation(anyApi.tasks.acceptTask, {
    token: intern.token,
    taskId: scaffold.fileTaskId,
  });

  const storageId = await putObject(intern.token);

  // Through files.attachSubmissionFile, not tasks.submitWork: a file submission
  // has to claim the object as well as record it, and that is the mutation that
  // does both under one authorization check.
  const submission = await convex.mutation(anyApi.files.attachSubmissionFile, {
    token: intern.token,
    taskId: scaffold.fileTaskId,
    storageId,
  });
  expect(submission.success).toBe(true);

  const url = `${SITE_URL}/submissions/file?submissionId=${submission.id}`;

  // The author.
  expect((await fetch(url, { headers: { Authorization: `Bearer ${intern.token}` } })).ok).toBe(
    true,
  );

  // Someone who could review it. An admin reviews platform-wide, so their
  // authority over this stream is not in question.
  expect((await fetch(url, { headers: { Authorization: `Bearer ${admin.token}` } })).ok).toBe(true);

  /**
   * A moderator who does not moderate THIS submission's stream.
   *
   * This assertion used to read the other way, and that is what made the route
   * exploitable: it accepted the bare `moderator` role, so any moderator could
   * pull any submission's file by id. The role is granted broadly — a track
   * lead receives it from `tracks.setLead` while holding stream-moderator rows
   * for their own track only — so holding it is not authority over a stream.
   * `reviewSubmission` has always checked `canModerateStream`; this read did
   * not, and the file IS the work being reviewed.
   *
   * The fixture moderator is deliberately on no stream at all (they are the
   * intern's SIWES supervisor, a different axis of authority). Adding them to
   * the scaffold stream to demonstrate the positive case would flip the smoke
   * matrix's `task-edit` and `stream-add-task` denials for that same stream,
   * so the positive path is left to the `canModerateStream` branch the write
   * side already exercises.
   */
  expect((await fetch(url, { headers: { Authorization: `Bearer ${moderator.token}` } })).ok).toBe(
    false,
  );

  // Nobody. The route re-checks the session rather than treating the
  // submission id — which is guessable in a way file bytes are not — as the
  // capability.
  expect((await fetch(url)).ok).toBe(false);
});

test('the upload endpoint refuses an unauthenticated caller', async () => {
  const convex = client();
  // Storage is not free, and generateUploadUrl is rate-limited per user — which
  // means nothing at all if it can be called without being anyone.
  await expect(
    convex.mutation(anyApi.files.generateUploadUrl, { token: 'not-a-real-token' }),
  ).rejects.toThrow();

  expect(deploymentOf(CONVEX_URL)).toBe(DEV_DEPLOYMENT);
});
