import { query, mutation, internalMutation } from './_generated/server';
import { QueryCtx, MutationCtx } from './_generated/server';
import { v } from 'convex/values';
import bcrypt from 'bcryptjs';
import { Doc, Id } from './_generated/dataModel';
import { checkRateLimit, LIMITS } from './lib/rateLimit';
import { escapeHtml } from './lib/html';
import { orgShortName } from './lib/org';
import { requireUser, requireAdmin, hasRole, publicUser, randomToken } from './lib/auth';
import { ensureInternProfile, resolveCohort } from './lib/internProfile';
import { PROGRAMME_TYPES } from './lib/programme';
import { FIELD, optionalText, socialLinks, validate } from './lib/input';
import { startMembership } from './lib/membership';

/**
 * Users, profiles and friendships.
 *
 * Every user-returning function projects through a narrow shape. The Supabase
 * build selected whole rows, which is how `password_hash`, `jwt_token` and
 * `temp_password` became readable with the public anon key. `publicUser` in
 * lib/auth.ts already excludes them; the directory shape below is narrower still,
 * because a member list needs far less than a session payload.
 */

/**
 * Directory entry. Honours the two privacy flags the old `select('*')` ignored:
 * `showEmail` and `profileVisibility`.
 */
function directoryShape(u: Doc<'users'>, viewerIsStaff: boolean) {
  return {
    id: u._id,
    fullName: u.fullName,
    profileSlug: u.profileSlug,
    profilePhotoUrl: u.profilePhotoUrl,
    bio: u.bio,
    location: u.location,
    roles: u.roles,
    currentStreamId: u.currentStreamId,
    totalPoints: u.totalPoints,
    currentLevel: u.currentLevel,
    // Staff always see the address; everyone else only when the user allows it.
    email: u.showEmail || viewerIsStaff ? u.email : undefined,
    isActive: u.isActive,
    // Staff only, and admin-relevant rather than profile data: MCP access is a
    // standing API credential on the account. Its absence here meant the admin
    // Users page read `mcp_enabled` as undefined for EVERY row — so the toggle
    // rendered in its off state regardless of the truth, always offered
    // "Enable", and there was no way to see who already had it.
    mcpEnabled: viewerIsStaff ? Boolean(u.mcpEnabled) : undefined,
    /**
     * Staff only, for the same reason as `mcpEnabled`: operational, not profile.
     *
     * The admin register is this query — there is no separate admin users
     * query — so without it here there is no way to answer "who has actually
     * signed in?" for more than one person at a time, and the first week of a
     * cohort is exactly when that question is the whole job.
     *
     * Deliberately NOT ungated. `list` also renders the member-facing Community
     * directory, and when one intern last signed in is nobody else's business.
     */
    lastLoginAt: viewerIsStaff ? u.lastLoginAt : undefined,
    // Profile-page fields. Omitting them meant UserProfilePage never rendered a
    // cover photo or a social-links section even when set, and showed "Joined
    // 1 Jan 1970" because the adapter falls back to epoch for a missing
    // createdAt. They are no more sensitive than the name and photo already
    // here, and are subject to the same profileVisibility gate above.
    coverPhotoUrl: u.coverPhotoUrl,
    socialLinks: u.socialLinks,
    createdAt: u.createdAt,
  };
}

export const list = query({
  args: { token: v.string(), includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, { token, includeInactive }) => {
    const viewer = await requireUser(ctx, token);
    const staff = hasRole(viewer, 'admin', 'super_admin', 'moderator');

    const users = await ctx.db.query('users').collect();

    return users
      .filter((u) => !u.isDeleted)
      .filter((u) => includeInactive || u.isActive)
      // A private profile is hidden from the directory unless staff, or self.
      // 'stream_only' is a real third value (UserSettingsPage.tsx:24) that a
      // !== 'private' test silently treated as fully public.
      .filter((u) => staff || u._id === viewer._id || u.profileVisibility === 'public')
      .map((u) => directoryShape(u, staff))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  },
});

export const getBySlug = query({
  args: { token: v.string(), slug: v.string() },
  handler: async (ctx, { token, slug }) => {
    const viewer = await requireUser(ctx, token);
    const staff = hasRole(viewer, 'admin', 'super_admin', 'moderator');

    const user = await ctx.db
      .query('users')
      .withIndex('by_slug', (q) => q.eq('profileSlug', slug))
      .unique();

    if (!user || user.isDeleted) return null;
    if (user.profileVisibility !== 'public' && !staff && user._id !== viewer._id) return null;

    return directoryShape(user, staff);
  },
});

export const getById = query({
  args: { token: v.string(), userId: v.id('users') },
  handler: async (ctx, { token, userId }) => {
    const viewer = await requireUser(ctx, token);
    const staff = hasRole(viewer, 'admin', 'super_admin', 'moderator');

    const user = await ctx.db.get(userId);
    if (!user || user.isDeleted) return null;
    if (user.profileVisibility !== 'public' && !staff && user._id !== viewer._id) return null;

    return directoryShape(user, staff);
  },
});

export const updateMyProfile = mutation({
  args: {
    token: v.string(),
    fullName: v.optional(v.string()),
    bio: v.optional(v.string()),
    location: v.optional(v.string()),
    // profilePhotoUrl / coverPhotoUrl are NOT settable here. `files.ts` owns
    // them, alongside the storage id it needs to reclaim the old object. Two
    // writers for one denormalised field desynchronised the pair — and this one
    // took an arbitrary string, so a member could point their directory avatar
    // at any external host and collect an IP and user-agent from every member
    // who loaded the page.
    socialLinks: v.optional(v.any()),
    profileVisibility: v.optional(v.string()),
    showEmail: v.optional(v.boolean()),
    showActivityOnFeed: v.optional(v.boolean()),
    showOnLeaderboard: v.optional(v.boolean()),
  },
  handler: async (ctx, { token, ...patch }) => {
    const user = await requireUser(ctx, token);

    // Validated: an unrecognised value would otherwise render the profile public.
    if (patch.profileVisibility !== undefined &&
        !['public', 'stream_only', 'private'].includes(patch.profileVisibility)) {
      return { success: false as const, error: 'Invalid profile visibility.' };
    }

    /**
     * Bounded, and socialLinks given a shape at last.
     *
     * `v.optional(v.any())` on a mutation every member can call is an
     * arbitrary-JSON store that publicUser() then hands to every reader — the
     * third instance of a class this file's neighbours have already fixed twice,
     * in posts.metadata and dailyLogs.evidenceLinks, each with a comment saying
     * why. socialLinks() drops unknown keys rather than refusing them, so an
     * older client sending an extra field does not start failing.
     */
    const bounded = validate(() => ({
      fullName: optionalText(patch.fullName, 'Name', FIELD.fullName),
      bio: optionalText(patch.bio, 'Bio', FIELD.bio),
      location: optionalText(patch.location, 'Location', FIELD.location),
      socialLinks: patch.socialLinks === undefined ? undefined : socialLinks(patch.socialLinks),
    }));
    if (!bounded.ok) return { success: false as const, error: bounded.error };

    // Only supplied fields — patch removes any key set to undefined.
    const clean = Object.fromEntries(
      Object.entries({ ...patch, ...bounded.value }).filter(([, v]) => v !== undefined),
    );

    // roles, isActive, totalPoints and currentLevel are deliberately absent from
    // the args: a self-service profile edit must never be able to grant itself a
    // role or points.
    await ctx.db.patch(user._id, { ...clean, updatedAt: Date.now() });
    return { success: true as const };
  },
});

