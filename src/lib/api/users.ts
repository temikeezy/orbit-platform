import { convexHttp as convex } from '../convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../auth';
import { OrbitUser, UserRole } from '../../types/database';
import { toOrbitUser, ConvexUser } from '../convexAdapters';
import { storageUtils } from '../utils/storage';

/**
 * Users, on Convex.
 *
 * `ORBIT_USER_COLUMNS` is gone with the rest. It existed because the Supabase
 * build selected `*` by default and that returned `password_hash`, `jwt_token`
 * and `temp_password` to anyone holding the anon key — the column list was the
 * patch. Convex projects through `publicUser`/`directoryShape` server-side, so a
 * secret cannot reach the wire by forgetting a list here.
 *
 * Two functions changed shape rather than just backend:
 *
 *  - `updateUser` no longer takes arbitrary columns. A self-service profile edit
 *    goes through `updateMyProfile`, whose arguments deliberately exclude roles,
 *    isActive and points; role and status changes are separate admin mutations.
 *    The old one PATCHed whatever it was handed.
 *  - `deleteUser`/`deactivateUser` deactivate. Permanent deletion is its own
 *    call, refuses unless the user is in the trash, and refuses outright when
 *    they authored platform content that would be orphaned.
 */

export interface CreateUserData {
  email: string;
  full_name: string;
  roles: UserRole[];
  /**
   * Which programme an intern is on: 'siwes' | 'internship' | 'nysc' |
   * 'volunteer'. Decides whether they keep a logbook, so an intern created
   * without one keeps none until it is set.
   */
  programme_type?: string;
  current_stream_id?: string;
  /** Alias the bulk-import screens use. */
  stream_id?: string;
  /**
   * An explicit password, if the admin chose one.
   *
   * The server always generates a temporary password; this is applied after
   * creation via `adminSetPassword`, which is super-admin only — the same gate
   * `adminCreateUser` already sits behind, so nothing is widened.
   */
  password?: string;
}

export interface UpdateUserData {
  full_name?: string;
  bio?: string;
  location?: string;
  profile_photo_url?: string;
  cover_photo_url?: string;
  social_links?: OrbitUser['social_links'];
  profile_visibility?: 'public' | 'stream_only' | 'private';
  show_email?: boolean;
  show_activity_on_feed?: boolean;
  show_on_leaderboard?: boolean;
  roles?: UserRole[];
  is_active?: boolean;
  current_stream_id?: string;
}

function requireToken(): string {
  const token = authService.getToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}

/**
 * The directory shape is narrower than a full user, so the fields it omits are
 * filled with neutral values rather than left undefined — every consumer of
 * `OrbitUser` expects them to exist.
 */
function fromDirectory(u: Record<string, unknown>): OrbitUser {
  return toOrbitUser({
    id: u.id as string,
    email: (u.email as string) ?? '',
    fullName: u.fullName as string,
    profileSlug: u.profileSlug as string,
    profilePhotoUrl: u.profilePhotoUrl as string | undefined,
    bio: u.bio as string | undefined,
    location: u.location as string | undefined,
    roles: (u.roles as string[]) ?? [],
    currentStreamId: u.currentStreamId as string | undefined,
    totalPoints: (u.totalPoints as number) ?? 0,
    currentLevel: (u.currentLevel as number) ?? 1,
    isActive: (u.isActive as boolean) ?? true,
    // Staff-only, and dropped here until now — so the admin Users page could
    // never tell who held MCP access, and its toggle acted on `undefined`.
    mcpEnabled: Boolean(u.mcpEnabled),
    // Staff-only on the server, and dropped here for the same reason mcpEnabled
    // was: this adapter builds its object field by field, so anything not named
    // never reaches the page. `toOrbitUser` already renders it as last_login_at.
    lastLoginAt: u.lastLoginAt as number | undefined,
    createdAt: (u.createdAt as number) ?? 0,
  });
}

