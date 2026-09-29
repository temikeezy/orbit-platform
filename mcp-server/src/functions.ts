import { makeFunctionReference } from 'convex/server';

/**
 * The contract with the Convex deployment, in one file.
 *
 * These are hand-declared references rather than an import of
 * `convex/_generated/api`. That import would pull the entire `convex/` source
 * tree into this package's compilation — `api.d.ts` imports the modules
 * themselves, not declarations — which would mean this server needs bcryptjs and
 * the whole server runtime on its dependency list to typecheck a stdio process
 * that talks to it over HTTP.
 *
 * The trade is that a rename in `convex/` is caught by the live test pass rather
 * than by `tsc`. Keeping every path in this one file is what makes that
 * tractable: there is a single place to diff against the deployment, and no tool
 * anywhere else in this package names a Convex function.
 *
 * Return types are written as what this server actually consumes, not as the
 * full server-side shape. Fields the tools do not read are omitted on purpose,
 * so this file does not have to track cosmetic changes on the other side.
 */

type Ok<T = Record<string, never>> = { success: true } & T;
type Fail = { success: false; error: string };
type Result<T = Record<string, never>> = Ok<T> | Fail;

export interface PublicUser {
  id: string;
  fullName: string;
  profileSlug: string;
  profilePhotoUrl?: string;
  bio?: string;
  location?: string;
  roles: string[];
  currentStreamId?: string;
  totalPoints: number;
  currentLevel: number;
  email?: string;
  isActive: boolean;
}

export interface AdminUser extends PublicUser {
  legacyId?: string;
  coverPhotoUrl?: string;
  socialLinks?: unknown;
  loginStreakCount: number;
  isDeleted: boolean;
  mcpEnabled: boolean;
  profileVisibility: string;
  lastLoginAt?: number;
  createdAt: number;
}

export interface Stream {
  id: string;
  name: string;
  description?: string;
  emoji?: string;
  privacy?: string;
  joinType?: string;
  isActive: boolean;
  createdAt: number;
  memberCount: number;
}

export interface StreamMember {
  id: string;
  fullName: string;
  profileSlug: string;
  roles: string[];
  totalPoints: number;
  currentLevel: number;
  joinedAt: number;
}

export interface Task {
  id: string;
  streamId: string;
  title: string;
  description: string;
  submissionType: string;
  points: number;
  deadline: number;
  isActive: boolean;
  isFeatured: boolean;
  createdAt: number;
}

export interface Submission {
  id: string;
  taskId: string;
  userId: string;
  submissionText?: string;
  submissionFileUrl?: string;
  status: string;
  score?: number;
  feedback?: string;
  reviewedAt?: number;
  submittedAt?: number;
  createdAt: number;
  task: { id: string; title: string; points: number } | null;
  author: { id: string; fullName: string } | null;
}

export interface LeaderboardEntry {
  userId: string;
  fullName: string;
  currentLevel: number;
  points: number;
  rank: number;
}

export interface InboxMessage {
  id: string;
  content: string;
  isRead: boolean;
  createdAt: number;
  parentMessageId?: string;
  sender: { id: string; fullName: string; profileSlug: string } | null;
}

export interface Mention {
  id: string;
  source: 'post' | 'reply';
  postId: string;
  content: string;
  createdAt: number;
  author: { id: string; fullName: string; profileSlug: string } | null;
}

export interface Setting {
  key: string;
  value: unknown;
  category: string;
  description?: string;
  updatedAt: number;
}

const q = makeFunctionReference;
const m = makeFunctionReference;

