import { mutation, internalMutation } from './_generated/server';
import { v } from 'convex/values';
import { Id } from './_generated/dataModel';
import { MutationCtx } from './_generated/server';
import { requireUser, requireAdmin, hasRole } from './lib/auth';
import { activeMembership } from './lib/membership';
import { isPublished } from './lib/taskApproval';
import { checkRateLimit, LIMITS } from './lib/rateLimit';
import { validate, optionalText, FIELD } from './lib/input';

/**
 * File uploads, replacing `src/lib/utils/storage.ts` and the four ad-hoc
 * `supabase.storage` calls scattered through the API layer.
 *
 * THREE OF THE BUCKETS DID NOT EXIST. `task-submissions` (tasks.ts:261),
 * `profile-photos` and `cover-photos` (EditProfilePage.tsx:130,137) are named
 * nowhere in the Supabase project, so every one of those uploads has been
 * failing in production. The profile photo is the worst of it: `users.ts:275`
 * uploads to `orbit_profile_photos`, which exists and works, while the edit page
 * writes to `profile-photos`, which does not — two paths to the same feature,
 * one silently broken. These are fixed here, not reproduced.
 *
 * The flow is Convex's: `generateUploadUrl` hands back a short-lived URL, the
 * browser PUTs the bytes straight to it, then an attach mutation validates the
 * result and records it. Bytes never pass through a mutation, so a 5 MB image
 * does not have to fit in a function argument.
 *
 * The upload URL itself accepts ANYTHING — Convex does not police content type
 * or size at that step. So validation lives in the attach mutations, which read
 * the stored object's real metadata and delete it if it is not what was claimed.
 * Checking the File in the browser is a courtesy to the user, not a control.
 */

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Submissions may be documents, images or SPREADSHEETS.
 *
 * The spreadsheet formats were missing, and the bank asks for them outright:
 * "Design a simple tracker" is a delivery-grade task whose whole test is
 * whether the validation and formulas compute, and the costed-budget tasks
 * expect line items with dated prices. An intern would have produced exactly
 * what was asked for and been told the file type was not allowed.
 *
 * CSV is included as `text/csv` AND `application/vnd.ms-excel`, because that is
 * what browsers on Windows commonly report for a .csv — refusing it on a
 * technicality would fail the same person twice.
 */
const SUBMISSION_TYPES = [
  ...IMAGE_TYPES,
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Spreadsheets: xlsx, legacy xls (and the type Windows reports for csv), ods.
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.text',
];
const MAX_SUBMISSION_BYTES = 15 * 1024 * 1024;

/**
 * Issues an upload URL. Authenticated and rate limited.
 *
 * Without the session check this is anonymous unbounded storage — the one
 * Convex primitive that costs money per byte and is never garbage collected.
 */
export const generateUploadUrl = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);

    const limit = await checkRateLimit(
      ctx, String(user._id), 'file_upload',
      LIMITS.fileUpload.max, LIMITS.fileUpload.windowMs,
    );
    if (!limit.allowed) {
      return { success: false as const, error: 'Too many uploads. Please wait a moment.' };
    }

    return { success: true as const, uploadUrl: await ctx.storage.generateUploadUrl() };
  },
});

/**
 * Establishes that this caller owns the object, claiming it if unclaimed.
 *
 * THE REASON THIS EXISTS: Convex storage has no ownership model.
 * `ctx.storage.delete(id)` succeeds for anyone holding an id, and ids are
 * plainly visible inside every `profilePhotoUrl` the member directory returns.
 * Without this, the delete-on-reject below was a "delete any file on the
 * platform" primitive available to every session — read someone's avatar URL,
 * pass its id to an attach mutation you know will be refused, and their photo is
 * gone with the row still pointing at it. Nothing stopped attaching another
 * member's object to your own record either, so their next edit would delete a
 * file yours depended on.
 *
 * First claim wins. An id is only visible after it has been attached, so the
 * window in which an unclaimed id is known to anyone but its uploader is the
 * milliseconds between the browser's PUT and its attach call.
 */
async function claimUpload(
  ctx: MutationCtx,
  userId: Id<'users'>,
  storageId: Id<'_storage'>,
): Promise<{ ok: true; fresh: boolean } | { ok: false; error: string }> {
  const existing = await ctx.db
    .query('uploads')
    .withIndex('by_storage', (q) => q.eq('storageId', storageId))
    .first();

  if (existing) {
    if (existing.userId !== userId) {
      // Deliberately NOT deleted, and deliberately the same message a missing
      // object gets: this is somebody else's file.
      return { ok: false, error: 'Upload not found. Please try again.' };
    }
    return { ok: true, fresh: false };
  }

  await ctx.db.insert('uploads', {
    storageId,
    userId,
    attached: false,
    createdAt: Date.now(),
  });

  return { ok: true, fresh: true };
}