export const changePassword = mutation({
  args: {
    token: v.string(),
    /**
     * Optional, because an account may not have a password to confirm.
     * Required whenever one exists — see below.
     */
    currentPassword: v.optional(v.string()),
    newPassword: v.string(),
  },
  handler: async (ctx, { token, currentPassword, newPassword }) => {
    const user = await requireUser(ctx, token);

    if (newPassword.length < 8) {
      return { success: false as const, error: 'Password must be at least 8 characters.' };
    }

    // bcrypt silently truncates past 72 bytes, so anything longer is a password
    // whose tail does nothing — worse than a refusal, because the user believes
    // it counted.
    if (newPassword.length > 72) {
      return { success: false as const, error: 'Password must be 72 characters or fewer.' };
    }

    /**
     * THROTTLED, because this is a password oracle.
     *
     * Below, a caller who supplies the wrong current password is told so. With
     * no limit that is an unlimited guessing endpoint against a real password,
     * reachable by anything holding a session — and a session is exactly what an
     * attacker in this threat model has. `signIn` has been rate limited from the
     * start for the same reason; this path was not.
     */
    const throttle = await checkRateLimit(
      ctx,
      String(user._id),
      'password_change',
      LIMITS.login.max,
      LIMITS.login.windowMs,
    );
    if (!throttle.allowed) {
      return { success: false as const, error: 'Too many attempts. Try again shortly.' };
    }

    /**
     * SETTING A FIRST PASSWORD IS NOT CHANGING ONE.
     *
     * Applicants converted from the intake are created with no passwordHash and
     * no tempPassword — they arrive by magic link, deliberately. This function
     * required the current password and rejected anyone without one, so every
     * one of them was magic-link-only FOREVER: an email round trip for each
     * sign-in, on the one platform surface where email is the bottleneck and is
     * currently paused outright.
     *
     * When no password exists there is nothing to confirm, and the session is
     * the proof of identity: it can only have come from a single-use link
     * emailed to that address, or from SSO. Requiring a secret the account has
     * never had is not a check, it is a lockout.
     *
     * Where a password DOES exist the old rule stands unchanged — knowing the
     * current one is what stops a borrowed session silently changing it.
     */
    const hadPassword = Boolean(user.passwordHash);

    if (user.passwordHash) {
      if (!currentPassword || !bcrypt.compareSync(currentPassword, user.passwordHash)) {
        return { success: false as const, error: 'Current password is incorrect.' };
      }
    }

    // Cost 10, up from the pgcrypto default of 6 that every imported hash uses.
    // Verification stays compatible because bcrypt encodes its cost in the hash.
    const hash = bcrypt.hashSync(newPassword, 10);

    await ctx.db.patch(user._id, {
      passwordHash: hash,
      tempPassword: undefined,
      updatedAt: Date.now(),
    });

    // Every other session is revoked on a password change — the Postgres version
    // left them all alive, so a stolen session survived the remedy for it.
    const sessions = await ctx.db
      .query('sessions')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect();

    for (const s of sessions) {
      if (s.token !== token) await ctx.db.delete(s._id);
    }

    /**
     * SAY SO. A password change is the moment temporary access becomes durable.
     *
     * Accounts here can be signed into with a magic link and no password at all,
     * so someone holding a borrowed session could set one and keep entering by
     * password long after that session expired — while the real owner, back in
     * by magic link, would meet the current-password wall. Nothing recorded it
     * and nobody was told.
     *
     * The audit row makes it reviewable and the email makes it noticeable, which
     * is what turns a silent takeover into one the owner can report. Queued like
     * any other mail, so it respects the send hold.
     */
    await ctx.db.insert('auditLogs', {
      userId: user._id,
      userEmail: user.email,
      userRoles: user.roles,
      action: hadPassword ? 'user.password_changed' : 'user.password_set',
      tableName: 'users',
      recordId: user._id,
      success: true,
      createdAt: Date.now(),
    });

    await ctx.db.insert('emailQueue', {
      userId: user._id,
      emailType: 'password_changed',
      recipientEmail: user.email,
      subject: hadPassword ? 'Your ORBIT password was changed' : 'A password was set on your ORBIT account',
      bodyHtml:
        `<p>Hi ${escapeHtml(user.fullName ?? 'there')},</p>` +
        `<p>${hadPassword ? 'The password on your ORBIT account was just changed' : 'A password was just set on your ORBIT account'}. ` +
        `Every other signed-in device has been signed out.</p>` +
        `<p><strong>If this was not you</strong>, contact the ${escapeHtml(orgShortName())} team straight away — ` +
        `someone else may have had access to your account.</p>`,
      bodyText:
        `Hi ${user.fullName ?? 'there'},\n\n` +
        `${hadPassword ? 'The password on your ORBIT account was just changed' : 'A password was just set on your ORBIT account'}. ` +
        `Every other signed-in device has been signed out.\n\n` +
        `If this was not you, contact the ${orgShortName()} team straight away.\n`,
      status: 'pending',
      retryCount: 0,
      isDummy: false,
      createdAt: Date.now(),
    });

    return { success: true as const };
  },
});

/**
 * Issues a new temporary password. Replaces orbit_admin_reset_user_password.
 *
 * Returns the plaintext ONCE, to the admin who asked, and does NOT store it.
 *
 * It used to persist in `tempPassword` so it could be re-read from the user
 * record until first use. That is a cleartext credential at rest, readable by
 * every code path that fetches a raw user document, sitting in the same row as
 * the bcrypt hash whose entire purpose is that the password is not stored.
 * Production was carrying one when this was written. The convenience it bought —
 * an admin who closed the dialog without copying the password could look it up
 * again — is not worth that, and the recovery path is to reset again, which is
 * this same mutation.
 *

 * Every session the target holds is revoked. A password reset that leaves the
 * old sessions alive does not lock anyone out, which is usually the entire point
 * of resetting it.
 */
export const adminResetPassword = mutation({
  args: { token: v.string(), userId: v.id('users') },
  handler: async (ctx, { token, userId }) => {
    const admin = await requireAdmin(ctx, token);

    const target = await ctx.db.get(userId);
    if (!target) return { success: false as const, error: 'User not found' };

    // Same guard as adminSetActive: a plain admin must not be able to reset a
    // super admin's password and take their sessions with it.
    if (hasRole(target, 'super_admin') && !hasRole(admin, 'super_admin')) {
      return { success: false as const, error: 'Only a super admin can reset a super admin.' };
    }

    const temp = randomToken().slice(0, 12);
    const now = Date.now();

    await ctx.db.patch(userId, {
      passwordHash: bcrypt.hashSync(temp, 10),
      // Cleared, not written: any value already on the row is a cleartext
      // credential this reset makes obsolete anyway.
      tempPassword: undefined,
      updatedAt: now,
    });

    const sessions = await ctx.db
      .query('sessions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    for (const s of sessions) await ctx.db.delete(s._id);

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'admin.password_reset',
      tableName: 'users',
      recordId: userId,
      // The password itself is NOT recorded. An audit log that stores the
      // credential it is auditing is a credential store.
      newValues: { targetEmail: target.email, sessionsRevoked: sessions.length },
      success: true,
      createdAt: now,
    });

    return { success: true as const, tempPassword: temp, sessionsRevoked: sessions.length };
  },
});

/**
 * Sets a chosen password for a user. Replaces orbit_set_user_password.
 *
 * Super admin only, and deliberately narrower than the reset above: choosing
 * someone's password means knowing it, so this is for the account-recovery case
 * where a specific value has to be handed over out of band, not for routine use.
 */
export const adminSetPassword = mutation({
  args: { token: v.string(), userId: v.id('users'), newPassword: v.string() },
  handler: async (ctx, { token, userId, newPassword }) => {
    const admin = await requireUser(ctx, token);
    if (!hasRole(admin, 'super_admin')) {
      return { success: false as const, error: 'Only a super admin can set a password directly.' };
    }

    if (newPassword.length < 8) {
      return { success: false as const, error: 'Password must be at least 8 characters.' };
    }

    const target = await ctx.db.get(userId);
    if (!target) return { success: false as const, error: 'User not found' };

    const now = Date.now();

    await ctx.db.patch(userId, {
      passwordHash: bcrypt.hashSync(newPassword, 10),
      // Cleared, not set: the admin already knows this one, and leaving it in
      // `tempPassword` would make it readable from the user record afterwards.
      tempPassword: undefined,
      updatedAt: now,
    });

    const sessions = await ctx.db
      .query('sessions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    for (const s of sessions) await ctx.db.delete(s._id);

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'admin.password_set',
      tableName: 'users',
      recordId: userId,
      newValues: { targetEmail: target.email, sessionsRevoked: sessions.length },
      success: true,
      createdAt: now,
    });

    return { success: true as const, sessionsRevoked: sessions.length };
  },
});

