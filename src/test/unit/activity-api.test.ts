import { describe, it, expect, vi, beforeEach } from 'vitest';
import { convexMock } from '../mocks/convex';
import { activityApi } from '../../lib/api/activity';
import { mockInternUser, seedLocalStorage } from '../fixtures';

/**
 * What this file asserts changed with the module.
 *
 * The Supabase version checked which RPC name was called and which `p_*`
 * parameters went with it — plumbing that no longer exists. What is worth
 * pinning now is the ADAPTATION: the feed returns camelCase epoch-ms rows and
 * every page in the app reads snake_case ISO, so the mapping in `toPost` is the
 * part that can silently be wrong. Behaviour against a real deployment is
 * covered in `src/test/integration/convex-client-swap.test.ts`.
 */

function convexPost(over: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    content: 'Hello',
    postType: 'text',
    metadata: {},
    streamId: 'stream-1',
    createdAt: 1_700_000_000_000,
    imagePath: null,
    author: {
      id: 'user-1',
      fullName: 'Ada Intern',
      profileSlug: 'ada',
      profilePhotoUrl: 'https://example.test/a.png',
      currentLevel: 3,
    },
    likeCount: 2,
    replyCount: 1,
    likedByMe: true,
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  convexMock.reset();
  vi.clearAllMocks();
});

