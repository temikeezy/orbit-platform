import { query, mutation, internalQuery, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { Doc, Id } from './_generated/dataModel';
import { QueryCtx, MutationCtx } from './_generated/server';
import { requireUser, hasRole, userFromToken } from './lib/auth';
import { activeMembership } from './lib/membership';
import { attachOwnedUpload, releaseUpload } from './files';
import { FIELD, optionalText, text, validate } from './lib/input';
import { agentEmail } from './lib/org';

/**
 * Stream-scoped posts require membership, exactly as streamChat does. Without
 * this any authenticated user could read AND write a private stream's feed by
 * supplying its id — the guard was applied to chat and not to posts, even though
 * they carry the same content.
 */
async function assertStreamAccess(
  ctx: QueryCtx | MutationCtx,
  streamId: Id<'streams'> | undefined,
  user: Doc<'users'>,
) {
  if (!streamId) return;
  if (hasRole(user, 'admin', 'super_admin')) return;

  // activeMembership, not .first() — see convex/lib/membership.ts. A user with a
  // stale inactive row and a live active one reads as a non-member to .first()
  // while every listing counts them as a member.
  if (!(await activeMembership(ctx, streamId, user._id))) {
    throw new Error('Not a member of this stream');
  }
}

/**
 * Activity feed: posts, likes and replies.
 *
 * Replaces orbit_get_activity_feed / orbit_create_post / orbit_create_reply /
 * orbit_toggle_post_like / orbit_get_post_replies / orbit_delete_post.
 *
 * Counts are derived per post rather than stored, so they cannot drift the way
 * streams.memberCount did.
 */

/** Caller-supplied limits are clamped; a negative or huge value otherwise throws
 *  or scans to Convex's system limits. */
function clampLimit(v: number | undefined, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return dflt;
  return Math.min(Math.floor(v), 100);
}

function shapeAuthor(u: Doc<'users'> | null) {
  if (!u) return null;
  return {
    id: u._id,
    fullName: u.fullName,
    profileSlug: u.profileSlug,
    profilePhotoUrl: u.profilePhotoUrl,
    currentLevel: u.currentLevel,
  };
}

async function authorOf(ctx: QueryCtx | MutationCtx, userId: Id<'users'>) {
  return shapeAuthor(await ctx.db.get(userId));
}

async function decorate(
  ctx: QueryCtx | MutationCtx,
  post: Doc<'posts'>,
  viewerId: Id<'users'>,
  // Passed in where the caller has already read it — the feed needs the author
  // to apply showActivityOnFeed, and fetching the same row again per post
  // doubled the read count of the busiest query in the app.
  prefetchedAuthor?: Doc<'users'> | null,
) {
  const [likes, replies, author] = await Promise.all([
    ctx.db.query('postLikes').withIndex('by_post', (q) => q.eq('postId', post._id)).collect(),
    ctx.db.query('postReplies').withIndex('by_post', (q) => q.eq('postId', post._id)).collect(),
    prefetchedAuthor === undefined ? authorOf(ctx, post.userId) : Promise.resolve(shapeAuthor(prefetchedAuthor)),
  ]);

  return {
    id: post._id,
    content: post.content,
    postType: post.postType,
    metadata: post.metadata,
    streamId: post.streamId,
    createdAt: post.createdAt,
    // Lets the feed mark a post as edited without keeping its history.
    editedAt: post.editedAt,
    // A path, not a url. The image is served by /posts/image, which checks the
    // session and the stream — a feed image in a private stream must not be
    // readable by anyone holding a link.
    imagePath: post.imageId ? `/posts/image?postId=${post._id}` : null,
    author,
    likeCount: likes.length,
    replyCount: replies.length,
    likedByMe: likes.some((l) => l.userId === viewerId),
  };
}

export const feed = query({
  args: {
    token: v.string(),
    streamId: v.optional(v.id('streams')),
    limit: v.optional(v.number()),
    /**
     * Cursor: return posts strictly older than this timestamp.
     *
     * The Postgres RPC paginated with LIMIT/OFFSET, which on a feed that grows
     * at the head silently repeats and skips rows — every post created while
     * the reader is scrolling shifts the whole window by one. A timestamp
     * cursor is stable under insertion, and the client already has the value:
     * it is the createdAt of the last post it rendered.
     */
    before: v.optional(v.number()),
  },
  handler: async (ctx, { token, streamId, limit, before }) => {
    const user = await requireUser(ctx, token);
    await assertStreamAccess(ctx, streamId, user);

    const take = clampLimit(limit, 30);
    const staff = hasRole(user, 'admin', 'super_admin');

    /**
     * The GLOBAL feed has to filter by membership too.
     *
     * `assertStreamAccess` returns early when no streamId is given, which is
     * right — there is no single stream to check — but it left the unfiltered
     * branch below reading the whole posts table. Omitting the argument and
     * walking the cursor returned every post in every private stream, with the
     * author attached, to any authenticated caller. The gated branch and the
     * ungated one have to agree, so the viewer's memberships are resolved once
     * and applied to the rows.
     */
    const visibleStreams = new Set<string>();
    if (!staff) {
      const memberships = await ctx.db
        .query('streamMemberships')
        .withIndex('by_user', (q) => q.eq('userId', user._id))
        .collect();
      for (const m of memberships) if (m.isActive) visibleStreams.add(m.streamId);
    }

    const canSee = (post: Doc<'posts'>) =>
      /**
       * HIDDEN DEBRIS STAYS HIDDEN.
       *
       * `isDummy` is the flag the rest of the platform already uses to keep
       * seeded and test content out of member-facing views — `mentionsOfMe`
       * honours it two hundred lines below, as do the leaderboard, badges and
       * the letters register. THIS query did not, which made
       * `resetFeedForLaunch` a no-op from the reader's point of view: it marked
       * six weeks-old test posts `isDummy: true`, reported six cleared, and the
       * home feed went on rendering every one of them.
       *
       * Marking is the soft delete; this is what makes the mark mean something.
       */
      !post.isDummy &&
      // A post with no stream is platform-wide and public to members.
      (!post.streamId || staff || visibleStreams.has(post.streamId));

    /**
     * Both filters run BEFORE the page is cut, not after.
     *
     * Filtering a `.take(n)` result returns short pages, and the client decides
     * whether more exist by comparing the page length to what it asked for — so
     * one post from a muted author would end the feed early and hide everything
     * below it. This over-fetches instead, and gives up rather than scanning
     * forever when almost everything is filtered out.
     */
    const out = [];
    let cursor = before;

    for (let round = 0; round < 5 && out.length < take; round++) {
      const batch = streamId
        ? await ctx.db
            .query('posts')
            .withIndex('by_stream', (q) =>
              cursor === undefined
                ? q.eq('streamId', streamId)
                : q.eq('streamId', streamId).lt('createdAt', cursor),
            )
            .order('desc')
            .take(take * 2)
        : await ctx.db
            .query('posts')
            .withIndex('by_time', (q) => (cursor === undefined ? q : q.lt('createdAt', cursor)))
            .order('desc')
            .take(take * 2);

      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].createdAt;

      for (const p of batch) {
        if (out.length >= take) break;
        if (!canSee(p)) continue;

        const author = await ctx.db.get(p.userId);
        // Authors who opted out of the activity feed are excluded, a privacy
        // flag the Postgres feed RPC did not consult.
        if (author && !author.showActivityOnFeed && author._id !== user._id) continue;

        out.push(await decorate(ctx, p, user._id, author));
      }

      if (batch.length < take * 2) break;
    }

    return out;
  },
});