export const adminCreateUser = mutation({
  args: {
    token: v.string(),
    email: v.string(),
    fullName: v.string(),
    roles: v.array(v.string()),
    streamId: v.optional(v.id('streams')),
    /**
     * Which programme an admin-created intern is on.
     *
     * Accounts made here never pass through intake, so nothing else can supply
     * it — and an intern with no programme type keeps no logbook (see
     * `userCarriesLogbook`). Optional, because moderators and admins are not
     * on a programme at all.
     */
    programmeType: v.optional(v.string()),
  },
  handler: async (ctx, { token, email, fullName, roles, streamId, programmeType }) => {
    // SUPER ADMIN ONLY, per 20251111145615 ("Only super admins can create
    // users"). Allowing plain admins let an admin manufacture peer admins,
    // which the original made impossible.
    const admin = await requireUser(ctx, token);
    if (!hasRole(admin, 'super_admin')) {
      return { success: false as const, error: 'Only a super admin can create users.' };
    }

    const allowed = ['intern', 'moderator', 'admin', 'super_admin'];
    if (roles.length === 0 || roles.some((r) => !allowed.includes(r))) {
      return { success: false as const, error: 'Invalid role.' };
    }
    // Checked, not trusted. `carriesLogbook` is case-sensitive by design, so a
    // stored 'SIWES' or a typo would silently mean "keeps no logbook" — the
    // failure would surface weeks later as an intern with no logbook tabs.
    // A programme describes a placement, so it belongs only to an intern.
    // Refused rather than dropped: a caller sending one for a moderator has
    // misunderstood something, and silently ignoring it hides that.
    if (programmeType && !roles.includes('intern')) {
      return {
        success: false as const,
        error: 'Only an intern can be given a programme.',
      };
    }
    if (programmeType && !PROGRAMME_TYPES.includes(programmeType as never)) {
      return {
        success: false as const,
        error: `Programme must be one of: ${PROGRAMME_TYPES.join(', ')}.`,
      };
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      return { success: false as const, error: 'Invalid email address.' };
    }
    if (fullName.trim().length < 2) {
      return { success: false as const, error: 'Name is too short.' };
    }

    const normalised = email.trim().toLowerCase();

    const clash = await ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', normalised))
      .unique();

    if (clash) return { success: false as const, error: 'A user with that email already exists.' };

    const temp = randomToken().slice(0, 12);
    const now = Date.now();

    const slugBase =
      fullName.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 40) ||
      normalised.split('@')[0];

    let slug = slugBase;
    for (let i = 1; ; i++) {
      const taken = await ctx.db
        .query('users')
        .withIndex('by_slug', (q) => q.eq('profileSlug', slug))
        .unique();
      if (!taken) break;
      slug = `${slugBase}-${i}`;
    }

    const id = await ctx.db.insert('users', {
      email: normalised,
      fullName,
      profileSlug: slug,
      passwordHash: bcrypt.hashSync(temp, 10),
      // NOT stored. The plaintext is returned to the creating admin once, below;
      // keeping a copy on the row is a cleartext credential at rest beside the
      // hash that exists so there is not one.
      roles,
      programmeType,
      currentStreamId: streamId,
      totalPoints: 0,
      currentLevel: 1,
      loginStreakCount: 0,
      isActive: true,
      mcpEnabled: false,
      profileVisibility: 'public',
      showEmail: false,
      showActivityOnFeed: true,
      showOnLeaderboard: true,
      isDummy: false,
      createdAt: now,
      updatedAt: now,
    });

    // Every account is usable as an intern profile from the moment it exists —
    // see lib/internProfile.ts. There is no second step for an admin to forget.
    await ensureInternProfile(ctx, id);

    /**
     * The MEMBERSHIP row, not just the pointer on the user.
     *
     * `currentStreamId` above is a denormalised convenience; every read that
     * matters resolves membership from `streamMemberships` instead —
     * `tasks.listForUser` scopes by it, `notifyNewTask` fans out over it, and
     * the roster, member counts, deadline-reminder cron and ICS feed all count
     * it. Setting only the pointer produced an intern whose profile named a
     * stream while they saw no tasks, appeared on no roster, received no task
     * notifications and had an empty calendar. Every other assignment path
     * (`streams.addMember`, `streams.join`, application conversion) writes this
     * row; this one silently did not.
     */
    if (streamId) await startMembership(ctx, streamId, id, admin._id, now);

    return { success: true as const, id, tempPassword: temp };
  },
});

/**
 * An admin editing ANOTHER user's profile fields.
 *
 * `updateMyProfile` is self-only, deliberately — it is the mutation a member
 * calls on themselves and it must never accept a target. That left the admin
 * Users page with an Edit form whose Full Name and Bio fields did nothing for
 * anyone but yourself: the modal reported success, closed, reloaded, and the
 * name was unchanged. Correcting a typo from a bulk import was impossible.
 *
 * Deliberately NARROW. Only the three display fields; roles, active state,
 * points, level and MCP access each have their own mutation with their own
 * check, and folding them in here would recreate the single any-column PATCH the
 * migration removed.
 */
export const adminUpdateProfile = mutation({
  args: {
    token: v.string(),
    userId: v.id('users'),
    fullName: v.optional(v.string()),
    bio: v.optional(v.string()),
    location: v.optional(v.string()),
  },
  handler: async (ctx, { token, userId, ...fields }) => {
    const admin = await requireAdmin(ctx, token);

    const target = await ctx.db.get(userId);
    if (!target) return { success: false as const, error: 'User not found' };

    // Same guard as the rest of the admin surface: a plain admin does not edit
    // a super admin's account.
    if (hasRole(target, 'super_admin') && !hasRole(admin, 'super_admin')) {
      return { success: false as const, error: 'Only a super admin can change a super admin.' };
    }

    if (fields.fullName !== undefined && fields.fullName.trim().length < 2) {
      return { success: false as const, error: 'Name is too short.' };
    }

    // Same bounds as the self-service edit. An admin typing into the same three
    // fields should not be able to store what a member cannot.
    const bounded = validate(() => ({
      fullName: optionalText(fields.fullName, 'Name', FIELD.fullName),
      bio: optionalText(fields.bio, 'Bio', FIELD.bio),
      location: optionalText(fields.location, 'Location', FIELD.location),
    }));
    if (!bounded.ok) return { success: false as const, error: bounded.error };

    const clean = Object.fromEntries(
      Object.entries(bounded.value).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(clean).length === 0) return { success: true as const };

    const now = Date.now();
    await ctx.db.patch(userId, { ...clean, updatedAt: now });

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      action: 'admin.profile_updated',
      tableName: 'users',
      recordId: userId,
      oldValues: { fullName: target.fullName, bio: target.bio, location: target.location },
      newValues: clean,
      success: true,
      createdAt: now,
    });

    return { success: true as const };
  },
});