export const fn = {
  // ---- session -----------------------------------------------------------
  authenticate: m<
    'mutation',
    { secret: string },
    | { success: true; token: string; expiresAt: number; actor: { id: string; email: string; fullName: string; roles: string[] } }
    | Fail
  >('mcp:authenticate'),

  whoami: q<'query', { token: string }, { id: string; email: string; fullName: string; roles: string[]; expiresAt: number }>(
    'mcp:whoami',
  ),

  recordAudit: m<
    'mutation',
    {
      token: string;
      action: string;
      tableName?: string;
      recordId?: string;
      values?: unknown;
      success?: boolean;
      errorMessage?: string;
    },
    Ok
  >('mcp:recordAudit'),

  resolveLegacyId: q<'query', { token: string; table: string; legacyId: string }, string | null>(
    'mcp:resolveLegacyId',
  ),

  platformStats: q<
    'query',
    { token: string },
    {
      activeUsers: number;
      activeStreams: number;
      activeTasks: number;
      pendingSubmissions: number;
      /** True when a read cap bit, so every figure above is a floor, not a total. */
      capped: boolean;
    }
  >('mcp:platformStats'),

  // ---- users -------------------------------------------------------------
  listUsers: q<'query', { token: string; includeInactive?: boolean }, PublicUser[]>('users:list'),
  adminGetUser: q<'query', { token: string; userId: string }, AdminUser | null>('users:adminGetById'),
  setRoles: m<'mutation', { token: string; userId: string; roles: string[] }, Result>('users:adminSetRoles'),

  // ---- streams -----------------------------------------------------------
  listStreams: q<'query', { token: string; includeInactive?: boolean }, Stream[]>('streams:list'),
  getStream: q<
    'query',
    { token: string; streamId: string },
    (Stream & { isMember: boolean; isModerator: boolean }) | null
  >('streams:getById'),
  streamMembers: q<'query', { token: string; streamId: string }, StreamMember[]>('streams:members'),
  createStream: m<
    'mutation',
    { token: string; name: string; description?: string; emoji?: string; privacy?: string; joinType?: string },
    Ok<{ id: string }>
  >('streams:create'),

  // ---- tasks -------------------------------------------------------------
  listTasks: q<'query', { token: string; includeInactive?: boolean }, Array<Task & { mySubmission: unknown }>>(
    'tasks:listForUser',
  ),
  getTask: q<'query', { token: string; taskId: string }, (Task & { mySubmission: unknown }) | null>('tasks:getById'),
  createTask: m<
    'mutation',
    {
      token: string;
      streamId: string;
      title: string;
      description: string;
      submissionType: string;
      points: number;
      deadline?: number;
      isFeatured?: boolean;
      notify?: boolean;
    },
    Ok<{
      id: string;
      notified: number;
      approvalStatus: 'pending' | 'approved';
      deadline: number;
    }>
  >('tasks:create'),
  updateTask: m<
    'mutation',
    {
      token: string;
      taskId: string;
      title?: string;
      description?: string;
      points?: number;
      deadline?: number;
      isActive?: boolean;
      isFeatured?: boolean;
    },
    Ok
  >('tasks:update'),

  // ---- submissions -------------------------------------------------------
  listSubmissions: q<
    'query',
    { token: string; taskId?: string; userId?: string; status?: string; limit?: number },
    Submission[]
  >('tasks:listSubmissions'),
  reviewSubmission: m<
    'mutation',
    {
      token: string;
      submissionId: string;
      status: 'approved' | 'rejected' | 'changes_requested';
      score?: number;
      feedback?: string;
    },
    | {
        success: true;
        previousStatus: string;
        points: { awarded: number; newTotal: number; newLevel: number; leveledUp: boolean } | null;
        badgesAwarded: string[];
      }
    | Fail
  >('tasks:reviewSubmission'),

  // ---- leaderboard -------------------------------------------------------
  leaderboard: q<
    'query',
    { token: string; period?: 'all' | 'week' | 'month'; limit?: number },
    { period: string; entries: LeaderboardEntry[]; totalRanked: number }
  >('leaderboard:top'),

  // ---- feed --------------------------------------------------------------
  createPost: m<
    'mutation',
    { token: string; content: string; postType?: string; streamId?: string; metadata?: unknown },
    Result<{ id: string }>
  >('posts:create'),
  replyToPost: m<'mutation', { token: string; postId: string; content: string }, Result<{ id: string }>>(
    'posts:reply',
  ),
  mentions: q<'query', { token: string; hoursBack?: number; limit?: number }, Mention[]>('posts:mentionsOfMe'),

  // ---- stream chat -------------------------------------------------------
  sendStreamChat: m<
    'mutation',
    { token: string; streamId: string; content: string; isAnnouncement?: boolean },
    Result<{ id: string }>
  >('streamChat:send'),

  // ---- direct messages ---------------------------------------------------
  sendMessage: m<
    'mutation',
    { token: string; recipientId: string; content: string },
    Result<{ id: string }>
  >('messages:send'),
  inbox: q<'query', { token: string; unreadOnly?: boolean; limit?: number }, InboxMessage[]>('messages:inbox'),
  replyToMessage: m<
    'mutation',
    { token: string; messageId: string; content: string },
    Result<{ id: string }>
  >('messages:replyTo'),
  markMessageRead: m<'mutation', { token: string; messageId: string }, Ok<{ updated: number }>>(
    'messages:markRead',
  ),

  // ---- notifications and email ------------------------------------------
  sendNotification: m<
    'mutation',
    { token: string; userId: string; title: string; content: string; type?: string; actionUrl?: string },
    Result<{ id: string }>
  >('notifications:adminSend'),
  queueEmail: m<
    'mutation',
    {
      token: string;
      userId: string;
      subject: string;
      bodyText: string;
      bodyHtml?: string;
      emailType?: string;
      referenceType?: string;
      referenceId?: string;
    },
    Result<{ id: string; recipientEmail: string }>
  >('emailQueue:adminEnqueue'),

  // ---- settings ----------------------------------------------------------
  listSettings: q<'query', { token: string }, Setting[]>('adminSettings:list'),
  setSetting: m<'mutation', { token: string; key: string; value: unknown }, Result<{ previous: unknown }>>(
    'adminSettings:set',
  ),
} as const;
