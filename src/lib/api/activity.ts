import { convexHttp as convex } from '../convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../auth';
import { convexSiteUrl } from '../convex';

/**
 * The activity feed, on Convex.
 *
 * Two shape changes the call sites had to absorb:
 *
 * 1. PAGINATION IS A CURSOR, NOT AN OFFSET. `orbit_get_activity_feed` took
 *    LIMIT/OFFSET, which on a feed that grows at the head repeats and skips
 *    rows — every post created while someone scrolls shifts the whole window.
 *    `getFeed` now takes the createdAt of the last post rendered.
 *
 * 2. POST IMAGES ARE NOT PUBLIC URLS. The old flow uploaded to a public bucket
 *    and stored the resulting url in `metadata.image_url`, so a feed image
 *    posted in a private stream was readable by anyone who ended up with the
 *    link. The image is now a storage id attached to the post, served by
 *    `/posts/image`, which re-checks the session and the stream on every fetch.
 */

export interface ActivityPost {
  id: string;
  content: string;
  post_type: 'text' | 'submission' | 'badge' | 'leaderboard';
  metadata: Record<string, unknown>;
  created_at: string;
  /** Set when the author rewrote it; the feed shows an "(edited)" marker. */
  edited_at?: string;
  /** Epoch ms — the cursor for the next page. */
  created_at_ms: number;
  updated_at: string;
  stream_id?: string;
  user_id: string;
  user: {
    id: string;
    full_name: string;
    email: string;
    profile_photo_url?: string;
    roles: string[];
    current_level: number;
  };
  stream?: {
    id: string;
    name: string;
    description: string;
  };
  /** Absolute, session-checked. Null when the post has no image. */
  image_url: string | null;
  likes_count: number;
  replies_count: number;
  user_has_liked: boolean;
}

export interface PostReply {
  id: string;
  content: string;
  created_at: string;
  user: {
    id: string;
    full_name: string;
    email: string;
    profile_photo_url?: string;
    roles: string[];
  };
}

interface ConvexAuthor {
  id: string;
  fullName: string;
  profileSlug?: string;
  profilePhotoUrl?: string;
  currentLevel: number;
}

interface ConvexPost {
  id: string;
  content: string;
  postType: string;
  metadata?: Record<string, unknown>;
  streamId?: string;
  createdAt: number;
  imagePath: string | null;
  author: ConvexAuthor | null;
  likeCount: number;
  replyCount: number;
  likedByMe: boolean;
  editedAt?: number;
}

function requireToken(): string {
  const token = authService.getToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}

/**
 * The absolute URL of a post's image, to be fetched WITH the session header.
 *
 * Deliberately not something an `<img src>` can load directly: the route takes
 * a Bearer token, and putting a session token in a query string would leak it
 * into browser history and referrer headers. `AuthedImage` fetches this and
 * renders the bytes. The calendar feed does use a URL token, but a dedicated
 * rotatable one — not the session.
 */
function imageUrl(path: string | null): string | null {
  return path ? `${convexSiteUrl}${path}` : null;
}

function toPost(p: ConvexPost): ActivityPost {
  const author = p.author;

  return {
    id: p.id,
    content: p.content,
    post_type: p.postType as ActivityPost['post_type'],
    metadata: p.metadata ?? {},
    created_at: new Date(p.createdAt).toISOString(),
    edited_at: p.editedAt ? new Date(p.editedAt).toISOString() : undefined,
    created_at_ms: p.createdAt,
    updated_at: new Date(p.createdAt).toISOString(),
    stream_id: p.streamId,
    user_id: author?.id ?? '',
    user: {
      id: author?.id ?? '',
      full_name: author?.fullName ?? 'Unknown',
      // Never returned by the feed. The Postgres RPC joined orbit_users and
      // handed every member's address to every reader.
      email: '',
      profile_photo_url: author?.profilePhotoUrl,
      roles: [],
      current_level: author?.currentLevel ?? 1,
    },
    image_url: imageUrl(p.imagePath),
    likes_count: p.likeCount,
    replies_count: p.replyCount,
    user_has_liked: p.likedByMe,
  };
}