export const create = mutation({
  args: {
    token: v.string(),
    content: v.string(),
    // The client may not choose this. 'badge', 'submission' and 'leaderboard'
    // render with platform chrome — ActivityItem draws a trophy and hides the
    // delete control for them — so an unvalidated string let any member publish
    // a post that looks like a system-generated award and could not be removed
    // from the UI afterwards. System posts are written by internal mutations,
    // which do not come through here.
    postType: v.optional(v.literal('text')),
    streamId: v.optional(v.id('streams')),
    imageStorageId: v.optional(v.id('_storage')),
  },
  handler: async (ctx, { token, content, postType, streamId, imageStorageId }) => {
    const user = await requireUser(ctx, token);

    await assertStreamAccess(ctx, streamId, user);

    const trimmed = content.trim();
    if (!trimmed && !imageStorageId) {
      return { success: false as const, error: 'Post cannot be empty' };
    }

    // Bounded. An image-only post is legitimate, so emptiness is handled above
    // and this only caps the length of whatever text there is.
    const bounded = validate(() => optionalText(trimmed, 'Post', FIELD.postContent));
    if (!bounded.ok) return { success: false as const, error: bounded.error };

    // The image is attached HERE, to this post, by the member who uploaded it.
    // An id somebody else uploaded is refused rather than adopted.
    if (imageStorageId && !(await attachOwnedUpload(ctx, user._id, imageStorageId))) {
      return { success: false as const, error: 'That image upload was not found.' };
    }

    const now = Date.now();
    const id = await ctx.db.insert('posts', {
      userId: user._id,
      streamId,
      content: bounded.value ?? '',
      postType: postType ?? 'text',
      // `metadata` is NOT accepted from the client. It was v.any(), written
      // unvalidated and returned verbatim to every reader — a per-post
      // arbitrary-JSON store, and a trap for the next component to trust
      // `metadata.image_url`, which is exactly the public-bucket url this
      // migration removed. Rows imported from Postgres keep theirs.
      imageId: imageStorageId,
      isDummy: false,
      createdAt: now,
      updatedAt: now,
    });

    /**
     * A post by the agent or a supervisor notifies its audience. An intern's
     * does not.
     *
     * Posts used to notify nobody at all, so the welcome message reached only
     * whoever opened the feed — on a cohort where a third have never signed in,
     * that is most people missed.
     *
     * The line is drawn at the AUTHOR rather than at a per-post switch, because
     * that is the distinction that actually holds: staff posting to a feed is
     * an announcement, and an intern posting is conversation. Fanning out
     * conversation would mail every member about every comment until people
     * filtered ORBIT to spam, and then the notifications that matter stop
     * landing too.
     *
     * SCHEDULED, not awaited. `runAfter(0)` gives the fan-out its own
     * transaction, so a home-feed post addressing the whole platform cannot
     * push this insert past a Convex transaction limit and roll the post back.
     */
    // Admin, super admin OR moderator — a supervisor is a `moderator`, and
    // this is exactly the set whose posts are announcements rather than chat.
    if (hasRole(user, 'admin', 'super_admin', 'moderator')) {
      await ctx.scheduler.runAfter(0, internal.notificationsInternal.notifyNewPost, {
        postId: id,
      });
    }

    return { success: true as const, id };
  },
});

