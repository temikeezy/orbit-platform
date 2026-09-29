import { convexHttp as convex } from '../convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../auth';

/**
 * File uploads, on Convex storage.
 *
 * THREE OF THE FOUR BUCKETS THIS REPLACES DID NOT EXIST. `task-submissions`,
 * `profile-photos` and `cover-photos` are named nowhere in the Supabase project,
 * so those uploads have been failing in production — including the edit page's
 * profile photo, while `api/users.ts` uploaded the same thing to a bucket that
 * works. Fixed, not reproduced.
 *
 * The call signatures are unchanged so the existing call sites are not touched.
 * `userId` and `streamId` arguments that only existed to build a bucket path are
 * accepted and ignored where the session already determines the answer.
 *
 * Three round trips, which is Convex's upload flow: ask for a URL, PUT the bytes
 * straight to it, then attach. Bytes never pass through a mutation, so a 5 MB
 * image does not have to fit in a function argument.
 */

export interface UploadResult {
  url: string;
  path: string;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

function requireToken(): string {
  const token = authService.getToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}

/**
 * Uploads the bytes and returns the storage id.
 *
 * The URL this posts to accepts anything of any size — Convex validates neither.
 * The real check happens in the attach mutations, which read the stored object's
 * metadata and delete it if it is not what was claimed. `validateImage` below is
 * a courtesy so the user finds out before a 5 MB round trip, NOT a control.
 */
async function putFile(file: File): Promise<string> {
  const token = requireToken();

  const issued = await convex.mutation(api.files.generateUploadUrl, { token });
  if (!issued.success) throw new Error(issued.error);

  const response = await fetch(issued.uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': file.type },
    body: file,
  });

  if (!response.ok) throw new Error('Upload failed. Please try again.');

  const { storageId } = (await response.json()) as { storageId: string };
  return storageId;
}

export const storageUtils = {
  validateImage(file: File): { valid: boolean; error?: string } {
    if (!ALLOWED_TYPES.includes(file.type)) {
      return {
        valid: false,
        error: 'Invalid file type. Please upload a JPEG, PNG, GIF, or WebP image.',
      };
    }

    if (file.size > MAX_FILE_SIZE) {
      return { valid: false, error: 'File size exceeds 5MB limit.' };
    }

    return { valid: true };
  },

  /** `_userId` is ignored: the session decides whose photo this is. */
  async uploadProfilePhoto(_userId: string, file: File): Promise<UploadResult> {
    const validation = this.validateImage(file);
    if (!validation.valid) throw new Error(validation.error);

    const storageId = await putFile(file);

    const result = await convex.mutation(api.files.setProfilePhoto, {
      token: requireToken(),
      storageId: storageId as never,
      kind: 'profile',
    });

    if (!result.success) throw new Error(result.error);
    return { url: result.url, path: storageId };
  },

  async uploadCoverPhoto(_userId: string, file: File): Promise<UploadResult> {
    const validation = this.validateImage(file);
    if (!validation.valid) throw new Error(validation.error);

    const storageId = await putFile(file);

    const result = await convex.mutation(api.files.setProfilePhoto, {
      token: requireToken(),
      storageId: storageId as never,
      kind: 'cover',
    });

    if (!result.success) throw new Error(result.error);
    return { url: result.url, path: storageId };
  },

  async uploadStreamCoverPhoto(streamId: string, file: File): Promise<UploadResult> {
    return uploadStreamPhoto(streamId, file, 'cover', this.validateImage(file));
  },

  async uploadStreamDisplayPhoto(streamId: string, file: File): Promise<UploadResult> {
    return uploadStreamPhoto(streamId, file, 'display', this.validateImage(file));
  },

  async uploadSiteLogo(file: File): Promise<UploadResult> {
    const validation = this.validateImage(file);
    if (!validation.valid) throw new Error(validation.error);

    const storageId = await putFile(file);

    const result = await convex.mutation(api.files.setSiteLogo, {
      token: requireToken(),
      storageId: storageId as never,
    });

    if (!result.success) throw new Error(result.error);
    return { url: result.url, path: storageId };
  },

  /**
   * Removing a photo.
   *
   * The bucket argument is gone from the signature's meaning — there are no
   * buckets — but the shape is kept so call sites are unchanged. Only the
   * profile and cover cases are reachable today; the stream and logo paths had
   * no delete button.
   */
  async deletePhoto(bucket: string, _path: string): Promise<void> {
    if (bucket === 'orbit_profile_photos' || bucket === 'profile-photos') {
      await convex.mutation(api.files.removeProfilePhoto, {
        token: requireToken(),
        kind: 'profile',
      });
      return;
    }

    if (bucket === 'cover-photos') {
      await convex.mutation(api.files.removeProfilePhoto, {
        token: requireToken(),
        kind: 'cover',
      });
    }
  },
};

async function uploadStreamPhoto(
  streamId: string,
  file: File,
  kind: 'cover' | 'display',
  validation: { valid: boolean; error?: string },
): Promise<UploadResult> {
  if (!validation.valid) throw new Error(validation.error);

  const storageId = await putFile(file);

  const result = await convex.mutation(api.files.setStreamPhoto, {
    token: requireToken(),
    streamId: streamId as never,
    storageId: storageId as never,
    kind,
  });

  if (!result.success) throw new Error(result.error);
  return { url: result.url, path: storageId };
}
