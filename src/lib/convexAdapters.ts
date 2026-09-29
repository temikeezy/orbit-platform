import { OrbitUser, UserRole } from '../types/database';

/**
 * Convex → the shapes the app already speaks.
 *
 * The Convex functions return camelCase (`fullName`, `profilePhotoUrl`) and the
 * app is snake_case (`full_name`, `profile_photo_url`), because it grew against
 * PostgREST. Roughly 18 files and every component read the snake_case shape.
 *
 * Adapting HERE, at the module boundary, is what makes the client swap tractable:
 * each API module's body changes and its call sites do not. Renaming the fields
 * app-wide is a separate, mechanical change that can happen later — or never, if
 * it never pays for itself.
 *
 * The direction is deliberately one-way. Nothing converts snake_case back into
 * Convex arguments: mutations take explicit named arguments, so the adapters are
 * only ever needed on the way out.
 */

/** Convex stores epoch milliseconds; the app expects ISO strings. */
function iso(ms: number | undefined | null): string | undefined {
  return typeof ms === 'number' ? new Date(ms).toISOString() : undefined;
}

/** The shape `lib/auth.ts` and `users.ts` receive from Convex. */
export interface ConvexUser {
  id: string;
  email: string;
  fullName: string;
  profileSlug?: string;
  profilePhotoUrl?: string;
  coverPhotoUrl?: string;
  bio?: string;
  location?: string;
  socialLinks?: unknown;
  roles: string[];
  currentStreamId?: string;
  totalPoints: number;
  currentLevel: number;
  loginStreakCount?: number;
  isActive: boolean;
  mcpEnabled?: boolean;
  profileVisibility?: string;
  showEmail?: boolean;
  showActivityOnFeed?: boolean;
  showOnLeaderboard?: boolean;
  lastLoginAt?: number;
  /** Only `publicUser` sets this; `directoryShape` deliberately omits it. */
  hasPassword?: boolean;
  createdAt: number;
}

export function toOrbitUser(u: ConvexUser): OrbitUser {
  return {
    id: u.id,
    email: u.email,
    full_name: u.fullName,
    roles: u.roles as UserRole[],
    profile_photo_url: u.profilePhotoUrl,
    cover_photo_url: u.coverPhotoUrl,
    bio: u.bio,
    location: u.location,
    current_stream_id: u.currentStreamId,
    total_points: u.totalPoints,
    current_level: u.currentLevel,
    login_streak_count: u.loginStreakCount,
    is_active: u.isActive,
    mcp_enabled: u.mcpEnabled,
    social_links: u.socialLinks as OrbitUser['social_links'],
    last_login_at: iso(u.lastLoginAt),
    // Whether a password exists at all — not the hash. Lets the settings screen
    // offer "set a password" to magic-link accounts instead of demanding one
    // they have never had.
    //
    // SPREAD, not a plain assignment, because only `publicUser` sends this and
    // `directoryShape` does not. Assigned unconditionally it became
    // `has_password: false` on every directory row — asserting that people WITH
    // a password have none, which is worse than saying nothing. Absent means
    // "not reported", and only the viewer's own record ever reports it.
    ...('hasPassword' in u
      ? { has_password: Boolean((u as { hasPassword?: boolean }).hasPassword) }
      : {}),
    created_at: iso(u.createdAt) ?? new Date(0).toISOString(),
    updated_at: iso(u.createdAt) ?? new Date(0).toISOString(),

    // password_hash, jwt_token and jwt_expires_at are ABSENT and stay absent.
    // Convex never returns them — `publicUser` exists specifically to keep them
    // off the wire, after the Supabase build served password hashes to anyone
    // holding the anon key. `jwt_expires_at` in particular is load-bearing in
    // the old `isAuthenticated()`, which is dealt with in lib/auth.ts rather
    // than by inventing a value here.
  };
}

// ------------------------------------------------------------------- levels

export interface ConvexLevel {
  id: string;
  levelNumber: number;
  name: string;
  description: string;
  pointsRequired: number;
  iconEmoji?: string;
  colorHex?: string;
}

export function toLevel(l: ConvexLevel) {
  return {
    id: l.id,
    level_number: l.levelNumber,
    name: l.name,
    description: l.description,
    points_required: l.pointsRequired,
    // The app's Level type declares these non-optional and reads them straight
    // into style attributes, so a missing emoji or colour has to become a usable
    // default here rather than `undefined` reaching a template.
    icon_emoji: l.iconEmoji ?? '⭐',
    color_hex: l.colorHex ?? '#2DD881',
  };
}

export interface ConvexLevelInfo {
  current: ConvexLevel;
  next: ConvexLevel | null;
  pointsToNext: number;
  progressPercent: number;
}

export function toLevelInfo(info: ConvexLevelInfo) {
  return {
    current_level: toLevel(info.current),
    next_level: info.next
      ? {
          level_number: info.next.levelNumber,
          name: info.next.name,
          points_required: info.next.pointsRequired,
          points_needed: info.pointsToNext,
        }
      : undefined,
    progress_percentage: info.progressPercent,
  };
}

// ------------------------------------------------------------------- badges

