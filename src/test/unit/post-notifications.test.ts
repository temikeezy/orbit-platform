import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const code = (src: string, name: string) => {
  const start = src.indexOf(`export const ${name} =`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = src.indexOf('export const', start + 10);
  return src
    .slice(start, next === -1 ? undefined : next)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
};

/**
 * A post by the agent or a supervisor notifies people. An intern's does not.
 *
 * Posts used to notify nobody at all — `posts.create` scheduled nothing, so the
 * welcome message reached only whoever opened the feed that day. On a cohort
 * where a third have never signed in, that is most of the audience missed.
 *
 * The half that matters more is the restriction. Every recipient of a
 * notification also gets an EMAIL — `createNotification` writes both — so
 * fanning out ordinary intern conversation would mail every member about every
 * comment until people filtered ORBIT to spam, and then the notifications that
 * do matter stop landing too. One home-feed post already costs one email per
 * person on the platform.
 */
describe('post notifications', () => {
  const posts = read('convex/posts.ts');
  const notif = read('convex/notificationsInternal.ts');

  it('notifies when the author is staff', () => {
    const body = code(posts, 'create');
    expect(body).toContain('notifyNewPost');
    expect(body).toMatch(/hasRole\(user, 'admin', 'super_admin', 'moderator'\)/);
  });

  it('does not notify for an ordinary member post', () => {
    // The gate is the whole feature. Without it every intern comment mails the
    // entire stream.
    const body = code(posts, 'create');
    const gate = body.indexOf("hasRole(user, 'admin', 'super_admin', 'moderator')");
    const call = body.indexOf('notifyNewPost');
    expect(gate).toBeGreaterThan(-1);
    expect(call, 'the fan-out must sit inside the staff check').toBeGreaterThan(gate);
  });

  it('schedules the fan-out rather than running it inline', () => {
    // A home-feed post addresses everyone; doing that in the same transaction
    // as the insert would risk rolling the post itself back.
    expect(code(posts, 'create')).toContain('scheduler.runAfter(0');
  });

  it('paginates and reschedules instead of one unbounded pass', () => {
    const body = code(notif, 'notifyNewPost');
    expect(body).toContain('paginate(');
    expect(body).toContain('continueCursor');
    expect(body).not.toContain('.collect()');
  });

  it('honours the preference that until now nothing read', () => {
    // `streamUpdateEnabled` has been in the settings screen, toggleable, and
    // checked by no code at all. This gives it a job.
    expect(code(notif, 'notifyNewPost')).toContain("'streamUpdateEnabled'");
  });

  it('never notifies the author about their own post', () => {
    expect(code(notif, 'notifyNewPost')).toContain('userId === post.userId');
  });

  it('scopes a stream post to that stream, not the platform', () => {
    // Nobody should be mailed about a post they cannot open.
    const body = code(notif, 'notifyNewPost');
    expect(body).toContain("query('streamMemberships')");
    expect(body).toContain('by_stream');
  });

  it('gives each post a subject that names it', () => {
    /**
     * REPORTED AS A DUPLICATE, AND WAS NOT ONE.
     *
     * Every agent post was mailed as "ORBIT Agent posted", so Monday's deadline
     * announcement and Tuesday's logbook announcement arrived under one
     * identical subject. Two different messages read, in an inbox, as the same
     * message twice — and the only way to tell them apart was to open both.
     */
    const body = code(notif, 'notifyNewPost');
    expect(body).toContain('const headline = post.content.split');
    expect(body).toContain('subjectOverride: subject');
  });

  it('tells each person once, even if the fan-out runs again', () => {
    /**
     * The fan-out paginates and reschedules itself, so a retried page, an
     * overlapping run or a hand-invoked repeat would mail the same people about
     * the same post again — and each of those is a real message to a real
     * person. Checked per recipient, because the case being guarded is a run
     * that does not know it is the second one.
     */
    const body = code(notif, 'notifyNewPost');
    expect(body).toContain('by_user_and_post');
    expect(body).toContain('if (already) continue');
    // The check must precede the write, or it guards nothing.
    expect(body.indexOf('by_user_and_post')).toBeLessThan(body.indexOf('createNotification'));
  });

  it('records which post a notification was about', () => {
    // Without this the "have I already told them" question is unanswerable.
    expect(code(notif, 'notifyNewPost')).toContain('relatedPostId: postId');
  });
});
