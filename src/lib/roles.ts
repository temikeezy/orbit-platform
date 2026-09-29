import type { OrbitUser } from '../types/database';

/**
 * Who someone is, in one place.
 *
 * Thirteen separate inline role checks had grown across the app, each spelling
 * out its own list of role strings. They drifted, and the drift was invisible:
 * the task list gated its ADMIN actions correctly while leaving "Accept Task"
 * and "Submit Work" open to everyone, so a supervisor was shown buttons the
 * server refuses — `acceptTask` and `submitWork` both check `isIntern` and
 * throw. A control that cannot work is worse than an absent one; it reads as a
 * broken account.
 *
 * MIRRORS THE SERVER EXACTLY. `isIntern` here is the same rule as
 * `convex/lib/internProfile.ts` — carries no staff role — and must stay that
 * way. If the two disagree, the UI offers something the server denies, which is
 * the failure this file exists to prevent.
 *
 * NOT A SECURITY BOUNDARY. Convex has no row-level security and every mutation
 * re-checks its own caller. These are for deciding what to SHOW, so that what
 * is shown is what will work.
 */

type MaybeUser = Pick<OrbitUser, 'roles'> | null | undefined;

const STAFF_ROLES = ['admin', 'super_admin', 'moderator'] as const;

/** Admin, super admin or moderator. */
export function isStaff(user: MaybeUser): boolean {
  const roles = user?.roles ?? [];
  return roles.some((r) => (STAFF_ROLES as readonly string[]).includes(r));
}

/**
 * Carries no staff role.
 *
 * Note this is not "has the intern role" — someone holding both intern and
 * moderator is staff, and should not be asked to accept tasks. Defined as the
 * absence of staff so a new staff role added later cannot silently be treated
 * as an intern.
 */
export function isIntern(user: MaybeUser): boolean {
  if (!user) return false;
  return !isStaff(user);
}

/** Admin or super admin — not moderators, who are scoped to their streams. */
export function isAdmin(user: MaybeUser): boolean {
  const roles = user?.roles ?? [];
  return roles.includes('admin') || roles.includes('super_admin');
}

/** A moderator, whose authority is per-stream rather than platform-wide. */
export function isModerator(user: MaybeUser): boolean {
  return (user?.roles ?? []).includes('moderator');
}

/**
 * Whether to show points, levels, badges and the leaderboard.
 *
 * These are an intern progression device. Staff neither earn them —
 * `awardPoints` returns early for anyone who is not an intern — nor place on
 * the leaderboard, which filters to interns server-side. Showing a supervisor a
 * level badge reading "Level 1, 0 points" states something true and useless,
 * and invites them to wonder what they did wrong.
 */
export function seesProgression(user: MaybeUser): boolean {
  return isIntern(user);
}

/**
 * Whether to show the intern task loop: accept, submit, my-progress filters.
 *
 * The server refuses all three for staff. This keeps the UI honest about that.
 */
export function seesTaskLoop(user: MaybeUser): boolean {
  return isIntern(user);
}