export const activityApi = {
  /**
   * One page of the feed.
   *
   * `before` is the `created_at_ms` of the last post already rendered. Omit it
   * for the first page. `streamId` filters server-side — StreamDetailPage used
   * to fetch the global feed and filter it in the browser, which meant its
   * "stream feed" was really the newest 30 posts platform-wide, then narrowed,
   * and usually empty.
   */
  async getFeed(limit = 20, before?: number, streamId?: string): Promise<ActivityPost[]> {
    const rows = (await convex.query(api.posts.feed, {
      token: requireToken(),
      limit,
      before,
      streamId: streamId as never,
    })) as ConvexPost[];

    return rows.map(toPost);
  },

  async createPost(content: string, streamId?: string, imageStorageId?: string): Promise<void> {
    const result = await convex.mutation(api.posts.create, {
      token: requireToken(),
      content,
      streamId: streamId as never,
      imageStorageId: imageStorageId as never,
    });

    if (!result.success) throw new Error(result.error);
  },

  /**
   * Uploads a post image and returns its STORAGE ID, not a url.
   *
   * The id is passed to `createPost`, which attaches it to the post it creates.
   * An id belonging to someone else's upload is refused there rather than
   * adopted — the claim table is what stops a caller attaching, and later
   * deleting, a file they do not own.
   */
  async uploadPostImage(file: File, _userId?: string): Promise<string> {
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

    // Type and size are checked against the STORED object's metadata, not the
    // File the browser reported. Rejection deletes the object, so a refused
    // upload does not sit in storage being billed.
    const validated = await convex.mutation(api.files.validatePostImage, {
      token,
      storageId: storageId as never,
    });
    if (!validated.success) throw new Error(validated.error);

    return storageId;
  },

  async getReplies(postId: string): Promise<PostReply[]> {
    const rows = (await convex.query(api.posts.replies, {
      token: requireToken(),
      postId: postId as never,
    })) as { id: string; content: string; createdAt: number; author: ConvexAuthor | null }[];

    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      created_at: new Date(r.createdAt).toISOString(),
      user: {
        id: r.author?.id ?? '',
        full_name: r.author?.fullName ?? 'Unknown',
        email: '',
        profile_photo_url: r.author?.profilePhotoUrl,
        roles: [],
      },
    }));
  },

  async createReply(postId: string, content: string): Promise<void> {
    const result = await convex.mutation(api.posts.reply, {
      token: requireToken(),
      postId: postId as never,
      content,
    });

    if (!result.success) throw new Error(result.error);
  },

  async toggleLike(postId: string): Promise<boolean> {
    const result = await convex.mutation(api.posts.toggleLike, {
      token: requireToken(),
      postId: postId as never,
    });

    if (!result.success) throw new Error('Could not react to that post.');
    return result.liked;
  },

  /**
   * Rewrites a post. Author only — the server enforces it.
   *
   * Deleting is moderation and admins may do it; rewriting is not, because a
   * post keeps its author's name and timestamp while saying something new.
   */
  async editPost(postId: string, content: string): Promise<void> {
    const result = await convex.mutation(api.posts.update, {
      token: requireToken(),
      postId: postId as never,
      content,
    });
    if (!result.success) throw new Error(result.error ?? 'Could not edit this post');
  },

  async editReply(replyId: string, content: string): Promise<void> {
    const result = await convex.mutation(api.posts.updateReply, {
      token: requireToken(),
      replyId: replyId as never,
      content,
    });
    if (!result.success) throw new Error(result.error ?? 'Could not edit this comment');
  },

  async deleteReply(replyId: string): Promise<void> {
    const result = await convex.mutation(api.posts.removeReply, {
      token: requireToken(),
      replyId: replyId as never,
    });
    if (!result.success) throw new Error(result.error ?? 'Could not delete this comment');
  },

  async deletePost(postId: string): Promise<void> {
    await convex.mutation(api.posts.remove, {
      token: requireToken(),
      postId: postId as never,
    });
  },
};