export const adminSetRoles = mutation({
  args: { token: v.string(), userId: v.id('users'), roles: v.array(v.string()) },
  handler: async (ctx, { token, userId, roles }) => {
    const admin = await requireAdmin(ctx, token);

    /**
     * The same allow-list `adminCreateUser` applies.
     *
     * `roles` is `v.array(v.string())`, so without this an arbitrary string was
     * written to the row verbatim — and `hasRole` matches by exact string, so a
     * typo ('Admin', 'moderater') silently produces an account with no
     * effective role and no error saying so.
     */
    const allowed = ['intern', 'moderator', 'admin', 'super_admin'];
    if (roles.length === 0 || roles.some((r) => !allowed.includes(r))) {
      return { success: false as const, error: 'Invalid role.' };
    }

    const target = await ctx.db.get(userId);
    if (!target) return { success: false as const, error: 'User not found' };

    /**
     * `super_admin` is neither granted nor revoked from here — not by an admin,
     * and not by another super_admin.
     *
     * It is the role that can rewrite every other role, so the account holding
     * it is the one worth stealing. Letting a super_admin mint peers meant one
     * compromised session could establish permanent, independent access before
     * anyone noticed, and strip the real owner on the way out. The only route
     * left is an internalMutation run with deployment credentials — owner-level
     * access to the database already, and unreachable from a browser, an MCP
     * session or any HTTP route.
     *
     * The awkwardness is the feature: this roster should change about once a
     * year, and only by someone who can already read the whole database.
     *
     * Both directions are closed. Revocation matters as much as granting: a
     * session that could demote the owner could inherit the platform.
     */
    if (roles.includes('super_admin') && !hasRole(target, 'super_admin')) {
      return {
        success: false as const,
        error:
          'super_admin cannot be granted through the app. It is set with deployment credentials — see SECURITY.md.',
      };
    }
    if (hasRole(target, 'super_admin') && !roles.includes('super_admin')) {
      return {
        success: false as const,
        error:
          'super_admin cannot be revoked through the app. It is removed with deployment credentials — see SECURITY.md.',
      };
    }

    /**
     * Granting `admin` is a super_admin act, exactly as CREATING one is.
     *
     * `adminCreateUser` is locked to super_admin with the explicit reasoning
     * that "allowing plain admins let an admin manufacture peer admins, which
     * the original made impossible" — but this mutation reached the same end by
     * another route: a plain admin promoted any existing intern to `admin` in
     * one call. Closing it there and leaving it open here made the restriction
     * a speed bump rather than a boundary.
     *
     * Gated on the TRANSITION into admin, not on the word appearing: adding
     * `intern`/`moderator` to someone who is already an admin is not a grant,
     * and those are roles a plain admin may give anyone.
     *
     * Only the GRANT is gated. A plain admin may still demote an admin, and the
     * self-demotion guard below still protects them from doing it to
     * themselves — locking both directions would mean a lone plain admin could
     * not clean up after a departing colleague.
     */
    if (roles.includes('admin') && !hasRole(target, 'admin') && !hasRole(admin, 'super_admin')) {
      return { success: false as const, error: 'Only a super admin can grant admin.' };
    }

    /**
     * The same protection on the way DOWN as on the way up.
     *
     * Granting super_admin was guarded and removing it was not, which made this
     * a one-way demotion any plain admin could perform on the platform owner.
     * `adminSetActive` and `adminTrashUser` both refuse to touch a super_admin
     * from an admin session — but they did not have to be defeated, because a
     * demotion first made the target an ordinary user, and then both of them
     * allowed it. Together that is a complete lockout primitive: strip the
     * owner's role, deactivate them, and no one can undo it, since restoring
     * super_admin requires a super_admin.
     */

    if (hasRole(target, 'super_admin') && !hasRole(admin, 'super_admin')) {
      return { success: false as const, error: 'Only a super admin can change a super admin.' };
    }

    // An admin removing their own admin role would lock themselves out mid-session.
    if (target._id === admin._id && !roles.some((r) => ['admin', 'super_admin'].includes(r))) {
      return { success: false as const, error: 'You cannot remove your own admin role.' };
    }

    const now = Date.now();
    await ctx.db.patch(userId, { roles, updatedAt: now });

    // `adminSetMcpAccess` refuses to grant MCP access to a non-admin. Demotion
    // has to maintain the same invariant, or the flag survives the demotion:
    // the account is no longer an admin but still reads `mcpEnabled: true`, and
    // re-promoting it later silently restores MCP eligibility with no explicit
    // grant and nothing in the audit log saying so.
    let mcpRevoked = 0;
    const stillAdmin = roles.some((r) => ['admin', 'super_admin'].includes(r));

    if (!stillAdmin && target.mcpEnabled) {
      await ctx.db.patch(userId, { mcpEnabled: false });

      const sessions = await ctx.db
        .query('sessions')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect();

      // Only the MCP ones. A demotion is not a sign-out, and the browser session
      // re-reads roles on every call anyway.
      for (const s of sessions) {
        if (s.isMcp) {
          await ctx.db.delete(s._id);
          mcpRevoked++;
        }
      }
    }

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      action: 'admin.roles_changed',
      tableName: 'users',
      recordId: userId,
      oldValues: { roles: target.roles, mcpEnabled: target.mcpEnabled },
      newValues: { roles, mcpEnabled: stillAdmin ? target.mcpEnabled : false, mcpRevoked },
      success: true,
      createdAt: now,
    });

    return { success: true as const, mcpRevoked };
  },
});

export const adminSetActive = mutation({
  args: { token: v.string(), userId: v.id('users'), isActive: v.boolean() },
  handler: async (ctx, { token, userId, isActive }) => {
    const admin = await requireAdmin(ctx, token);

    if (userId === admin._id && !isActive) {
      return { success: false as const, error: 'You cannot deactivate yourself.' };
    }

    // A plain admin must not be able to deactivate a super_admin and kill their
    // sessions — combined with role editing that is a lock-out primitive.
    const subject = await ctx.db.get(userId);
    if (subject && hasRole(subject, 'super_admin') && !hasRole(admin, 'super_admin')) {
      return { success: false as const, error: 'Only a super admin can change a super admin.' };
    }

    const now = Date.now();
    await ctx.db.patch(userId, { isActive, updatedAt: now });

    // Deactivating must also end the user's sessions, or they keep working until
    // natural expiry — up to seven days after being disabled.
    let sessionsRevoked = 0;
    if (!isActive) {
      const sessions = await ctx.db
        .query('sessions')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect();
      for (const s of sessions) await ctx.db.delete(s._id);
      sessionsRevoked = sessions.length;
    }

    /**
     * AUDITED. It was not, and it sits directly beside adminSetRoles, which is.
     *
     * This mutation locks someone out of the platform and destroys every session
     * they hold. If it is ever done wrongly — by mistake, or by an account that
     * should not have been able to — the audit log was the only place that would
     * have said who did it and when, and it said nothing. "Nobody can explain
     * why this person lost access" is the incident this prevents.
     */
    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: isActive ? 'admin.user_activated' : 'admin.user_deactivated',
      tableName: 'users',
      recordId: userId,
      oldValues: { isActive: subject?.isActive },
      newValues: { isActive, targetEmail: subject?.email, sessionsRevoked },
      success: true,
      createdAt: now,
    });

    return { success: true as const };
  },
});

/**
 * The fuller user record an admin tool needs, without the secrets.
 *
 * `getById` returns the directory shape, which deliberately omits social links,
 * streak and timestamps. The MCP `get_user` tool showed those, so rather than
 * widen the shape every member sees, this is a separate admin-gated view.
 *
 * passwordHash, tempPassword and calendarFeedToken are absent by construction —
 * this builds a literal rather than spreading the document, so a field added to
 * the schema later cannot leak through here by default.
 */
export const adminGetById = query({
  args: { token: v.string(), userId: v.id('users') },
  handler: async (ctx, { token, userId }) => {
    await requireAdmin(ctx, token);

    const u = await ctx.db.get(userId);
    if (!u) return null;

    return {
      id: u._id,
      legacyId: u.legacyId,
      email: u.email,
      fullName: u.fullName,
      profileSlug: u.profileSlug,
      profilePhotoUrl: u.profilePhotoUrl,
      coverPhotoUrl: u.coverPhotoUrl,
      bio: u.bio,
      location: u.location,
      socialLinks: u.socialLinks,
      roles: u.roles,
      currentStreamId: u.currentStreamId,
      totalPoints: u.totalPoints,
      currentLevel: u.currentLevel,
      loginStreakCount: u.loginStreakCount,
      isActive: u.isActive,
      isDeleted: u.isDeleted ?? false,
      mcpEnabled: u.mcpEnabled,
      profileVisibility: u.profileVisibility,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
    };
  },
});

/**
 * Grants or revokes MCP access. Was `orbit_toggle_mcp_access`.
 *
 * Revoking DELETES the account's live MCP sessions. Without that the flag is
 * advisory: `mcp.authenticate` refuses to mint a new session, but the one
 * already in the agent's environment keeps working until it expires. The old
 * server never rechecked at all — it read `mcp_enabled` once at startup, so
 * revocation did nothing at all until somebody restarted the process.
 *
 * Human sessions are left alone; the two are distinguished by `isMcp`.
 */
export const adminSetMcpAccess = mutation({
  args: { token: v.string(), userId: v.id('users'), enabled: v.boolean() },
  handler: async (ctx, { token, userId, enabled }) => {
    const admin = await requireAdmin(ctx, token);

    const target = await ctx.db.get(userId);
    if (!target) return { success: false as const, error: 'User not found' };

    // Same guard adminSetActive uses: a plain admin must not be able to reach
    // into a super_admin's account.
    if (hasRole(target, 'super_admin') && !hasRole(admin, 'super_admin')) {
      return { success: false as const, error: 'Only a super admin can change a super admin.' };
    }

    // MCP access is only meaningful on an admin account — mcp.authenticate
    // refuses anything less. Granting it to an intern would look like it worked
    // and silently never function.
    if (enabled && !hasRole(target, 'admin', 'super_admin')) {
      return {
        success: false as const,
        error: 'MCP access requires an admin or super_admin account.',
      };
    }

    const now = Date.now();
    await ctx.db.patch(userId, { mcpEnabled: enabled, updatedAt: now });

    let revoked = 0;
    if (!enabled) {
      const sessions = await ctx.db
        .query('sessions')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect();
      for (const s of sessions) {
        if (s.isMcp) {
          await ctx.db.delete(s._id);
          revoked++;
        }
      }
    }

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: enabled ? 'admin.mcp_access_granted' : 'admin.mcp_access_revoked',
      tableName: 'users',
      recordId: userId,
      oldValues: { mcpEnabled: target.mcpEnabled },
      newValues: { mcpEnabled: enabled, sessionsRevoked: revoked },
      success: true,
      createdAt: now,
    });

    return { success: true as const, revoked };
  },
});