/** Marks a claim attached, so the reaper leaves it alone. */
async function markAttached(ctx: MutationCtx, storageId: Id<'_storage'>) {
  const claim = await ctx.db
    .query('uploads')
    .withIndex('by_storage', (q) => q.eq('storageId', storageId))
    .first();
  if (claim && !claim.attached) await ctx.db.patch(claim._id, { attached: true });
}

/** Drops a claim and its object. Only ever called on a claim this call created. */
async function rejectUpload(ctx: MutationCtx, storageId: Id<'_storage'>) {
  const claim = await ctx.db
    .query('uploads')
    .withIndex('by_storage', (q) => q.eq('storageId', storageId))
    .first();
  if (claim) await ctx.db.delete(claim._id);
  await discard(ctx, storageId);
}

/**
 * Validates a just-uploaded object against what the caller may store.
 *
 * Ownership FIRST, then type and size. The object is deleted only when this
 * call is the one that claimed it — a caller re-attaching something they already
 * own must not have it destroyed because the second attach was to a stricter
 * surface.
 */
async function acceptUpload(
  ctx: MutationCtx,
  userId: Id<'users'>,
  storageId: Id<'_storage'>,
  allowed: string[],
  maxBytes: number,
  label: string,
): Promise<{ ok: true; contentType: string } | { ok: false; error: string }> {
  const claim = await claimUpload(ctx, userId, storageId);
  if (!claim.ok) return { ok: false, error: claim.error };

  const meta = await ctx.db.system.get(storageId);

  if (!meta) {
    if (claim.fresh) await rejectUpload(ctx, storageId);
    return { ok: false, error: 'Upload not found. Please try again.' };
  }

  const contentType = meta.contentType ?? '';

  if (!allowed.includes(contentType)) {
    if (claim.fresh) await rejectUpload(ctx, storageId);
    return { ok: false, error: `${label} must be one of: ${allowed.join(', ')}` };
  }
  if (meta.size > maxBytes) {
    if (claim.fresh) await rejectUpload(ctx, storageId);
    return {
      ok: false,
      error: `${label} must be ${Math.floor(maxBytes / (1024 * 1024))} MB or smaller.`,
    };
  }

  await markAttached(ctx, storageId);
  return { ok: true, contentType };
}

/** Removes a superseded object. Never throws — the new photo is already live. */
async function discard(ctx: MutationCtx, storageId?: Id<'_storage'>) {
  if (!storageId) return;
  try {
    await ctx.storage.delete(storageId);
  } catch {
    // Already gone, or never existed. Not worth failing a profile update over.
  }
}

/**
 * Deletes the object a record no longer points at.
 *
 * `previous === next` is the case that matters: a double-submitted edit form
 * patches the row to X and then deletes X, leaving a live record naming a
 * deleted object — and `discard` swallows the error, so it happens silently.
 */
async function discardSuperseded(
  ctx: MutationCtx,
  previous: Id<'_storage'> | undefined,
  next: Id<'_storage'>,
) {
  if (!previous || previous === next) return;

  const claim = await ctx.db
    .query('uploads')
    .withIndex('by_storage', (q) => q.eq('storageId', previous))
    .first();
  if (claim) await ctx.db.delete(claim._id);

  await discard(ctx, previous);
}

// ------------------------------------------------------------------ profile

/**
 * Profile and cover photos.
 *
 * One mutation for both, because the edit page sets them together and the two
 * had drifted into separate, differently-broken implementations.
 *
 * The URL is stored alongside the id. A Convex storage URL is unguessable and
 * permanent, which is the right trade HERE — these were public buckets, every
 * member sees every avatar in the directory, and resolving an id per user on
 * every list query would put a storage lookup in the hot path. Applicant
 * documents are the opposite case and go through an authenticated route instead.
 */
