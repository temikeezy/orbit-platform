import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import { requireAdmin, userFromToken } from './lib/auth';
import { checkRateLimit } from './lib/rateLimit';

/**
 * Error capture and bug reports.
 *
 * See the schema note for why these share a table. The short version: a caught
 * exception and a person saying "this is broken" are the same record with a
 * different trigger, and on this deployment neither was being recorded at all.
 */

/** A trace is rarely useful past its first frames, and this is not a debugger. */
const MAX_STACK = 4_000;
const MAX_MESSAGE = 1_000;
const MAX_NOTE = 2_000;

/**
 * Strips everything after the path.
 *
 * Magic-link tokens travel in the URL FRAGMENT precisely so they never reach a
 * server log; writing a full URL here would undo that and put a live credential
 * into a table every admin can read. Query strings go too — they carry ids and
 * filters that are nobody's business in an error list.
 */
function safePath(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  return path.slice(0, 300);
}

/**
 * Records an error, or increments one already seen.
 *
 * DELIBERATELY NOT `requireUser`. An error caught before sign-in — a broken
 * login page, a failed magic link — is exactly the kind nobody would otherwise
 * hear about, and refusing it would blind the platform to its own front door.
 * The token is resolved if present and the report is attributed; without one it
 * is still recorded, anonymously.
 *
 * Rate limited per session or address, because an error inside a render loop
 * can fire hundreds of times a second and would otherwise be a self-inflicted
 * denial of service against the database it is reporting to.
 */
export const report = mutation({
  args: {
    token: v.optional(v.string()),
    source: v.string(),
    message: v.string(),
    stack: v.optional(v.string()),
    url: v.optional(v.string()),
    context: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = args.token ? await userFromToken(ctx, args.token) : null;

    const limit = await checkRateLimit(
      ctx,
      user ? String(user._id) : 'anonymous-error-report',
      'error_report',
      60,
      60 * 1000,
    );
    // Silently accepted rather than refused: a client told its error report
    // failed will often report THAT, and the loop tightens.
    if (!limit.allowed) return { success: true as const, recorded: false };

    const message = args.message.slice(0, MAX_MESSAGE);
    const context = args.context?.slice(0, 200);
    const now = Date.now();

    /**
     * One fault hit by forty people is one problem.
     *
     * Fingerprinted on message plus context so a list of errors reads as a list
     * of PROBLEMS. Without this, a single broken screen buries every other
     * fault in the table under its own repetitions.
     */
    const existing = await ctx.db
      .query('errorReports')
      .withIndex('by_fingerprint', (q) => q.eq('message', message).eq('context', context))
      .first();

    if (existing && args.source === 'caught') {
      await ctx.db.patch(existing._id, {
        occurrences: existing.occurrences + 1,
        lastSeenAt: now,
        // A resolved error that recurs is not resolved.
        status: existing.status === 'resolved' ? 'open' : existing.status,
      });
      return { success: true as const, recorded: true };
    }

    await ctx.db.insert('errorReports', {
      source: args.source === 'reported' ? 'reported' : 'caught',
      message,
      stack: args.stack?.slice(0, MAX_STACK),
      path: safePath(args.url),
      context,
      userAgent: args.userAgent?.slice(0, 300),
      userId: user?._id,
      userEmail: user?.email,
      note: args.note?.slice(0, MAX_NOTE),
      status: 'open',
      occurrences: 1,
      lastSeenAt: now,
      createdAt: now,
    });

    return { success: true as const, recorded: true };
  },
});

/** The admin list. Bounded, newest first. */
export const list = query({
  args: { token: v.string(), status: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, { token, status, limit }) => {
    await requireAdmin(ctx, token);
    const cap = Math.min(Math.max(limit ?? 100, 1), 300);

    const rows = status
      ? await ctx.db
          .query('errorReports')
          .withIndex('by_status_and_time', (q) => q.eq('status', status))
          .order('desc')
          .take(cap)
      : await ctx.db.query('errorReports').withIndex('by_time').order('desc').take(cap);

    return rows.map((r) => ({
      id: r._id,
      source: r.source,
      message: r.message,
      stack: r.stack,
      path: r.path,
      context: r.context,
      note: r.note,
      userEmail: r.userEmail,
      status: r.status,
      occurrences: r.occurrences,
      lastSeenAt: r.lastSeenAt,
      createdAt: r.createdAt,
    }));
  },
});

/** Acknowledge or resolve one. */
export const setStatus = mutation({
  args: {
    token: v.string(),
    reportId: v.id('errorReports'),
    status: v.union(v.literal('open'), v.literal('acknowledged'), v.literal('resolved')),
  },
  handler: async (ctx, { token, reportId, status }) => {
    const admin = await requireAdmin(ctx, token);
    const row = await ctx.db.get(reportId);
    if (!row) return { success: false as const, error: 'Report not found' };

    await ctx.db.patch(reportId, {
      status,
      resolvedBy: status === 'resolved' ? admin._id : undefined,
      resolvedAt: status === 'resolved' ? Date.now() : undefined,
    });
    return { success: true as const };
  },
});