export const toggleLike = mutation({
  args: { token: v.string(), postId: v.id('posts') },
  handler: async (ctx, { token, postId }) => {
    const user = await requireUser(ctx, token);

    const post = await assertPostAccess(ctx, postId, user);
    if (!post) return { success: false as const, liked: false };

    const existing = await ctx.db
      .query('postLikes')
      .withIndex('by_post_and_user', (q) => q.eq('postId', postId).eq('userId', user._id))
      .first();

    if (existing) {
      await ctx.db.delete(existing._id);
      return { success: true as const, liked: false };
    }

    await ctx.db.insert('postLikes', { postId, userId: user._id, createdAt: Date.now() });
    return { success: true as const, liked: true };
  },
});

/**
 * Applies the stream guard to a post the caller reached by id.
 *
 * `feed` and `create` take a streamId and check it. `replies`, `reply` and
 * `toggleLike` take a POST id, so the stream they touch is whatever that post
 * belongs to — and none of them looked. Any authenticated member holding a post
 * id from a private stream (from a notification's actionUrl, a pasted link, or
 * relayed by the agent through check_mentions) could read its whole reply thread
 * and post into it. That is the same hole this file's header describes closing
 * for the feed.
 */
async function assertPostAccess(
  ctx: QueryCtx | MutationCtx,
  postId: Id<'posts'>,
  user: Doc<'users'>,
) {
  const post = await ctx.db.get(postId);
  if (!post) return null;
  await assertStreamAccess(ctx, post.streamId, user);
  return post;
}