describe('activityApi', () => {
  describe('getFeed()', () => {
    it('throws when there is no session', async () => {
      await expect(activityApi.getFeed()).rejects.toThrow('Not authenticated');
    });

    it('sends the stored token, the limit and the cursor', async () => {
      seedLocalStorage(mockInternUser, 'feed-token');

      let received: Record<string, unknown> = {};
      convexMock.onQuery('posts.feed', (args) => {
        received = args;
        return [];
      });

      await activityApi.getFeed(15, 1_699_000_000_000, 'stream-9');

      expect(received.token).toBe('feed-token');
      expect(received.limit).toBe(15);
      // The cursor, not an offset. An offset repeats and skips rows on a feed
      // that grows at the head.
      expect(received.before).toBe(1_699_000_000_000);
      expect(received.streamId).toBe('stream-9');
    });

    it('omits the cursor on the first page', async () => {
      seedLocalStorage(mockInternUser, 'tok');

      let received: Record<string, unknown> = {};
      convexMock.onQuery('posts.feed', (args) => {
        received = args;
        return [];
      });

      await activityApi.getFeed();

      expect(received.before).toBeUndefined();
    });

    it('maps a post into the snake_case shape the pages render', async () => {
      seedLocalStorage(mockInternUser, 'tok');
      convexMock.onQuery('posts.feed', () => [convexPost()]);

      const [post] = await activityApi.getFeed();

      expect(post.id).toBe('post-1');
      expect(post.content).toBe('Hello');
      expect(post.stream_id).toBe('stream-1');
      expect(post.likes_count).toBe(2);
      expect(post.replies_count).toBe(1);
      expect(post.user_has_liked).toBe(true);
      expect(post.user.full_name).toBe('Ada Intern');
      expect(post.user.current_level).toBe(3);
      // Epoch ms in, ISO out — every page formats the string.
      expect(post.created_at).toBe(new Date(1_700_000_000_000).toISOString());
      // And the raw value stays, because it is the cursor for the next page.
      expect(post.created_at_ms).toBe(1_700_000_000_000);
    });

    it('never carries an email address out of the feed', async () => {
      seedLocalStorage(mockInternUser, 'tok');
      convexMock.onQuery('posts.feed', () => [convexPost()]);

      // orbit_get_activity_feed joined orbit_users and handed every member's
      // address to every reader.
      const [post] = await activityApi.getFeed();
      expect(post.user.email).toBe('');
    });

    it('renders a post whose author was deleted rather than throwing', async () => {
      seedLocalStorage(mockInternUser, 'tok');
      convexMock.onQuery('posts.feed', () => [convexPost({ author: null })]);

      const [post] = await activityApi.getFeed();
      expect(post.user.full_name).toBe('Unknown');
      expect(post.user_id).toBe('');
    });

    it('builds an absolute image url on the site origin, with no token in it', async () => {
      seedLocalStorage(mockInternUser, 'tok');
      convexMock.onQuery('posts.feed', () => [
        convexPost({ imagePath: '/posts/image?postId=post-1' }),
      ]);

      const [post] = await activityApi.getFeed();

      expect(post.image_url).toBe('https://test.convex.site/posts/image?postId=post-1');
      // The bytes are fetched with a Bearer header by AuthedImage. A token in
      // the query string would land in browser history and referrer headers.
      expect(post.image_url).not.toContain('tok');
    });

    it('leaves image_url null when the post has no image', async () => {
      seedLocalStorage(mockInternUser, 'tok');
      convexMock.onQuery('posts.feed', () => [convexPost()]);

      const [post] = await activityApi.getFeed();
      expect(post.image_url).toBeNull();
    });
  });

  describe('createPost()', () => {
    it('sends the content, stream and image storage id', async () => {
      seedLocalStorage(mockInternUser, 'tok');

      let received: Record<string, unknown> = {};
      convexMock.onMutation('posts.create', (args) => {
        received = args;
        return { success: true, id: 'post-9' };
      });

      await activityApi.createPost('Hello world', 'stream-1', 'storage-7');

      expect(received.token).toBe('tok');
      expect(received.content).toBe('Hello world');
      expect(received.streamId).toBe('stream-1');
      // A storage id, not a url. The mutation attaches it and refuses an id
      // belonging to someone else's upload.
      expect(received.imageStorageId).toBe('storage-7');
    });

    it('surfaces the server error message rather than a generic failure', async () => {
      seedLocalStorage(mockInternUser, 'tok');
      convexMock.onMutation('posts.create', () => ({
        success: false,
        error: 'Post cannot be empty',
      }));

      // These mutations return {success:false, error} instead of throwing, so a
      // client that ignored the result would report success on every refusal.
      await expect(activityApi.createPost('   ')).rejects.toThrow('Post cannot be empty');
    });
  });

  describe('toggleLike()', () => {
    it('returns the new liked state', async () => {
      seedLocalStorage(mockInternUser, 'tok');

      convexMock.onMutation('posts.toggleLike', () => ({ success: true, liked: true }));
      expect(await activityApi.toggleLike('post-1')).toBe(true);

      convexMock.onMutation('posts.toggleLike', () => ({ success: true, liked: false }));
      expect(await activityApi.toggleLike('post-1')).toBe(false);
    });

    it('throws when the post is not reachable', async () => {
      seedLocalStorage(mockInternUser, 'tok');
      convexMock.onMutation('posts.toggleLike', () => ({ success: false, liked: false }));

      // success:false here means the post is gone or in a stream the caller is
      // not in. Returning `false` would render as "you un-liked it".
      await expect(activityApi.toggleLike('post-1')).rejects.toThrow();
    });
  });

  describe('getReplies()', () => {
    it('maps replies into the shape the thread modal renders', async () => {
      seedLocalStorage(mockInternUser, 'tok');
      convexMock.onQuery('posts.replies', () => [
        {
          id: 'reply-1',
          content: 'Nice',
          createdAt: 1_700_000_000_000,
          author: { id: 'user-2', fullName: 'Bem Moderator', currentLevel: 5 },
        },
      ]);

      const [reply] = await activityApi.getReplies('post-1');

      expect(reply.content).toBe('Nice');
      expect(reply.user.full_name).toBe('Bem Moderator');
      expect(reply.user.email).toBe('');
      expect(reply.created_at).toBe(new Date(1_700_000_000_000).toISOString());
    });
  });

  describe('createReply()', () => {
    it('surfaces the server error message', async () => {
      seedLocalStorage(mockInternUser, 'tok');
      convexMock.onMutation('posts.reply', () => ({
        success: false,
        error: 'Reply cannot be empty',
      }));

      await expect(activityApi.createReply('post-1', '  ')).rejects.toThrow(
        'Reply cannot be empty',
      );
    });
  });
});