export interface ConvexBadge {
  id: string;
  name: string;
  description: string;
  iconUrl?: string;
  criteriaType: string;
  criteriaValue: number;
  pointsBonus: number;
  isActive: boolean;
  earned?: boolean;
  earnedAt?: number;
}

export function toBadge(b: ConvexBadge) {
  return {
    id: b.id,
    name: b.name,
    description: b.description,
    icon_url: b.iconUrl ?? null,
    criteria_type: b.criteriaType as 'tasks' | 'streak' | 'quality' | 'consistency' | 'points',
    criteria_value: b.criteriaValue,
    points_bonus: b.pointsBonus,
    is_active: b.isActive,
    earned: b.earned,
    earned_at: iso(b.earnedAt),
  };
}

// --------------------------------------------------------- tasks/submissions

export interface ConvexTask {
  id: string;
  streamId: string;
  title: string;
  description: string;
  submissionType: string;
  points: number;
  deadline: number;
  isActive: boolean;
  isFeatured?: boolean;
  createdAt: number;
}

export function toTask(t: ConvexTask) {
  return {
    id: t.id,
    stream_id: t.streamId,
    title: t.title,
    description: t.description,
    submission_type: t.submissionType as 'text' | 'link' | 'file',
    points: t.points,
    // Convex holds the deadline as epoch ms; the app formats an ISO string.
    deadline: new Date(t.deadline).toISOString(),
    // `created_by` is not returned by taskShape and the UI never shows it. An
    // empty string keeps the declared type honest without inventing an id that
    // would look like a real user.
    created_by: '',
    is_active: t.isActive,
    is_featured: Boolean(t.isFeatured),
    created_at: iso(t.createdAt) ?? new Date(0).toISOString(),
    updated_at: iso(t.createdAt) ?? new Date(0).toISOString(),
  };
}

export interface ConvexSubmission {
  id: string;
  taskId: string;
  userId: string;
  submissionText?: string;
  submissionFileUrl?: string;
  hasFile?: boolean;
  status: string;
  score?: number;
  feedback?: string;
  reviewedBy?: string;
  reviewedAt?: number;
  submittedAt?: number;
  startedAt?: number;
  createdAt: number;
}

export function toSubmission(s: ConvexSubmission) {
  return {
    id: s.id,
    task_id: s.taskId,
    user_id: s.userId,
    submission_text: s.submissionText,
    submission_file_url: s.submissionFileUrl,
    submission_url: s.submissionFileUrl,
    // Post-migration uploads live in Convex storage and have no public url at
    // all, so a truthiness check on `submission_url` would report "no file" for
    // every one of them.
    has_file: Boolean(s.hasFile) || Boolean(s.submissionFileUrl),
    status: s.status as 'draft' | 'in_progress' | 'submitted' | 'approved' | 'rejected' | 'changes_requested',
    score: s.score,
    feedback: s.feedback,
    // points_awarded was a denormalised column the browser wrote alongside the
    // ledger. The ledger is the record now, and `score` is what was paid.
    //
    // AN ALIAS OF `score`, FROM THE SAME SOURCE — the two cannot diverge, and
    // no UI reads this any more. Both fields being optional on OrbitSubmission
    // makes it look as though one could hold a value the other lacks, which a
    // review of this file duly inferred; it cannot. Read `score`.
    points_awarded: s.score,
    started_at: iso(s.startedAt),
    reviewed_by: s.reviewedBy,
    reviewed_at: iso(s.reviewedAt),
    submitted_at: iso(s.submittedAt),
    created_at: iso(s.createdAt) ?? new Date(0).toISOString(),
    updated_at: iso(s.createdAt) ?? new Date(0).toISOString(),
  };
}

// ------------------------------------------------------------------ streams

export interface ConvexStream {
  id: string;
  name: string;
  description?: string;
  emoji?: string;
  coverImageUrl?: string;
  displayPhotoUrl?: string;
  privacy?: 'public' | 'private';
  joinType?: 'open' | 'invite';
  isActive: boolean;
  createdBy?: string;
  createdAt: number;
  memberCount: number;
  // The viewer's own relationship to the stream, resolved server-side. The old
  // client worked these out itself: it fetched every membership row and every
  // stream_moderators row and searched them in the browser, which meant any
  // logged-in user could read both tables in full.
  isMember?: boolean;
  isModerator?: boolean;
}

export function toStream(s: ConvexStream) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    emoji: s.emoji,
    cover_image_url: s.coverImageUrl,
    display_photo_url: s.displayPhotoUrl,
    privacy: s.privacy,
    join_type: s.joinType,
    is_active: s.isActive,
    created_by: s.createdBy ?? '',
    created_at: iso(s.createdAt) ?? new Date(0).toISOString(),
    updated_at: iso(s.createdAt) ?? new Date(0).toISOString(),
    // DERIVED server-side from active memberships, never a stored counter. The
    // Postgres column was maintained by a trigger whose UPDATE branch ignored
    // the is_active flip the app actually used, so it never decremented and
    // every reassignment double-counted.
    member_count: s.memberCount,
    is_member: s.isMember ?? false,
    is_moderator: s.isModerator ?? false,
  };
}