// ------------------------------------------------------------------- trash
//
// Replaces trash_user / restore_user_from_trash / permanently_delete_user.
//
// The soft-delete pair are straightforward. The permanent delete is not, and the
// Postgres original did not work: it deleted twelve tables and then
// `DELETE FROM orbit_users`, but `streams.created_by`, `tasks.created_by`,
// `stream_memberships.assigned_by`, `submissions.reviewed_by`,
// `points_ledger.created_by` and `admin_settings.updated_by` are all RESTRICT
// foreign keys. So for anyone who had ever created a stream or task, assigned a
// member, reviewed a submission or awarded points — i.e. every admin and
// moderator — the whole function aborted and returned a raw SQLERRM string.
// It only ever succeeded for interns.
//
// Convex has no foreign keys at all, so the same code here would SUCCEED and
// leave dangling `v.id('users')` references behind: `ctx.db.get()` returns null
// for them, so streams would render with no creator and tasks with no author,
// silently and permanently.
//
// This keeps the Postgres behaviour and makes it legible: content the user
// AUTHORED for the platform blocks deletion, and the caller is told exactly what
// and how much. Content the user OWNS is deleted.

/**
 * Fields on other tables that point at a user as author/actor rather than owner.
 * A row here belongs to the platform, so deleting the user cannot delete it.
 */
const AUTHORSHIP_REFERENCES = [
  { table: 'streams', field: 'createdBy', label: 'streams created' },
  { table: 'tasks', field: 'createdBy', label: 'tasks created' },
  { table: 'cohorts', field: 'createdBy', label: 'cohorts created' },
  { table: 'departments', field: 'leadUserId', label: 'departments led' },
  { table: 'streamMemberships', field: 'assignedBy', label: 'stream assignments made' },
  { table: 'streamModerators', field: 'assignedBy', label: 'moderators appointed' },
  { table: 'submissions', field: 'reviewedBy', label: 'submissions reviewed' },
  { table: 'pointsLedger', field: 'createdBy', label: 'points awards made' },
  { table: 'adminSettings', field: 'updatedBy', label: 'settings changed' },
  { table: 'dailyLogs', field: 'reviewedBy', label: 'daily logs reviewed' },
  { table: 'weeklySummaries', field: 'signedOffBy', label: 'weekly summaries signed off' },
  { table: 'attendanceRecords', field: 'verifiedBy', label: 'attendance records verified' },
  { table: 'supervisorNotes', field: 'authorId', label: 'supervisor notes written' },
  { table: 'users', field: 'iihSupervisorId', label: 'interns supervised' },
  { table: 'logbookExports', field: 'exportedBy', label: 'logbook exports run' },
  { table: 'applications', field: 'reviewedBy', label: 'applications reviewed' },
  { table: 'users', field: 'deletedBy', label: 'other users trashed' },
] as const;

/**
 * Fields that point at the user but sit on rows that outlive them, and are not
 * authorship worth blocking a delete over. The reference is cleared instead.
 *
 * Both were missed on the first pass and would have become dangling ids: a
 * rateLimits row keeping an IP tied to a deleted person, and a blockedIps row
 * whose `blockedBy` read null forever.
 */
const REFERENCES_TO_CLEAR = [
  { table: 'rateLimits', field: 'userId', index: 'by_user' },
  { table: 'blockedIps', field: 'blockedBy', index: 'by_blockedBy' },
] as const;

/**
 * Tables whose rows belong to the user and go with them.
 *
 * Split by whether the table carries a `by_user` index. The indexed ones are
 * also the ones that grow without bound — posts, messages, notifications, the
 * points ledger — so reading them through the index is what keeps this function
 * inside Convex's per-transaction read limit. Collecting all of them was fine at
 * today's few hundred rows and would have made permanent deletion impossible
 * (not slow — impossible, since the whole mutation would throw) somewhere in the
 * low tens of thousands.
 */
const OWNED_BY_USER_INDEXED = [
  'oauthExchangeCodes',
  'postLikes',
  'comments',
  'reactions',
  'activityFeed',
  'streamChat',
  'emailQueue',
  'sessions',
  'magicLinks',
  'streamMemberships',
  'streamModerators',
  'userBadges',
  'pointsLedger',
  'weeklyLeaderboard',
  'submissions',
  'posts',
  'postReplies',
  'notifications',
  'notificationPreferences',
] as const;

/**
 * The rest. These have no `by_user` index and are scanned.
 *
 * Deliberate: `postLikes`, `comments` and `reactions` are indexed by their
 * TARGET because that is what every hot path needs, and adding a second index to
 * each purely for an admin operation that runs a handful of times a year is the
 * wrong trade. `oauthExchangeCodes` and `emailQueue` are swept by crons and stay
 * small. If any of these ever grows past ~10k rows, index it rather than
 * accepting a delete that cannot run.
 */
/**
 * EMPTY, and it should stay that way.
 *
 * Every table that used to be here is now indexed on `userId` and handled
 * above. `emailQueue` was the expensive one: its rows carry complete HTML email
 * bodies, so scanning the table to find one user's rows dominated the whole
 * 16MB transaction budget and pushed permanent deletion to within 1MB of
 * failing outright — at which point it does not get slower, it stops working.
 *
 * Anything added here needs a `by_user` index and a place in the list above.
 */
const OWNED_BY_USER_SCANNED = [] as const;

export const adminTrashUser = mutation({
  args: { token: v.string(), userId: v.id('users') },
  handler: async (ctx, { token, userId }) => {
    const admin = await requireUser(ctx, token);
    if (!hasRole(admin, 'super_admin')) {
      return { success: false as const, error: 'Only a super admin can trash users.' };
    }
    if (admin._id === userId) {
      return { success: false as const, error: 'You cannot trash yourself.' };
    }

    const target = await ctx.db.get(userId);
    if (!target) return { success: false as const, error: 'User not found' };
    if (target.isDeleted) return { success: false as const, error: 'User is already in the trash.' };

    const now = Date.now();
    await ctx.db.patch(userId, {
      isDeleted: true,
      deletedAt: now,
      deletedBy: admin._id,
      isActive: false,
      updatedAt: now,
    });

    // Sessions go with it. The Postgres version set is_active = false and left
    // every session alive, so a trashed user kept working for up to seven days —
    // `userFromToken` rejects them now, but deleting the rows is what makes the
    // revocation observable rather than incidental.
    const sessions = await ctx.db
      .query('sessions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    for (const s of sessions) await ctx.db.delete(s._id);

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'admin.user_trashed',
      tableName: 'users',
      recordId: userId,
      newValues: { email: target.email, sessionsRevoked: sessions.length },
      success: true,
      createdAt: now,
    });

    return { success: true as const, sessionsRevoked: sessions.length };
  },
});

export const adminRestoreUser = mutation({
  args: { token: v.string(), userId: v.id('users') },
  handler: async (ctx, { token, userId }) => {
    const admin = await requireUser(ctx, token);
    if (!hasRole(admin, 'super_admin')) {
      return { success: false as const, error: 'Only a super admin can restore users.' };
    }

    const target = await ctx.db.get(userId);
    if (!target) return { success: false as const, error: 'User not found' };
    if (!target.isDeleted) return { success: false as const, error: 'User is not in the trash.' };

    const now = Date.now();
    await ctx.db.patch(userId, {
      isDeleted: false,
      deletedAt: undefined,
      deletedBy: undefined,
      isActive: true,
      updatedAt: now,
    });

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'admin.user_restored',
      tableName: 'users',
      recordId: userId,
      newValues: { email: target.email },
      success: true,
      createdAt: now,
    });

    return { success: true as const };
  },
});

/** Users currently in the trash, so the admin UI has something to restore from. */
export const adminListTrash = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const admin = await requireUser(ctx, token);
    if (!hasRole(admin, 'super_admin')) throw new Error('Only a super admin can view the trash.');

    const users = await ctx.db.query('users').collect();
    const out = [];

    for (const u of users.filter((x) => x.isDeleted)) {
      const by = u.deletedBy ? await ctx.db.get(u.deletedBy) : null;
      out.push({
        id: u._id,
        email: u.email,
        fullName: u.fullName,
        roles: u.roles,
        deletedAt: u.deletedAt,
        deletedBy: by ? { id: by._id, fullName: by.fullName } : null,
      });
    }
    return out.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  },
});

