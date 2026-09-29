import { internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { mintMagicLink } from './lib/auth';
import { appUrl, normaliseOrigin } from './lib/appUrl';
import { agentEmail } from './lib/agent';
import { emailFrom } from './lib/org';
import { TRACK_SEED } from './lib/tracks';

/**
 * FIRST-RUN SETUP FOR A NEW ORBIT DEPLOYMENT.
 *
 *     npx convex run setup:bootstrap '{"adminEmail":"you@example.org","adminName":"Your Name"}'
 *
 * Until this existed, a fresh deployment could not be brought up at all:
 * `users.adminCreateUser` needs an existing super admin, `adminSetRoles`
 * refuses to grant super_admin, Zoho sign-in only ever creates moderators, and
 * the documented route was "write a temporary internal mutation". It creates:
 *
 *   - the FIRST super admin (roles super_admin + admin), with no password, and
 *     returns a one-time sign-in link — printed to the operator's terminal, not
 *     emailed, because SMTP may not be configured yet;
 *   - the ORBIT Agent account (`ORBIT_AGENT_EMAIL`), which every automated
 *     decision is attributed to;
 *   - the reference data the app assumes: settings rows, a level ladder, a
 *     starter set of badges, the tracks, and (optionally) a first cohort.
 *
 * SAFE TO LEAVE IN A PUBLIC CODEBASE, for two reasons:
 *   1. It is INTERNAL. It runs only with deployment credentials
 *      (`npx convex run`), never from a browser session, so it adds nothing to
 *      the public surface guarded by convex-authz-surface.test.ts.
 *   2. It REFUSES once any admin or super admin exists. It can bring a
 *      deployment up; it cannot be used to mint a second owner on a running one.
 * Everything else it seeds is created only when missing, so a partial re-run
 * (after `refused`) is harmless.
 */

const DEFAULT_SETTINGS: { key: string; value: unknown; category: string; description: string }[] = [
  { key: 'site_name', value: 'ORBIT', category: 'general', description: 'Application name displayed throughout the site' },
  { key: 'site_title', value: 'ORBIT — internship and learning operations', category: 'general', description: 'Full application title' },
  { key: 'site_logo_url', value: null, category: 'general', description: 'URL to the site logo image' },
  { key: 'task_approval_window_hours', value: { enabled: true, value: 48 }, category: 'general', description: 'Hours a task proposal waits before publishing' },
  { key: 'max_streams_per_intern', value: { enabled: true, value: 3 }, category: 'general', description: 'Maximum number of streams an intern can join simultaneously' },
  { key: 'max_file_size_mb', value: { enabled: true, size: 24 }, category: 'submissions', description: 'Maximum file size in megabytes for task submissions' },
  { key: 'acceptable_file_types', value: ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png', 'txt', 'zip'], category: 'submissions', description: 'File extensions accepted for task submissions' },
  { key: 'event_stream_id', value: { stream_id: '' }, category: 'general', description: 'Stream whose members follow the event level track' },
];

/**
 * Rows whose defaults depend on the deployment's environment. The Settings
 * screen saves into these, and `adminSettings.set` does not upsert, so without
 * a row those sections fail with "No such setting". Credentials are left empty:
 * delivery and sign-in read the Convex environment, not these rows.
 */
function envSettings(): typeof DEFAULT_SETTINGS {
  return [
    { key: 'app_url', value: appUrl(), category: 'general', description: 'Public URL of the app, used in email links' },
    { key: 'zeptomail_config', value: { host: 'smtp.zeptomail.com', port: 587, user: '', from: emailFrom(), fromName: 'ORBIT Team' }, category: 'email', description: 'Reference copy of the outbound mail configuration' },
    { key: 'zoho_oauth_config', value: { clientId: '', redirectUri: '', enabled: false }, category: 'auth', description: 'Zoho sign-in configuration' },
  ];
}

const DEFAULT_LEVELS = [
  { levelNumber: 1, name: 'Orbit Entry', pointsRequired: 0, iconEmoji: '🚀', colorHex: '#10B981', description: 'Start — access to updates, tasks and the community' },
  { levelNumber: 2, name: 'Active Orbit', pointsRequired: 100, iconEmoji: '🛰️', colorHex: '#3B82F6', description: 'Active — regular task participation and recognised contributions' },
  { levelNumber: 3, name: 'Orbit Stars', pointsRequired: 300, iconEmoji: '🌟', colorHex: '#F59E0B', description: 'Elite — top contributors' },
];

// criteriaType is one of the kinds badges.checkAndAward evaluates:
// tasks | points | streak | consistency | quality.
const DEFAULT_BADGES = [
  { name: 'First Steps', description: 'Complete your first task', criteriaType: 'tasks', criteriaValue: 1, pointsBonus: 5 },
  { name: 'Getting Going', description: 'Complete 3 tasks', criteriaType: 'tasks', criteriaValue: 3, pointsBonus: 25 },
  { name: 'Making Moves', description: 'Complete 10 tasks', criteriaType: 'tasks', criteriaValue: 10, pointsBonus: 50 },
  { name: 'Rising Star', description: 'Earn 100 points', criteriaType: 'points', criteriaValue: 100, pointsBonus: 10 },
  { name: 'On the Map', description: 'Earn 500 points', criteriaType: 'points', criteriaValue: 500, pointsBonus: 50 },
  { name: 'Consistent', description: 'Submit your weekly summary on time 7 weeks running', criteriaType: 'streak', criteriaValue: 7, pointsBonus: 15 },
];

function slugify(name: string, email: string): string {
  const base = (name || email.split('@')[0]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return base || 'admin';
}

export const bootstrap = internalMutation({
  args: {
    adminEmail: v.string(),
    adminName: v.string(),
    /** Optional first cohort. Without one, tasks cannot be created until an admin adds a cohort. */
    cohort: v.optional(v.object({ name: v.string(), startDate: v.string(), endDate: v.string() })),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { adminEmail, adminName, cohort, dryRun }) => {
    const email = adminEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { ok: false as const, error: 'adminEmail is not a valid email address.' };
    }
    if (!adminName.trim()) return { ok: false as const, error: 'adminName is required.' };
    if (cohort && !(/^\d{4}-\d{2}-\d{2}$/.test(cohort.startDate) && /^\d{4}-\d{2}-\d{2}$/.test(cohort.endDate) && cohort.endDate >= cohort.startDate)) {
      return { ok: false as const, error: 'cohort dates must be YYYY-MM-DD, and endDate on or after startDate.' };
    }

    // The sign-in link below is built from APP_URL, and an unset APP_URL falls
    // back to the original operator's production domain — so a new install
    // would print a one-time credential pointing at someone else's site.
    const appUrlConfigured = normaliseOrigin(process.env.APP_URL) !== null;
    if (!appUrlConfigured && !dryRun) {
      return {
        ok: false as const,
        error: 'Set APP_URL on this deployment first (npx convex env set APP_URL http://localhost:5173 for local development, or your public URL). The sign-in link is built from it.',
      };
    }

    const agent = agentEmail();
    if (email === agent) {
      return { ok: false as const, error: 'adminEmail must not be the ORBIT Agent address (ORBIT_AGENT_EMAIL).' };
    }

    // THE GUARD. One owner per deployment is created here, and only on a
    // deployment that has none. Soft-deleted admins count: a deployment that
    // once had an owner is not "empty", and restoring one is an Admin → Users
    // job. Streamed rather than paginated — a mutation may run one paginated
    // query, and this has to see every row.
    for await (const u of ctx.db.query('users')) {
      if (u.roles.some((r) => r === 'admin' || r === 'super_admin')) {
        return {
          ok: false as const,
          error: 'This deployment already has an admin. setup:bootstrap only initialises an empty deployment; add further people from Admin → Users.',
        };
      }
    }

    // Roles alone forget: demoting every admin leaves no trace on the users
    // table. A deployment that was ever bootstrapped stays refused.
    if (await ctx.db.query('auditLogs').withIndex('by_action', (q) => q.eq('action', 'setup.bootstrap')).first()) {
      return {
        ok: false as const,
        error: 'This deployment was already bootstrapped. Restore an admin from Admin → Users (or with deployment credentials), not with setup:bootstrap.',
      };
    }

    const existing = await ctx.db.query('users').withIndex('by_email', (q) => q.eq('email', email)).unique();
    let missingTracks = 0;
    for (const t of TRACK_SEED) {
      if (!(await ctx.db.query('tracks').withIndex('by_slug', (q) => q.eq('slug', t.slug)).first())) missingTracks++;
    }
    const plan = {
      admin: email,
      // Promoting an account that already exists (an intern or a moderator
      // who signed in first) is shown, not done silently.
      adminAccount: existing ? 'promote existing' : 'create',
      agent,
      settings: 0, levels: 0, badges: 0,
      tracksToSeed: missingTracks,
      cohort: cohort?.name ?? null,
      appUrl: appUrlConfigured ? appUrl() : 'NOT SET — the live run will refuse until APP_URL is set',
    };
    const now = Date.now();

    // Settings rows. `adminSettings.set` only updates existing rows, so a
    // Settings screen on a database without them has nothing to save into.
    for (const s of [...DEFAULT_SETTINGS, ...envSettings()]) {
      const found = await ctx.db.query('adminSettings').withIndex('by_key', (q) => q.eq('settingKey', s.key)).first();
      if (found) continue;
      plan.settings++;
      if (!dryRun) {
        await ctx.db.insert('adminSettings', {
          settingKey: s.key, settingValue: s.value, category: s.category, description: s.description,
          createdAt: now, updatedAt: now,
        });
      }
    }

    if (!(await ctx.db.query('levels').first())) {
      plan.levels = DEFAULT_LEVELS.length;
      if (!dryRun) for (const l of DEFAULT_LEVELS) await ctx.db.insert('levels', { ...l, createdAt: now });
    }
    if (!(await ctx.db.query('badges').first())) {
      plan.badges = DEFAULT_BADGES.length;
      if (!dryRun) for (const b of DEFAULT_BADGES) await ctx.db.insert('badges', { ...b, isActive: true, createdAt: now });
    }

    if (dryRun) return { ok: true as const, dryRun: true, plan };

    await ctx.runMutation(internal.tracks.seedTracks, {});

    const baseUser = {
      isActive: true, isDeleted: false, isDummy: false,
      totalPoints: 0, currentLevel: 1, loginStreakCount: 0,
      profileVisibility: 'public', showEmail: false, showActivityOnFeed: true, showOnLeaderboard: false,
      createdAt: now, updatedAt: now,
    };

    let adminId;
    if (existing) {
      // Promotion to owner starts from a clean credential state: whoever knew
      // this account's old password, or holds one of its sessions, must not
      // inherit super_admin. The owner signs in with the link below.
      await ctx.db.patch(existing._id, {
        roles: ['super_admin', 'admin'], isActive: true, isDeleted: false,
        passwordHash: undefined, tempPassword: undefined,
        // An MCP secret bound to this address would otherwise become a
        // super_admin login, and an old calendar URL would keep working.
        mcpEnabled: false, calendarFeedToken: undefined,
        updatedAt: now,
      });
      for await (const sess of ctx.db.query('sessions').withIndex('by_user', (q) => q.eq('userId', existing._id))) {
        await ctx.db.delete(sess._id);
      }
      for await (const code of ctx.db.query('oauthExchangeCodes').withIndex('by_user', (q) => q.eq('userId', existing._id))) {
        await ctx.db.delete(code._id);
      }
      adminId = existing._id;
    } else {
      adminId = await ctx.db.insert('users', {
          ...baseUser, email, fullName: adminName.trim(), profileSlug: slugify(adminName, email),
          roles: ['super_admin', 'admin'], mcpEnabled: false,
        });
    }

    const agentRow = await ctx.db.query('users').withIndex('by_email', (q) => q.eq('email', agent)).unique();
    if (!agentRow) {
      await ctx.db.insert('users', {
        ...baseUser, email: agent, fullName: 'ORBIT Agent', profileSlug: 'orbit-agent',
        // Admin so the agent's recorded decisions carry staff authority; MCP-enabled
        // so an MCP credential can be bound to it (see MCP_CONNECTION_GUIDE.md).
        roles: ['admin'], mcpEnabled: true,
      });
    }

    if (cohort) {
      await ctx.db.insert('cohorts', {
        name: cohort.name, startDate: cohort.startDate, endDate: cohort.endDate, status: 'active',
        defaultParticipationMode: 'virtual', dailyLogsRequired: true, weeklySummaryRequired: true,
        signoffRequired: true, createdBy: adminId, createdAt: now, updatedAt: now,
      });
    }

    await ctx.db.insert('auditLogs', {
      userId: adminId, userEmail: email, userRoles: ['super_admin', 'admin'],
      action: 'setup.bootstrap', tableName: 'users', recordId: String(adminId),
      newValues: plan, success: true, createdAt: now,
    });

    const token = await mintMagicLink(ctx, adminId, now);
    return {
      ok: true as const,
      plan,
      // Printed once, to whoever ran the command. Valid for a single use.
      signInLink: `${appUrl()}/magic#token=${token}`,
      next: [
        'Open signInLink and set a password under Settings.',
        'Create streams (Admin → Streams) and attach each to a track, so admissions can place people.',
        cohort ? 'Your first cohort is active.' : 'Add a cohort (Admin → SIWES → Cohorts); tasks cannot be created without an active one.',
      ],
    };
  },
});