export const replies = query({
  args: { token: v.string(), postId: v.id('posts') },
  handler: async (ctx, { token, postId }) => {
    const user = await requireUser(ctx, token);
    await assertPostAccess(ctx, postId, user);

    const rows = await ctx.db
      .query('postReplies')
      .withIndex('by_post', (q) => q.eq('postId', postId))
      .collect();

    const out = [];
    for (const r of rows.sort((a, b) => a.createdAt - b.createdAt)) {
      out.push({
        id: r._id,
        content: r.content,
        createdAt: r.createdAt,
        author: await authorOf(ctx, r.userId),
      });
    }
    return out;
  },
});

export const reply = mutation({
  args: { token: v.string(), postId: v.id('posts'), content: v.string() },
  handler: async (ctx, { token, postId, content }) => {
    const user = await requireUser(ctx, token);

    const post = await assertPostAccess(ctx, postId, user);
    if (!post) return { success: false as const, error: 'Post not found' };

    const bounded = validate(() => text(content, 'Reply', FIELD.postReply));
    if (!bounded.ok) return { success: false as const, error: bounded.error };

    const id = await ctx.db.insert('postReplies', {
      postId,
      userId: user._id,
      content: bounded.value,
      isDummy: false,
      createdAt: Date.now(),
    });

    // Was check_badges_on_activity, an AFTER INSERT trigger. The 'consistency'
    // badge measures a user's replies, so without this call those badges are
    // only ever evaluated when the user next earns points — which for someone
    // who only comments is never.
    await ctx.runMutation(internal.badges.checkAndAward, { userId: user._id });

    return { success: true as const, id };
  },
});

/**
 * Recent posts and replies that mention the caller. Admin only.
 *
 * Backs the MCP `check_mentions` tool, which scanned every post and reply in the
 * window with the service key — including posts in private streams the actor was
 * not a member of. Admin-gated here because it is still a content sweep across
 * stream boundaries; the actor is an admin, for whom that is already permitted.
 *
 * The keyword list keeps the five hardcoded `@ORBIT Agent` spellings the tool
 * used (people are typing those today) and adds the caller's own name and slug,
 * which it never matched — so nobody addressing the agent by its actual account
 * name was ever picked up.
 */
export const mentionsOfMe = query({
  args: { token: v.string(), hoursBack: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, { token, hoursBack, limit }) => {
    const me = await requireUser(ctx, token);
    if (!hasRole(me, 'admin', 'super_admin')) throw new Error('Admin access required');

    const hours = Math.min(Math.max(hoursBack ?? 24, 1), 24 * 30);
    const cutoff = Date.now() - hours * 3600 * 1000;
    const cap = clampLimit(limit, 30);

    // A short handle would match a large share of all content — an actor named
    // "AI" yields the keyword "@ai". fullName is self-editable, so the floor is
    // enforced here rather than assumed.
    const own = [me.fullName, me.profileSlug]
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length >= 4)
      .map((s) => `@${s}`);

    const keywords = ['@orbit agent', '@orbit-agent', '@orbitagent', '@orbit_agent', ...own];

    const mentions = (content: string) => {
      const haystack = content.toLowerCase();
      return keywords.some((k) => haystack.includes(k));
    };

    const posts = await ctx.db
      .query('posts')
      .withIndex('by_time', (q) => q.gt('createdAt', cutoff))
      .order('desc')
      .take(500);

    // Windowed on by_time, not collected wholesale. Scanning the entire replies
    // table and discarding everything outside the window worked at today's size
    // and had a hard expiry date: postReplies is the fastest-growing table here.
    const replies = await ctx.db
      .query('postReplies')
      .withIndex('by_time', (q) => q.gt('createdAt', cutoff))
      .order('desc')
      .take(500);

    const hits: Array<{
      id: string;
      source: 'post' | 'reply';
      postId: string;
      content: string;
      createdAt: number;
      author: Awaited<ReturnType<typeof authorOf>>;
    }> = [];

    for (const p of posts) {
      if (p.isDummy || p.userId === me._id || !mentions(p.content)) continue;
      hits.push({
        id: p._id,
        source: 'post',
        postId: p._id,
        content: p.content,
        createdAt: p.createdAt,
        author: await authorOf(ctx, p.userId),
      });
    }

    for (const r of replies) {
      if (r.isDummy || r.userId === me._id) continue;
      if (!mentions(r.content)) continue;
      hits.push({
        id: r._id,
        source: 'reply',
        postId: r.postId,
        content: r.content,
        createdAt: r.createdAt,
        author: await authorOf(ctx, r.userId),
      });
    }

    return hits.sort((a, b) => b.createdAt - a.createdAt).slice(0, cap);
  },
});