/**
 * Reports what a permanent delete would remove, and what blocks it.
 *
 * Separate from the delete itself so the UI can warn before asking, and so
 * "why can't I delete this user" has an answer that is not an FK error string.
 */
export const adminDeletionReport = query({
  args: { token: v.string(), userId: v.id('users') },
  handler: async (ctx, { token, userId }) => {
    const admin = await requireUser(ctx, token);
    if (!hasRole(admin, 'super_admin')) throw new Error('Only a super admin can delete users.');
    return buildDeletionReport(ctx, userId);
  },
});

async function buildDeletionReport(ctx: QueryCtx | MutationCtx, userId: Id<'users'>) {
  const blockers: Array<{ label: string; count: number }> = [];

  /*
   * The `any`s from here to the end of the delete machinery are load-bearing,
   * not laziness.
   *
   * AUTHORSHIP_REFERENCES and OWNERSHIP_REFERENCES hold table and field names as
   * DATA, because the alternative is the same twenty-line block copied per table
   * and a new table silently missed when someone adds one. Convex's generated
   * types describe `ctx.db.query('submissions')` — a literal — and cannot
   * describe `ctx.db.query(someString)`. Typing this properly would mean a
   * mapped type over the whole schema for the benefit of one admin operation.
   *
   * The scope is deliberately the dynamic region only, so an `any` anywhere else
   * in this file still fails lint.
   */
  /* eslint-disable @typescript-eslint/no-explicit-any */

  // Every authorship table that grows without bound has an index for exactly
  // this lookup. Keyed by `table.field`, not by table alone: `users` appears
  // twice with different fields, and keying by table would have silently
  // applied `by_supervisor` to the `deletedBy` pass as well.
  //
  // What is left on the scan branch is only genuinely small and bounded:
  // streams, cohorts, departments, adminSettings, streamModerators,
  // supervisorNotes and logbookExports stay in the tens or low hundreds, so an
  // index that exists solely for an admin operation running a handful of times
  // a year is not worth its write cost. The tables that do NOT stay small are
  // the ones indexed below — attendanceRecords and weeklySummaries are written
  // by crons once per intern per day and per week, so at a 200-intern intake
  // they pass ten thousand rows inside a year. Scanning them here was the same
  // hazard the owned-row loop was rebuilt to remove: this report runs INSIDE
  // adminPermanentlyDeleteUser's transaction, so a scan that outgrows the
  // 16,384-document budget does not make deletion slow, it makes it impossible.
  // Full-table reads also put every row of those tables in the transaction's
  // read set, so any concurrent write to them was an OCC conflict that forced
  // the whole delete to retry.
  const INDEXED_AUTHORSHIP: Record<string, string> = {
    'submissions.reviewedBy': 'by_reviewer',
    'pointsLedger.createdBy': 'by_creator',
    'streamMemberships.assignedBy': 'by_assigner',
    'dailyLogs.reviewedBy': 'by_reviewer',
    'weeklySummaries.signedOffBy': 'by_signatory',
    'attendanceRecords.verifiedBy': 'by_verifier',
    'applications.reviewedBy': 'by_reviewer',
    'tasks.createdBy': 'by_creator',
    'users.iihSupervisorId': 'by_supervisor',
    'users.deletedBy': 'by_deleter',
  };

  for (const { table, field, label } of AUTHORSHIP_REFERENCES) {
    const index = INDEXED_AUTHORSHIP[`${table}.${field}`];

    const rows = index
      ? await ctx.db
          .query(table as any)
          .withIndex(index as any, (q: any) => q.eq(field, userId))
          .collect()
      : await ctx.db.query(table as any).collect();

    // The `_id !== userId` guard has to survive the indexed path too: on the
    // `users` passes a row pointing at itself is the account being deleted, not
    // a blocker.
    const count = rows.filter((r: any) => r[field] === userId && r._id !== userId).length;

    if (count > 0) blockers.push({ label, count });
  }

  const owned: Array<{ table: string; count: number }> = [];

  for (const table of OWNED_BY_USER_INDEXED) {
    const rows = await ctx.db
      .query(table)
      .withIndex('by_user', (q: any) => q.eq('userId', userId))
      .collect();
    if (rows.length > 0) owned.push({ table, count: rows.length });
  }

  for (const table of OWNED_BY_USER_SCANNED) {
    const rows = await ctx.db.query(table as any).collect();
    const count = rows.filter((r: any) => r.userId === userId).length;
    if (count > 0) owned.push({ table, count });
  }

  const sent = await ctx.db.query('messages').withIndex('by_sender', (q) => q.eq('senderId', userId)).collect();
  const received = await ctx.db.query('messages').withIndex('by_recipient', (q) => q.eq('recipientId', userId)).collect();
  const messageCount = new Set([...sent, ...received].map((m) => String(m._id))).size;
  if (messageCount) owned.push({ table: 'messages', count: messageCount });

  const asUser = await ctx.db.query('friendships').withIndex('by_user', (q) => q.eq('userId', userId)).collect();
  const asFriend = await ctx.db.query('friendships').withIndex('by_friend', (q) => q.eq('friendId', userId)).collect();
  const friendshipCount = new Set([...asUser, ...asFriend].map((f) => String(f._id))).size;
  if (friendshipCount) owned.push({ table: 'friendships', count: friendshipCount });

  return { blockers, owned, canDelete: blockers.length === 0 };
}