export const setProfilePhoto = mutation({
  args: {
    token: v.string(),
    storageId: v.id('_storage'),
    kind: v.union(v.literal('profile'), v.literal('cover')),
  },
  handler: async (ctx, { token, storageId, kind }) => {
    const user = await requireUser(ctx, token);

    const accepted = await acceptUpload(
      ctx, user._id, storageId, IMAGE_TYPES, MAX_IMAGE_BYTES,
      kind === 'profile' ? 'Profile photo' : 'Cover photo',
    );
    if (!accepted.ok) return { success: false as const, error: accepted.error };

    const url = await ctx.storage.getUrl(storageId);
    if (!url) return { success: false as const, error: 'Upload could not be read back.' };

    const previous = kind === 'profile' ? user.profilePhotoId : user.coverPhotoId;

    await ctx.db.patch(user._id, {
      ...(kind === 'profile'
        ? { profilePhotoId: storageId, profilePhotoUrl: url }
        : { coverPhotoId: storageId, coverPhotoUrl: url }),
      updatedAt: Date.now(),
    });

    // The old object goes AFTER the new one is recorded, so a failure here
    // leaves a stale file rather than a profile with no photo.
    await discardSuperseded(ctx, previous, storageId);

    return { success: true as const, url };
  },
});

export const removeProfilePhoto = mutation({
  args: { token: v.string(), kind: v.union(v.literal('profile'), v.literal('cover')) },
  handler: async (ctx, { token, kind }) => {
    const user = await requireUser(ctx, token);
    const previous = kind === 'profile' ? user.profilePhotoId : user.coverPhotoId;

    await ctx.db.patch(user._id, {
      ...(kind === 'profile'
        ? { profilePhotoId: undefined, profilePhotoUrl: undefined }
        : { coverPhotoId: undefined, coverPhotoUrl: undefined }),
      updatedAt: Date.now(),
    });

    if (previous) {
      const claim = await ctx.db
        .query('uploads')
        .withIndex('by_storage', (q) => q.eq('storageId', previous))
        .first();
      if (claim) await ctx.db.delete(claim._id);
      await discard(ctx, previous);
    }

    return { success: true as const };
  },
});

// ------------------------------------------------------------------- streams

export const setStreamPhoto = mutation({
  args: {
    token: v.string(),
    streamId: v.id('streams'),
    storageId: v.id('_storage'),
    kind: v.union(v.literal('cover'), v.literal('display')),
  },
  handler: async (ctx, { token, streamId, storageId, kind }) => {
    const user = await requireUser(ctx, token);

    const stream = await ctx.db.get(streamId);
    if (!stream) return { success: false as const, error: 'Stream not found' };

    // Same gate as streams.update: admin, or a moderator of THIS stream.
    // Nothing touches storage before this passes — deleting a caller-supplied id
    // on the refusal path is how "you may not do this" became "and your file is
    // gone", for any file whose id the caller could read.
    if (!hasRole(user, 'admin', 'super_admin')) {
      const moderator = await ctx.db
        .query('streamModerators')
        .withIndex('by_stream_and_user', (q) => q.eq('streamId', streamId).eq('userId', user._id))
        .first();
      if (!moderator) {
        return { success: false as const, error: 'Admin or stream moderator access required' };
      }
    }

    const accepted = await acceptUpload(ctx, user._id, storageId, IMAGE_TYPES, MAX_IMAGE_BYTES, 'Stream photo');
    if (!accepted.ok) return { success: false as const, error: accepted.error };

    const url = await ctx.storage.getUrl(storageId);
    if (!url) return { success: false as const, error: 'Upload could not be read back.' };

    const previous = kind === 'cover' ? stream.coverImageId : stream.displayPhotoId;

    await ctx.db.patch(streamId, {
      ...(kind === 'cover'
        ? { coverImageId: storageId, coverImageUrl: url }
        : { displayPhotoId: storageId, displayPhotoUrl: url }),
      updatedAt: Date.now(),
    });

    await discardSuperseded(ctx, previous, storageId);
    return { success: true as const, url };
  },
});

// --------------------------------------------------------------------- misc

/** The site logo, from admin > settings. Stored as an adminSettings value. */
export const setSiteLogo = mutation({
  args: { token: v.string(), storageId: v.id('_storage') },
  handler: async (ctx, { token, storageId }) => {
    const admin = await requireAdmin(ctx, token);

    const accepted = await acceptUpload(ctx, admin._id, storageId, IMAGE_TYPES, MAX_IMAGE_BYTES, 'Site logo');
    if (!accepted.ok) return { success: false as const, error: accepted.error };

    const url = await ctx.storage.getUrl(storageId);
    if (!url) return { success: false as const, error: 'Upload could not be read back.' };

    const setting = await ctx.db
      .query('adminSettings')
      .withIndex('by_key', (q) => q.eq('settingKey', 'site_logo_url'))
      .unique();

    const now = Date.now();

    if (setting) {
      // The previous object is reclaimed. This was the one attach mutation with
      // no id to discard, so every logo change leaked its predecessor.
      const previousId = (setting.settingValue as { storageId?: Id<'_storage'> } | string | null);
      const priorStorageId =
        previousId && typeof previousId === 'object' ? previousId.storageId : undefined;

      await ctx.db.patch(setting._id, {
        settingValue: { url, storageId },
        updatedBy: admin._id,
        updatedAt: now,
      });

      await discardSuperseded(ctx, priorStorageId, storageId);
    } else {
      // Unlike adminSettings.set, this one CREATES. The key is defined by this
      // feature rather than by a migration, so refusing to create it would make
      // the logo unsettable on a fresh deployment.
      await ctx.db.insert('adminSettings', {
        settingKey: 'site_logo_url',
        settingValue: { url, storageId },
        category: 'branding',
        description: 'Site logo shown in the header and on emails',
        updatedBy: admin._id,
        createdAt: now,
        updatedAt: now,
      });
    }

    return { success: true as const, url };
  },
});