/**
 * Removes a post. Author, or admin.
 *
 * Deletes the likes and replies with it — Convex has no cascade, so leaving them
 * behind would orphan rows that every count query still walks.
 */
/**
 * Edits a post or a reply. AUTHOR ONLY.
 *
 * Deliberately narrower than `remove`, which admins may also call. Deleting
 * someone's post is moderation — removing something that should not be there.
 * Rewriting it is impersonation: the post keeps their name and their timestamp
 * while saying something they did not write, and nothing on the screen tells a
 * reader it changed hands. Nobody needs that, so nobody gets it.
 *
 * `editedAt` is set so the feed can say a post was edited. Without it the same
 * impersonation risk applies to the author themselves — quietly rewriting a
 * post after people have replied to it changes what the thread appears to be
 * about.
 */
export const update = mutation({
  args: { token: v.string(), postId: v.id('posts'), content: v.string() },
  handler: async (ctx, { token, postId, content }) => {
    const user = await requireUser(ctx, token);

    const post = await ctx.db.get(postId);
    if (!post) return { success: false as const, error: 'Post not found' };
    if (post.userId !== user._id) {
      return { success: false as const, error: 'You can only edit your own posts' };
    }

    /**
     * ONLY WHAT THE AUTHOR WROTE — enforced HERE, not just in the UI.
     *
     * The feed carries generated records as well as written posts: a badge
     * earned, a task submitted, an announcement. Those describe something that
     * happened, and the platform is the one making the claim. The edit control
     * was already restricted to `post_type === 'text'` on the client, but with
     * no row-level security that restriction was decoration — a direct call
     * could rewrite any of the author's own generated records into whatever
     * they liked, under the platform's voice.
     */
    if (post.postType !== 'text') {
      return {
        success: false as const,
        error: 'Only posts you wrote can be edited. This one is a record of something that happened.',
      };
    }

    const bounded = validate(() => text(content, 'Post', FIELD.postContent));
    if (!bounded.ok) return { success: false as const, error: bounded.error };

    await ctx.db.patch(postId, {
      content: bounded.value,
      editedAt: Date.now(),
      updatedAt: Date.now(),
    });

    return { success: true as const };
  },
});

/**
 * Edits a reply. AUTHOR ONLY, for the same reason as `update`.
 *
 * Separate because replies are their own table with their own length bound —
 * `postReplies`, not a post carrying a parent.
 */
export const updateReply = mutation({
  args: { token: v.string(), replyId: v.id('postReplies'), content: v.string() },
  handler: async (ctx, { token, replyId, content }) => {
    const user = await requireUser(ctx, token);

    const row = await ctx.db.get(replyId);
    if (!row) return { success: false as const, error: 'Comment not found' };
    if (row.userId !== user._id) {
      return { success: false as const, error: 'You can only edit your own comments' };
    }

    const bounded = validate(() => text(content, 'Reply', FIELD.postReply));
    if (!bounded.ok) return { success: false as const, error: bounded.error };

    await ctx.db.patch(replyId, { content: bounded.value, editedAt: Date.now() });
    return { success: true as const };
  },
});

/**
 * Deletes a reply.
 *
 * Author OR an admin, matching `remove` for posts: taking something down is
 * moderation, which admins do; rewriting it is not, which is why `updateReply`
 * above is author-only.
 */
export const removeReply = mutation({
  args: { token: v.string(), replyId: v.id('postReplies') },
  handler: async (ctx, { token, replyId }) => {
    const user = await requireUser(ctx, token);

    const row = await ctx.db.get(replyId);
    // Idempotent: the feed calls this on ids that may already be gone.
    if (!row) return { success: true as const };
    if (row.userId !== user._id && !hasRole(user, 'admin', 'super_admin')) {
      return { success: false as const, error: 'You can only delete your own comments' };
    }

    await ctx.db.delete(replyId);
    return { success: true as const };
  },
});