export const adminPermanentlyDeleteUser = mutation({
  args: { token: v.string(), userId: v.id('users') },
  handler: async (ctx, { token, userId }) => {
    const admin = await requireUser(ctx, token);
    if (!hasRole(admin, 'super_admin')) {
      return { success: false as const, error: 'Only a super admin can permanently delete users.' };
    }
    if (admin._id === userId) {
      return { success: false as const, error: 'You cannot delete yourself.' };
    }

    const target = await ctx.db.get(userId);
    if (!target) return { success: false as const, error: 'User not found' };

    // Trash first, as before. It is the only confirmation step this has.
    if (!target.isDeleted) {
      return {
        success: false as const,
        error: 'User must be in the trash before permanent deletion. Move them to trash first.',
      };
    }

    const report = await buildDeletionReport(ctx, userId);

    if (!report.canDelete) {
      const detail = report.blockers.map((b) => `${b.count} ${b.label}`).join(', ');
      return {
        success: false as const,
        error:
          `${target.fullName} authored platform content that would be orphaned: ${detail}. ` +
          `Deleting them would leave those records pointing at a user that no longer exists. ` +
          `Leave them in the trash, or reassign the content first.`,
        blockers: report.blockers,
      };
    }

    let removed = 0;

    // Captured BEFORE the sweep below deletes them — their children are found by
    // parent id, which stops resolving the moment the parent is gone.
    const postsToRemove = await ctx.db
      .query('posts')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    const submissionsToRemove = await ctx.db
      .query('submissions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();

    for (const table of OWNED_BY_USER_INDEXED) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_user', (q: any) => q.eq('userId', userId))
        .collect();
      for (const row of rows) {
        await ctx.db.delete(row._id);
        removed++;
      }
    }

    for (const table of OWNED_BY_USER_SCANNED) {
      const rows = await ctx.db.query(table as any).collect();
      for (const row of rows.filter((r: any) => r.userId === userId)) {
        await ctx.db.delete(row._id);
        removed++;
      }
    }

    // Two-sided tables: the user is on either end. Both directions are indexed,
    // so this is two range reads rather than two full scans.
    const seen = new Set<string>();
    for (const [index, field] of [['by_sender', 'senderId'], ['by_recipient', 'recipientId']] as const) {
      for (const m of await ctx.db
        .query('messages')
        .withIndex(index, (q: any) => q.eq(field, userId))
        .collect()) {
        if (seen.has(m._id)) continue;
        seen.add(m._id);
        await ctx.db.delete(m._id);
        removed++;
      }
    }

    const seenFriendships = new Set<string>();
    for (const [index, field] of [['by_user', 'userId'], ['by_friend', 'friendId']] as const) {
      for (const f of await ctx.db
        .query('friendships')
        .withIndex(index, (q: any) => q.eq(field, userId))
        .collect()) {
        if (seenFriendships.has(f._id)) continue;
        seenFriendships.add(f._id);
        await ctx.db.delete(f._id);
        removed++;
      }
    }

    // Other people's notifications that point AT this user. The Postgres version
    // deleted notifications by user_id only, so a "X sent you a message"
    // notification survived the deletion of X and rendered with a null actor.
    // No index on relatedUserId, so this one is a scan — notifications are the
    // fastest-growing table here, and it is the reason this function has a
    // documented row ceiling rather than none.
    for (const n of await ctx.db
      .query('notifications')
      .withIndex('by_relatedUser', (q) => q.eq('relatedUserId', userId))
      .collect()) {
      await ctx.db.delete(n._id);
      removed++;
    }

    // The SIWES tree hangs off the account directly now, so one pass per table
    // clears it. It used to hang off internProfiles, which meant deleting by
    // userId alone stranded every log, summary, attendance record and note.
    for (const table of ['dailyLogs', 'weeklySummaries', 'attendanceRecords', 'supervisorNotes', 'logbookExports'] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect();
      for (const row of rows) {
        await ctx.db.delete(row._id);
        removed++;
      }
    }

    /**
     * Indexed, not scanned. `rateLimits` in particular is written on every
     * sign-in, upload and application submission, so reading all of it to find
     * one user's rows put this mutation within 1MB of the transaction limit —
     * past which permanent deletion does not get slower, it stops working.
     */
    for (const { table, field, index } of REFERENCES_TO_CLEAR) {
      const rows = await ctx.db
        .query(table as any)
        .withIndex(index as any, (q: any) => q.eq(field, userId))
        .collect();

      for (const row of rows) {
        await ctx.db.patch(row._id, { [field]: undefined } as any);
        removed++;
      }
    }

    /* eslint-enable @typescript-eslint/no-explicit-any */

    // Other people's likes, replies, comments and reactions ON the deleted
    // user's posts. Deleting the post alone leaves those pointing at a post id
    // that no longer resolves — and orphaned postReplies keep counting toward
    // their authors' `consistency` badge against a post nobody can open.
    // `posts.remove` already does this cascade; the delete path had to as well.
    for (const post of postsToRemove) {
      for (const child of ['postLikes', 'postReplies'] as const) {
        const rows = await ctx.db
          .query(child)
          .withIndex('by_post', (q) => q.eq('postId', post._id))
          .collect();
        for (const row of rows) {
          await ctx.db.delete(row._id);
          removed++;
        }
      }
      for (const child of ['comments', 'reactions'] as const) {
        const rows = await ctx.db
          .query(child)
          .withIndex('by_target', (q) => q.eq('targetType', 'post').eq('targetId', post._id))
          .collect();
        for (const row of rows) {
          await ctx.db.delete(row._id);
          removed++;
        }
      }
    }

    // Same for comments and reactions hanging off their submissions — the only
    // live consumer of `comments` targets submissions, not posts.
    for (const submission of submissionsToRemove) {
      for (const child of ['comments', 'reactions'] as const) {
        const rows = await ctx.db
          .query(child)
          .withIndex('by_target', (q) => q.eq('targetType', 'submission').eq('targetId', submission._id))
          .collect();
        for (const row of rows) {
          await ctx.db.delete(row._id);
          removed++;
        }
      }
    }

    /**
     * THE BLOBS, which nothing released.
     *
     * Every table above deletes rows. Convex storage is not rows: `ctx.storage`
     * objects are billed per byte and are never reclaimed on their own, so the
     * cascade removed each post and submission and left its image or file behind
     * forever, unreferenced and unfindable. `uploads` was not in
     * OWNED_BY_USER_INDEXED either — despite having a by_user index — so the
     * claim rows survived too, with `attached: true`, which is precisely the
     * state the unattached-upload reaper is written to ignore. Permanent
     * deletion was the one operation guaranteed to leak, and the leak was
     * invisible in the row counts it reported.
     *
     * Deleted last, after every row that could reference them, so a failure
     * earlier in the mutation rolls the whole thing back rather than destroying
     * files whose rows survived.
     */
    let blobsReleased = 0;
    const uploadClaims = await ctx.db
      .query('uploads')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();

    /**
     * A claim records who UPLOADED an object, not what owns it, and those come
     * apart. `files.setStreamPhoto` claims a stream's cover image under the
     * moderator who uploaded it, and streams are not user-owned — nothing above
     * deletes them. Releasing every claim blindly would delete a live stream's
     * cover and leave a dangling `coverImageId` and a broken image for every
     * member of it. So the objects still referenced by surviving rows are
     * excluded, and the claim rows go regardless: the claim's only job is to let
     * the reaper find unattached uploads, and a deleted uploader has no more
     * uploads to reap.
     */
    const stillReferenced = new Set<string>();
    for (const stream of await ctx.db.query('streams').collect()) {
      if (stream.coverImageId) stillReferenced.add(String(stream.coverImageId));
    }

    for (const claim of uploadClaims) {
      if (!stillReferenced.has(String(claim.storageId))) {
        // Best effort on the object, unconditional on the claim below: an object
        // that is already gone must not strand its claim row, which would leave
        // the exact orphan this block exists to prevent.
        try {
          await ctx.storage.delete(claim.storageId);
          blobsReleased++;
        } catch {
          // Already deleted, or never stored. Nothing to reclaim.
        }
      }
      await ctx.db.delete(claim._id);
      removed++;
    }

    // Audit rows are KEPT, with the id cleared. They are the record of what was
    // done on the platform, including to this user; deleting them would erase
    // the trail at exactly the moment it matters. userEmail is already denormalised
    // on the row, so it stays readable.
    let auditRedacted = 0;
    for (const a of await ctx.db.query('auditLogs').withIndex('by_user', (q) => q.eq('userId', userId)).collect()) {
      await ctx.db.patch(a._id, { userId: undefined });
      auditRedacted++;
    }

    const email = target.email;
    await ctx.db.delete(userId);

    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'admin.user_permanently_deleted',
      tableName: 'users',
      recordId: userId,
      oldValues: { email, fullName: target.fullName, roles: target.roles },
      newValues: { rowsRemoved: removed, auditRowsRedacted: auditRedacted, blobsReleased },
      success: true,
      createdAt: Date.now(),
    });

    return { success: true as const, rowsRemoved: removed, auditRowsRedacted: auditRedacted, blobsReleased };
  },
});

export const me = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => publicUser(await requireUser(ctx, token)),
});

/**
 * Everything the "My ORBIT" dashboard shows about the caller, in one query.
 *
 * The page assembled this from SIX separate reads the browser ran straight
 * against the tables: a count of approved submissions, the points ledger for a
 * weekly chart, and four `head: true` counts over posts, replies, likes and
 * memberships. Every one of them was a filter the browser chose, on tables
 * without RLS, so any of them could be pointed at another user by changing an
 * id — the dashboard was a general-purpose reader for anyone's activity.
 *
 * Scoped to the session here, so there is no id to change.
 */
export const myStats = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);

    const [submissions, posts, replies, memberships] = await Promise.all([
      ctx.db.query('submissions').withIndex('by_user', (q) => q.eq('userId', user._id)).collect(),
      ctx.db.query('posts').withIndex('by_user', (q) => q.eq('userId', user._id)).collect(),
      ctx.db.query('postReplies').withIndex('by_user', (q) => q.eq('userId', user._id)).collect(),
      ctx.db
        .query('streamMemberships')
        .withIndex('by_user', (q) => q.eq('userId', user._id))
        .collect(),
    ]);

    // Likes RECEIVED, which is what the label says. The page counted rows in
    // orbit_post_likes where user_id was the caller — the likes they GAVE.
    let likesReceived = 0;
    for (const post of posts) {
      const likes = await ctx.db
        .query('postLikes')
        .withIndex('by_post', (q) => q.eq('postId', post._id))
        .collect();
      likesReceived += likes.filter((l) => l.userId !== user._id).length;
    }

    // Seven days ending today, one bucket per calendar day, zero-filled — the
    // chart needs every day present, and the browser was building the empty
    // buckets itself and merging ledger rows into them.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const since = startOfToday.getTime() - 6 * 86_400_000;

    const ledger = await ctx.db
      .query('pointsLedger')
      .withIndex('by_user_and_time', (q) => q.eq('userId', user._id).gte('createdAt', since))
      .collect();

    const weekly: { date: string; points: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(since + i * 86_400_000);
      weekly.push({ date: day.toISOString().split('T')[0], points: 0 });
    }
    for (const entry of ledger) {
      const key = new Date(entry.createdAt).toISOString().split('T')[0];
      const bucket = weekly.find((w) => w.date === key);
      if (bucket) bucket.points += entry.points;
    }

    return {
      tasksCompleted: submissions.filter((s) => s.status === 'approved').length,
      tasksSubmitted: submissions.filter((s) => s.status !== 'draft' && s.status !== 'in_progress')
        .length,
      posts: posts.length,
      comments: replies.length,
      likesReceived,
      streamMemberships: memberships.filter((m) => m.isActive).length,
      weekly,
    };
  },
});