export const usersApi = {
  // The pagination arguments are accepted and ignored: `users.list` returns the
  // whole directory, which is a few hundred rows, and paging it in the client
  // was what the Supabase row cap forced rather than something a caller wanted.
  async getAllUsers(_page = 0, _pageSize = 50): Promise<OrbitUser[]> {
    const rows = await convex.query(api.users.list, {
      token: requireToken(),
      includeInactive: true,
    });
    return (rows as Record<string, unknown>[]).map(fromDirectory);
  },

  async getActiveUsers(_page = 0, _pageSize = 50): Promise<OrbitUser[]> {
    const rows = await convex.query(api.users.list, { token: requireToken() });
    return (rows as Record<string, unknown>[]).map(fromDirectory);
  },

  async getUserById(id: string): Promise<OrbitUser | null> {
    const row = await convex.query(api.users.getById, {
      token: requireToken(),
      userId: id as never,
    });
    return row ? fromDirectory(row as Record<string, unknown>) : null;
  },

  async getUserBySlug(slug: string): Promise<OrbitUser | null> {
    const row = await convex.query(api.users.getBySlug, { token: requireToken(), slug });
    return row ? fromDirectory(row as Record<string, unknown>) : null;
  },

  /**
   * Admin view of one user: the fuller record, minus every secret.
   *
   * Built as a literal server-side rather than by spreading the document, so a
   * field added to the schema later cannot leak through by default.
   */
  async getUserDetail(id: string): Promise<OrbitUser | null> {
    const row = await convex.query(api.users.adminGetById, {
      token: requireToken(),
      userId: id as never,
    });
    return row ? toOrbitUser(row as unknown as ConvexUser) : null;
  },

  async getUserByEmail(email: string): Promise<OrbitUser | null> {
    const all = await this.getAllUsers();
    return all.find((u) => u.email.toLowerCase() === email.trim().toLowerCase()) ?? null;
  },

  /** Returns the temporary password ONCE, for the admin to pass on. */
  async createUser(userData: CreateUserData): Promise<OrbitUser & { temp_password?: string }> {
    const result = await convex.mutation(api.users.adminCreateUser, {
      token: requireToken(),
      email: userData.email,
      fullName: userData.full_name,
      roles: userData.roles,
      // OMITTED when absent, never sent as "". The Create User form's stream
      // select defaults to an empty string for "no stream", and
      // `v.optional(v.id('streams'))` rejects that — so creating a user without
      // choosing a stream failed with a raw ArgumentValidationError shown to the
      // admin. `undefined` is what "optional" means here; '' is a value.
      streamId: (userData.current_stream_id || userData.stream_id || undefined) as never,
      // Same reasoning as streamId: '' is not "unset".
      programmeType: userData.programme_type || undefined,
    });

    if (!result.success) throw new Error(result.error);

    if (userData.password) {
      const set = await convex.mutation(api.users.adminSetPassword, {
        token: requireToken(),
        userId: result.id as never,
        newPassword: userData.password,
      });
      if (!set.success) throw new Error(set.error);
    }

    const created = await this.getUserDetail(result.id as string);
    if (!created) throw new Error('User not found after creation');
    return { ...created, temp_password: userData.password ? undefined : result.tempPassword };
  },

  /**
   * Updates a user.
   *
   * Profile fields go through `updateMyProfile` (self only); roles, active state
   * and stream membership are separate admin mutations. The old single PATCH
   * accepted any column, which is how a profile edit could have granted itself a
   * role had anything ever passed one.
   */
  async updateUser(id: string, userData: UpdateUserData): Promise<OrbitUser> {
    const token = requireToken();
    const isSelf = authService.getCurrentUser()?.id === id;

    const profileFields = {
      fullName: userData.full_name,
      bio: userData.bio,
      location: userData.location,
      socialLinks: userData.social_links,
      profileVisibility: userData.profile_visibility,
      showEmail: userData.show_email,
      showActivityOnFeed: userData.show_activity_on_feed,
      showOnLeaderboard: userData.show_on_leaderboard,
    };

    if (Object.values(profileFields).some((v) => v !== undefined)) {
      // Self goes through updateMyProfile, which carries the privacy settings an
      // admin has no business setting on someone else. Anyone else goes through
      // the narrow admin mutation — which did not exist, so an admin editing
      // another user's name silently changed nothing and said it had worked.
      const result = isSelf
        ? await convex.mutation(api.users.updateMyProfile, { token, ...profileFields })
        : await convex.mutation(api.users.adminUpdateProfile, {
            token,
            userId: id as never,
            fullName: profileFields.fullName,
            bio: profileFields.bio,
            location: profileFields.location,
          });
      if (!result.success) throw new Error(result.error);
    }

    if (userData.roles) {
      const result = await convex.mutation(api.users.adminSetRoles, {
        token,
        userId: id as never,
        roles: userData.roles,
      });
      if (!result.success) throw new Error(result.error);
    }

    if (userData.is_active !== undefined) {
      const result = await convex.mutation(api.users.adminSetActive, {
        token,
        userId: id as never,
        isActive: userData.is_active,
      });
      if (!result.success) throw new Error(result.error);
    }

    // The admin view THROWS for a non-admin rather than returning null, so a
    // member editing their own profile has to fall through to the directory
    // shape — otherwise every successful self-edit ended in "Admin access
    // required" after the write had already landed.
    const updated = await this.getUserDetail(id)
      .catch(() => null)
      .then((detail) => detail ?? this.getUserById(id));

    if (!updated) throw new Error('User not found after update');
    return updated;
  },

  /**
   * Both directions. `adminSetActive` has always taken a boolean; only this
   * module and the admin screen were one-way, which made deactivation
   * unreversible from anywhere in the app.
   */
  async setUserActive(id: string, isActive: boolean): Promise<void> {
    const result = await convex.mutation(api.users.adminSetActive, {
      token: requireToken(),
      userId: id as never,
      isActive,
    });
    if (!result.success) throw new Error(result.error);
  },

  async deactivateUser(id: string): Promise<void> {
    return this.setUserActive(id, false);
  },

  async trashUser(userId: string): Promise<void> {
    const result = await convex.mutation(api.users.adminTrashUser, {
      token: requireToken(),
      userId: userId as never,
    });
    if (!result.success) throw new Error(result.error);
  },

  async restoreUser(userId: string): Promise<void> {
    const result = await convex.mutation(api.users.adminRestoreUser, {
      token: requireToken(),
      userId: userId as never,
    });
    if (!result.success) throw new Error(result.error);
  },

  /**
   * Permanently deletes.
   *
   * Refuses when the user authored platform content that deleting them would
   * orphan, and says what and how much — Convex has no foreign keys, so the
   * alternative is a silent forest of ids that resolve to null forever.
   */
  async permanentlyDeleteUser(userId: string): Promise<void> {
    const result = await convex.mutation(api.users.adminPermanentlyDeleteUser, {
      token: requireToken(),
      userId: userId as never,
    });
    if (!result.success) throw new Error(result.error);
  },

  /** What a permanent delete would remove, and what blocks it. */
  async getDeletionReport(userId: string) {
    return convex.query(api.users.adminDeletionReport, {
      token: requireToken(),
      userId: userId as never,
    });
  },

  async getTrashedUsers(): Promise<OrbitUser[]> {
    const rows = await convex.query(api.users.adminListTrash, { token: requireToken() });
    return (rows as Record<string, unknown>[]).map(fromDirectory);
  },

  /** Issues a new temporary password and returns it once. */
  async resetPassword(userId: string): Promise<string> {
    const result = await convex.mutation(api.users.adminResetPassword, {
      token: requireToken(),
      userId: userId as never,
    });
    if (!result.success) throw new Error(result.error);
    return result.tempPassword;
  },

  async searchUsers(query: string): Promise<OrbitUser[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];

    const all = await this.getActiveUsers();
    return all.filter(
      (u) =>
        u.full_name.toLowerCase().includes(needle) ||
        (u.email ?? '').toLowerCase().includes(needle),
    );
  },

  async getUsersByStream(streamId: string): Promise<OrbitUser[]> {
    const all = await this.getActiveUsers();
    return all.filter((u) => u.current_stream_id === streamId);
  },

  async getUsersWithoutStream(): Promise<OrbitUser[]> {
    const all = await this.getActiveUsers();
    return all.filter((u) => !u.current_stream_id);
  },

  async uploadProfilePhoto(userId: string, file: File): Promise<string> {
    const { url } = await storageUtils.uploadProfilePhoto(userId, file);
    return url;
  },

  async uploadCoverPhoto(userId: string, file: File): Promise<string> {
    const { url } = await storageUtils.uploadCoverPhoto(userId, file);
    return url;
  },

  async toggleMcpAccess(userId: string, enabled: boolean): Promise<{ success: boolean; error?: string }> {
    const result = await convex.mutation(api.users.adminSetMcpAccess, {
      token: requireToken(),
      userId: userId as never,
      enabled,
    });
    return result.success ? { success: true } : { success: false, error: result.error };
  },

  /**
   * Emails a sign-in link.
   *
   * Replaces the old "password reset email". There is no reset-link flow on
   * Convex and inventing one would mean a second single-use credential doing the
   * same job as the magic link, which already exists, is single-use, expires in
   * an hour, and does not disturb the recipient's current session.
   */
  async sendPasswordResetEmail(email: string): Promise<void> {
    const result = await authService.requestMagicLink(email);
    if (!result.success) throw new Error(result.error ?? 'Could not send the sign-in link.');
  },

  async sendBulkPasswordResetEmails(
    emails: string[],
  ): Promise<{ success: number; failed: string[] }> {
    let success = 0;
    const failed: string[] = [];

    // Sequential, not Promise.all: these are rate limited per address AND per
    // deployment, and firing fifty at once would trip the limit and report most
    // of them as failures.
    for (const email of emails) {
      try {
        await this.sendPasswordResetEmail(email);
        success++;
      } catch {
        failed.push(email);
      }
    }

    return { success, failed };
  },

};