export const remove = mutation({
  args: { token: v.string(), postId: v.id('posts') },
  handler: async (ctx, { token, postId }) => {
    const user = await requireUser(ctx, token);

    const post = await ctx.db.get(postId);
    if (!post) return { success: true as const };

    if (post.userId !== user._id && !hasRole(user, 'admin', 'super_admin')) {
      throw new Error('You can only delete your own posts');
    }

    const [likes, replies] = await Promise.all([
      ctx.db.query('postLikes').withIndex('by_post', (q) => q.eq('postId', postId)).collect(),
      ctx.db.query('postReplies').withIndex('by_post', (q) => q.eq('postId', postId)).collect(),
    ]);

    for (const l of likes) await ctx.db.delete(l._id);
    for (const r of replies) await ctx.db.delete(r._id);

    // The image goes with the post. Leaving it would be a file nothing points
    // at, still reachable, still billed.
    await releaseUpload(ctx, post.imageId);

    // Comments and reactions target this post too; leaving them behind
    // contradicted this function's own no-orphans intent.
    for (const table of ['comments', 'reactions'] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_target', (q) => q.eq('targetType', 'post').eq('targetId', postId))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }

    await ctx.db.delete(postId);

    return { success: true as const };
  },
});


/**
 * Backs the `/posts/image` httpAction.
 *
 * Internal, because it returns a storage id. The route checks the session; this
 * checks the stream — a feed image posted in a private stream must not be
 * readable by anyone who ends up with the link, which is exactly what returning
 * `ctx.storage.getUrl()` from `uploadPostImage` used to allow.
 */
export const imageFor = internalQuery({
  args: { token: v.string(), postId: v.id('posts') },
  handler: async (ctx, { token, postId }) => {
    const viewer = await userFromToken(ctx, token);
    if (!viewer) return null;

    const post = await ctx.db.get(postId);
    if (!post?.imageId) return null;

    if (post.streamId && !hasRole(viewer, 'admin', 'super_admin')) {
      if (!(await activeMembership(ctx, post.streamId, viewer._id))) return null;
    }

    return { storageId: post.imageId };
  },
});

/**
 * Clears test posts and publishes the welcome, as the ORBIT Agent.
 *
 * The feed is the first thing a new intern sees, and it currently holds six
 * posts: two people typing "Testing", three MCP connection checks, and one
 * automated roundup from July. None of them means anything to someone arriving
 * today, and a feed of debris reads as a platform nobody is looking after.
 *
 * Marks rather than deletes, so the rows survive for anyone auditing what was
 * there — `isDummy` is the flag the rest of the platform already uses to keep
 * seed and test content out of member-facing views.
 */
export const resetFeedForLaunch = internalMutation({
  args: { dryRun: v.optional(v.boolean()), content: v.string() },
  handler: async (ctx, { dryRun, content }) => {
    const posts = await ctx.db.query('posts').collect();

    /**
     * What counts as debris. Deliberately conservative — a post is only cleared
     * if it names itself as a test or is a machine-generated roundup. Anything
     * a member wrote in earnest stays, even if it is short.
     */
    const DEBRIS = /^\s*(testing|test\b)|MCP\b|connection verified|verification test|Weekly Submission Roundup/i;

    /**
     * A short post that says "test" is a test, wherever the word falls.
     * Anchoring on the start missed "@Someone hello. Testing" — plainly the same
     * thing. Bounded to short posts so a genuine piece of writing that happens
     * to discuss testing is never caught by this.
     */
    const SHORT_TEST = (c: string) => c.length < 80 && /\btest(ing)?\b/i.test(c);

    let cleared = 0;
    for (const post of posts) {
      if (post.isDummy) continue;
      const content = post.content ?? '';
      if (!DEBRIS.test(content) && !SHORT_TEST(content)) continue;
      if (!dryRun) await ctx.db.patch(post._id, { isDummy: true, dummySource: 'pre-launch feed reset', updatedAt: Date.now() });
      cleared++;
    }

    // The agent posts as itself, so the feed shows who is speaking.
    const agent = await ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', agentEmail()))
      .unique();

    if (!agent) return { ok: false as const, error: 'ORBIT Agent account not found.', cleared };

    const already = posts.some((p) => !p.isDummy && p.userId === agent._id && (p.content ?? '').startsWith('Welcome to ORBIT'));
    if (!already && !dryRun) {
      const now = Date.now();
      await ctx.db.insert('posts', {
        userId: agent._id,
        content,
        postType: 'announcement',
        isDummy: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    return { ok: true as const, dryRun: Boolean(dryRun), cleared, welcomePosted: !already, remaining: posts.length - cleared };
  },
});

/**
 * A one-off content correction on a post the caller did not write.
 *
 * `posts.update` is author-only ON PURPOSE and has no admin override: with no
 * row-level security, an admin-editable feed means the platform's own voice can
 * be rewritten by anyone holding an admin session, and nothing in the row would
 * show it had happened. That guard should stay.
 *
 * This exists for the case the guard does not cover — a post on the shared home
 * feed that the organisation needs changed and whose author is not to hand. It
 * is INTERNAL, so it cannot be reached from a session at all; it can only be
 * run by someone holding deployment credentials, which is a materially higher
 * bar than an admin login. Every use writes an audit row naming the old and new
 * content, so the edit is never invisible.
 */
export const adminCorrectPostContent = internalMutation({
  args: { postId: v.id('posts'), content: v.string(), reason: v.string() },
  returns: v.object({ success: v.boolean(), previous: v.optional(v.string()) }),
  handler: async (ctx, { postId, content, reason }) => {
    const post = await ctx.db.get(postId);
    if (!post) return { success: false as const };

    // Same restriction the author path enforces: a generated record describes
    // something that happened and must not be rewritten into a claim.
    if (post.postType !== 'text') return { success: false as const };

    const previous = post.content;
    const now = Date.now();

    await ctx.db.patch(postId, { content, editedAt: now, updatedAt: now });

    await ctx.db.insert('auditLogs', {
      userId: post.userId,
      userEmail: 'system',
      userRoles: [],
      action: 'post.admin_correct',
      tableName: 'posts',
      recordId: postId,
      oldValues: { content: previous },
      newValues: { content, reason },
      success: true,
      createdAt: now,
    });

    return { success: true as const, previous };
  },
});

/**
 * Publishes a post as the ORBIT Agent, at a time chosen in advance.
 *
 * WHY THIS EXISTS RATHER THAN A CRON. A cron runs a schedule; this runs a
 * calendar — four specific messages on four specific mornings, each written and
 * reviewed before any of them goes out. Convex's scheduler holds them
 * server-side, so they arrive whether or not anyone's laptop is open, and a
 * queued one can be inspected or cancelled from the dashboard before it fires.
 *
 * IT NOTIFIES, because that is what the agent posting is for. `posts.create`
 * fans out for staff authors; this is the same fan-out on the same terms, and
 * it costs one email per person on the platform — which is the reason these are
 * scheduled deliberately rather than posted whenever something comes to mind.
 */
export const publishAgentPost = internalMutation({
  args: { content: v.string(), authorEmail: v.string() },
  returns: v.object({ posted: v.boolean(), id: v.optional(v.id('posts')) }),
  handler: async (ctx, { content, authorEmail }) => {
    const author = await ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', authorEmail))
      .unique();

    // Refuses rather than posting as somebody else. A scheduled message that
    // does not go out is a gap; one that goes out under the wrong name is worse.
    if (!author || !author.isActive) return { posted: false };

    const now = Date.now();
    const id = await ctx.db.insert('posts', {
      userId: author._id,
      content,
      postType: 'text',
      isDummy: false,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.notificationsInternal.notifyNewPost, {
      postId: id,
    });

    return { posted: true, id };
  },
});

/** Queues one agent post for a given instant. Returns the scheduler job id. */
export const scheduleAgentPost = internalMutation({
  args: { content: v.string(), authorEmail: v.string(), atMs: v.number() },
  returns: v.object({ scheduled: v.boolean(), jobId: v.optional(v.string()) }),
  /** Annotated for the same TS7022 reason as tasks.create — see that comment. */
  handler: async (
    ctx,
    { content, authorEmail, atMs },
  ): Promise<{ scheduled: boolean; jobId?: string }> => {
    // A time already past would fire immediately, which is never what a
    // schedule meant.
    if (atMs <= Date.now()) return { scheduled: false };

    const jobId = await ctx.scheduler.runAt(atMs, internal.posts.publishAgentPost, {
      content,
      authorEmail,
    });

    return { scheduled: true, jobId: String(jobId) };
  },
});