/**
 * Gives every existing account an intern profile.
 *
 * New accounts get one at creation; this is for the ones that predate that.
 * Idempotent — ensureInternProfile returns the existing profile untouched — so
 * it is safe to run repeatedly, which matters because it is also the recovery
 * path for accounts created while no cohort existed.
 */
/**
 * Fills in `programmeType` for accounts converted before it was recorded.
 *
 * The value has always existed on the application; it simply was not copied to
 * the user, so every intern already on the platform looks like an unknown
 * programme. Reading it back from `applications.convertedUserId` recovers it
 * exactly rather than guessing.
 *
 * Anyone this cannot resolve — an account created by an admin or an import
 * rather than through intake — is LEFT ALONE rather than defaulted. A wrong
 * 'siwes' would put someone back on the daily reminder list this work exists to
 * get them off; see `carriesLogbook` in lib/programme.ts.
 *
 * Idempotent: accounts that already carry a programme type are skipped, so it
 * is safe to run more than once.
 */
export const backfillProgrammeType = internalMutation({
  args: {},
  returns: v.object({
    stamped: v.number(),
    alreadyHad: v.number(),
    unresolved: v.number(),
  }),
  handler: async (ctx) => {
    const applications = await ctx.db
      .query('applications')
      .withIndex('by_status_and_converted', (q) => q.eq('status', 'approved'))
      .collect();

    // One pass over the applications rather than a lookup per user: the whole
    // point of the index above is that this stays a single scan of approved
    // rows instead of a query inside a loop over every account.
    const byUser = new Map<string, string>();
    for (const a of applications) {
      if (a.convertedUserId && a.programmeType) {
        byUser.set(String(a.convertedUserId), a.programmeType);
      }
    }

    const users = await ctx.db.query('users').collect();

    let stamped = 0;
    let alreadyHad = 0;
    let unresolved = 0;

    for (const user of users) {
      if (user.isDeleted) continue;
      if (user.programmeType) {
        alreadyHad++;
        continue;
      }

      const programmeType = byUser.get(String(user._id));
      if (!programmeType) {
        unresolved++;
        continue;
      }

      await ctx.db.patch(user._id, { programmeType, updatedAt: Date.now() });
      stamped++;
    }

    return { stamped, alreadyHad, unresolved };
  },
});

export const backfillInternProfiles = internalMutation({
  args: {},
  returns: v.object({ created: v.number(), alreadyHad: v.number(), noCohort: v.number() }),
  handler: async (ctx) => {
    const users = await ctx.db.query('users').collect();

    // Resolved ONCE. Letting the helper look it up per user is what took the
    // first run of this to 27,127 document reads against a 32,000 limit.
    const cohort = await resolveCohort(ctx);

    let created = 0;
    let alreadyHad = 0;
    let noCohort = 0;

    for (const user of users) {
      if (user.isDeleted) continue;

      if (user.cohortId) {
        alreadyHad++;
        continue;
      }

      const id = await ensureInternProfile(ctx, user._id, {}, cohort ?? undefined);
      if (id) created++;
      else noCohort++;
    }

    return { created, alreadyHad, noCohort };
  },
});

/**
 * Deactivates a duplicate account, keeping the one that holds the work.
 *
 * A staff member ended up with two accounts under different email addresses:
 * the original, created earlier, holding admin + moderator, a password and
 * several streamModerators grants; and a newer duplicate, moderator only, no
 * password, owning nothing at all — no grants, no tasks, no memberships, no
 * submissions. The newer one was last used shortly BEFORE the person signed
 * into the original, which reads as an account created by accident and
 * abandoned.
 *
 * Deactivates rather than deletes, and takes the id explicitly rather than
 * searching by name: a mutation that decides for itself which of someone's
 * accounts to switch off is a mutation that will one day switch off the wrong
 * one. Reversible from Admin → Users.
 */
export const deactivateDuplicate = internalMutation({
  args: { userId: v.id('users'), keepUserId: v.id('users') },
  handler: async (ctx, { userId, keepUserId }) => {
    const [dupe, keep] = await Promise.all([ctx.db.get(userId), ctx.db.get(keepUserId)]);
    if (!dupe) return { ok: false as const, error: 'Account not found.' };
    if (!keep) return { ok: false as const, error: 'The account to keep was not found.' };

    // Refuse if the one being switched off owns per-stream authority — that is
    // the signal it is not the throwaway it looks like.
    const grants = await ctx.db
      .query('streamModerators')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    if (grants.length) {
      return { ok: false as const, error: `Refusing: that account holds ${grants.length} stream-moderator grant(s).` };
    }

    await ctx.db.patch(userId, { isActive: false, updatedAt: Date.now() });
    return { ok: true as const, deactivated: dupe.email, kept: keep.email };
  },
});

/**
 * Creates a staff account from deployment credentials.
 *
 * `adminCreateUser` is super-admin-only on purpose — letting a plain admin make
 * accounts would let one manufacture peer admins, which the original Postgres
 * policy made impossible. That guard stays exactly as it is.
 *
 * This is not a way around it. An internal mutation cannot be reached from any
 * session at all; running it requires the deployment's own credentials, which
 * is a strictly higher bar than a super-admin login — whoever holds them can
 * already deploy arbitrary code to production. It exists so onboarding a
 * supervisor does not require the one person with a super-admin account to be
 * at a keyboard.
 *
 * STAFF ONLY. It refuses `admin` and `super_admin`, so the specific escalation
 * the original guard prevents is still prevented here: this can create a
 * supervisor, never a peer to whoever holds the keys.
 *
 * No stream is attached. A supervisor who oversees logbooks across the cohort
 * is not a member of one stream, and guessing at one would put them on a roster
 * they do not belong to.
 */
export const createStaffAccount = internalMutation({
  args: { email: v.string(), fullName: v.string(), role: v.string() },
  returns: v.object({
    success: v.boolean(),
    error: v.optional(v.string()),
    userId: v.optional(v.id('users')),
    tempPassword: v.optional(v.string()),
  }),
  handler: async (ctx, { email, fullName, role }) => {
    if (role !== 'moderator') {
      return {
        success: false as const,
        error: 'This path creates supervisors only. An admin must be created by a super admin.',
      };
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      return { success: false as const, error: 'Invalid email address.' };
    }
    if (fullName.trim().length < 2) {
      return { success: false as const, error: 'Name is too short.' };
    }

    const normalised = email.trim().toLowerCase();
    const clash = await ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', normalised))
      .unique();
    if (clash) return { success: false as const, error: 'A user with that email already exists.' };

    const temp = randomToken().slice(0, 12);
    const now = Date.now();

    const slugBase =
      fullName.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 40) ||
      normalised.split('@')[0];
    let slug = slugBase;
    for (let i = 1; ; i++) {
      const taken = await ctx.db
        .query('users')
        .withIndex('by_slug', (q) => q.eq('profileSlug', slug))
        .unique();
      if (!taken) break;
      slug = `${slugBase}-${i}`;
    }

    const id = await ctx.db.insert('users', {
      email: normalised,
      fullName,
      profileSlug: slug,
      // The plaintext is returned once and never stored — a cleartext
      // credential at rest beside the hash defeats the point of the hash.
      passwordHash: bcrypt.hashSync(temp, 10),
      roles: [role],
      totalPoints: 0,
      currentLevel: 1,
      loginStreakCount: 0,
      isActive: true,
      mcpEnabled: false,
      profileVisibility: 'public',
      showEmail: false,
      showActivityOnFeed: true,
      showOnLeaderboard: true,
      isDummy: false,
      createdAt: now,
      updatedAt: now,
    });

    await ensureInternProfile(ctx, id);

    await ctx.db.insert('auditLogs', {
      userId: id,
      userEmail: 'system',
      userRoles: [],
      action: 'admin.staff_account_created',
      tableName: 'users',
      recordId: id,
      newValues: { email: normalised, fullName, role, via: 'deployment credentials' },
      success: true,
      createdAt: now,
    });

    return { success: true as const, userId: id, tempPassword: temp };
  },
});