/**
 * Validates an image intended for a post, WITHOUT attaching or publishing it.
 *
 * The first version returned `ctx.storage.getUrl()` — a permanent,
 * unauthenticated, unrevocable url for arbitrary member-uploaded content on
 * ORBIT's domain, i.e. a free image host, surviving the post's deletion. It also
 * marked the claim attached, so the reaper skipped images no post ever
 * referenced and they were billed forever.
 *
 * The id is returned instead and `posts.create` attaches it. Until then the
 * claim stays unattached and the hourly reaper will collect it, so an abandoned
 * compose costs nothing.
 */
export const validatePostImage = mutation({
  args: { token: v.string(), storageId: v.id('_storage') },
  handler: async (ctx, { token, storageId }) => {
    const user = await requireUser(ctx, token);

    const claim = await claimUpload(ctx, user._id, storageId);
    if (!claim.ok) return { success: false as const, error: claim.error };

    const meta = await ctx.db.system.get(storageId);
    if (!meta || !IMAGE_TYPES.includes(meta.contentType ?? '')) {
      if (claim.fresh) await rejectUpload(ctx, storageId);
      return { success: false as const, error: `Post image must be one of: ${IMAGE_TYPES.join(', ')}` };
    }
    if (meta.size > MAX_IMAGE_BYTES) {
      if (claim.fresh) await rejectUpload(ctx, storageId);
      return { success: false as const, error: 'Post image must be 5 MB or smaller.' };
    }

    return { success: true as const, storageId };
  },
});

/**
 * Confirms a caller owns an upload AND that nothing else already points at it.
 *
 * Ownership alone was not enough. An object attached once could be attached
 * again somewhere else, and `releaseUpload` deletes unconditionally — so a
 * member could attach their own approved submission file to a throwaway post,
 * delete the post, and take the coursework with it. `attachSubmissionFile`
 * refuses to replace a reviewed submission; this was the way round that.
 *
 * It also crossed the type and size policies. A claim minted by the submission
 * path carries a 15 MB cap and the document MIME list, so re-attaching it as a
 * post image served a PDF through the image route.
 */
export async function attachOwnedUpload(
  ctx: MutationCtx,
  userId: Id<'users'>,
  storageId: Id<'_storage'>,
): Promise<boolean> {
  const claim = await ctx.db
    .query('uploads')
    .withIndex('by_storage', (q) => q.eq('storageId', storageId))
    .first();

  if (!claim || claim.userId !== userId) return false;
  // Already spoken for. Indistinguishable from "no such upload" to the caller,
  // so this cannot be used to probe which ids are in use.
  if (claim.attached) return false;

  await ctx.db.patch(claim._id, { attached: true });
  return true;
}

/**
 * Releases a post's image when the post goes.
 *
 * Only ever called with an id read off the record being deleted, and the claim
 * is now single-use, so the object cannot still be reachable from anywhere else
 * by the time this runs.
 */
export async function releaseUpload(ctx: MutationCtx, storageId?: Id<'_storage'>) {
  if (!storageId) return;
  const claim = await ctx.db
    .query('uploads')
    .withIndex('by_storage', (q) => q.eq('storageId', storageId))
    .first();
  if (claim) await ctx.db.delete(claim._id);
  await discard(ctx, storageId);
}

// --------------------------------------------------------------- submissions

/**
 * Attaches a file to the caller's submission and submits it.
 *
 * NOT a public URL, unlike everything above. `tasks.ts:261` uploaded to a
 * `task-submissions` bucket that does not exist — and had it existed as
 * configured, it would have been PUBLIC, making every member's coursework
 * world-readable to anyone who guessed a path. Submissions are read through
 * `/submissions/file`, which checks the session.
 */
export const attachSubmissionFile = mutation({
  args: {
    token: v.string(),
    taskId: v.id('tasks'),
    storageId: v.id('_storage'),
    submissionText: v.optional(v.string()),
  },
  handler: async (ctx, { token, taskId, storageId, submissionText }) => {
    const user = await requireUser(ctx, token);

    // Same gate as submitWork: a member may only submit to a task in a stream
    // they belong to.
    // Authorization first, and no storage call on any refusal path.
    const task = await ctx.db.get(taskId);
    if (!task) return { success: false as const, error: 'Task not found' };

    /**
     * A proposal is not a task yet, to anyone.
     *
     * `submitWork` gets this from `assertTaskAccess`; this path has its own gate
     * and never learned about proposals, so a member could attach a file to an
     * unapproved draft. `declineProposal` then deletes the task, orphaning the
     * submission and its storage object — the one case that breaks the
     * "a pending task can have no submissions" invariant deletion relies on.
     * Same wording as a missing task, so this cannot be used to probe for one.
     */
    if (!isPublished(task) || !task.isActive) {
      return { success: false as const, error: 'Task not found' };
    }

    if (!hasRole(user, 'admin', 'super_admin', 'moderator')) {
      // activeMembership, not .first() — see convex/lib/membership.ts.
      if (!(await activeMembership(ctx, task.streamId, user._id))) {
        return { success: false as const, error: 'This task is not in one of your streams' };
      }
    }

    /**
     * The already-approved check comes BEFORE the claim is accepted.
     *
     * `acceptUpload` marks the object attached, which is precisely what tells
     * the unattached-upload reaper to leave it alone. Refusing afterwards left
     * a billed object marked as attached with nothing pointing at it — invisible
     * to the reaper by design, and to everyone else by accident.
     */
    const existing = await ctx.db
      .query('submissions')
      .withIndex('by_task_and_user', (q) => q.eq('taskId', taskId).eq('userId', user._id))
      .first();

    if (existing?.status === 'approved') {
      return { success: false as const, error: 'This submission has already been approved.' };
    }

    const accepted = await acceptUpload(
      ctx, user._id, storageId, SUBMISSION_TYPES, MAX_SUBMISSION_BYTES, 'Submission file',
    );
    if (!accepted.ok) return { success: false as const, error: accepted.error };

    /**
     * Bounded, exactly as `tasks.submitWork` bounds the same column.
     *
     * This is an authenticated write, so it REJECTS rather than truncates —
     * the rule at the top of lib/input.ts. Without this the file-upload route
     * was a way around the 20k limit `submitWork` enforces: attach a valid file
     * and post arbitrary text alongside it, up to Convex's 1MiB document
     * ceiling, which then renders in the reviewer's queue and the peer
     * showcase.
     */
    const bounded = validate(() => ({
      submissionText: optionalText(submissionText, 'Submission', FIELD.submissionText),
    }));
    if (!bounded.ok) return { success: false as const, error: bounded.error };

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        submissionFileId: storageId,
        submissionText: bounded.value.submissionText ?? existing.submissionText,
        status: 'submitted',
        submittedAt: now,
        updatedAt: now,
      });
      await discardSuperseded(ctx, existing.submissionFileId, storageId);
      return { success: true as const, id: existing._id };
    }

    const id = await ctx.db.insert('submissions', {
      taskId,
      userId: user._id,
      submissionFileId: storageId,
      submissionText: bounded.value.submissionText,
      status: 'submitted',
      submittedAt: now,
      isDummy: false,
      createdAt: now,
      updatedAt: now,
    });

    return { success: true as const, id };
  },
});


/**
 * Deletes uploads that were claimed but never attached.
 *
 * `generateUploadUrl` issues a URL that accepts any content of any size, and
 * validation only happens if the caller chooses to call an attach mutation. A
 * caller who never attaches leaves an object nothing references — and Convex
 * never reclaims storage, so it is billed forever. Driven by a cron.
 *
 * An hour is far longer than any real upload takes and short enough that abuse
 * cannot accumulate.
 */
export const reapUnattachedUploads = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 60 * 60 * 1000;

    const stale = await ctx.db
      .query('uploads')
      .withIndex('by_attached_and_time', (q) => q.eq('attached', false).lt('createdAt', cutoff))
      .take(200);

    let removed = 0;
    for (const claim of stale) {
      await discard(ctx, claim.storageId);
      await ctx.db.delete(claim._id);
      removed++;
    }

    return { removed };
  },
});
