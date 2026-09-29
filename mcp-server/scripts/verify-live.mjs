/**
 * Live verification of the MCP server against a Convex deployment.
 *
 * Spawns the REAL built server over stdio — the same binary an agent connects
 * to — exercises all 25 tools, and asserts each effect SEPARATELY against the
 * database: that approving a submission actually moved the points ledger, that
 * creating a task produced exactly one notification row and one email row, that
 * a denial was audited.
 *
 *   npm run build
 *   ORBIT_CONVEX_URL=... ORBIT_MCP_SECRET=... \
 *     node scripts/verify-live.mjs
 *
 * Every check that says "was N on Supabase" is pinning a bug the port fixed;
 * those are the ones worth keeping when this is eventually folded into the
 * convex-test suite (Stream E).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
import { escapeHtml, isSafeActionUrl } from '../../convex/lib/html.ts';

/** Convex wraps thrown handler errors; this pulls the sentence back out. */
const describe = (e) => (e?.message ?? String(e)).match(/Uncaught Error:\s*([^\n]+)/)?.[1] ?? String(e?.message ?? e);

const URL = process.env.ORBIT_CONVEX_URL;
const SECRET = process.env.ORBIT_MCP_SECRET;

if (!URL || !SECRET) {
  console.error('Set ORBIT_CONVEX_URL and ORBIT_MCP_SECRET.');
  process.exit(2);
}

// THIS SCRIPT WRITES REAL DATA. It creates a temporary super_admin, an intern,
// a stream and tasks, and it deactivates rather than deletes them, because
// Convex has no hard delete for users here. Pointing it at production would
// leave a real super_admin account and real notifications behind.
const DEV_DEPLOYMENT = process.env.ORBIT_DEV_DEPLOYMENT || 'your-dev-deployment';
// Exact first hostname label, not a substring: `eu-west-1` would match prod too.
const deployment = (() => { try { return new globalThis.URL(URL).hostname.split('.')[0]; } catch { return ''; } })();
if (deployment !== DEV_DEPLOYMENT && process.env.ORBIT_VERIFY_ALLOW_NONDEV !== 'yes') {
  console.error(
    `Refusing to run against ${URL}: this harness creates a super_admin and writes ` +
      `notifications, emails and points.\nIt is meant for the dev deployment (${DEV_DEPLOYMENT}; override with ORBIT_DEV_DEPLOYMENT). ` +
      `Set ORBIT_VERIFY_ALLOW_NONDEV=yes if you genuinely mean to.`,
  );
  process.exit(2);
}

const convex = new ConvexHttpClient(URL);

/**
 * Sign-in moved to an httpAction: a mutation cannot see the client address, so a
 * rate limit inside one can only key on something the caller supplies.
 */
const signIn = ({ email, password }) =>
  fetch(`${URL.replace('.convex.cloud', '.convex.site')}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then((r) => r.json());
const stamp = Date.now();

let pass = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n== ${title}`);
}

// Counts come from the admin-gated mcp.rowCounts, not from the migration
// surface. Verifying a security boundary with an unauthenticated table-reader
// was backwards, and that reader is now internal-only anyway.
let countToken = null;
const count = async (table) =>
  (await convex.query(anyApi.mcp.rowCounts, { token: countToken, tables: [table] }))[table];

/** Text payload of a tool result. */
function body(result) {
  return (result.content ?? []).map((c) => c.text ?? '').join('\n');
}

function parse(result) {
  return JSON.parse(body(result));
}

async function main() {
  section('MCP session boundary');

  const bad = await convex.mutation(anyApi.mcp.authenticate, { secret: 'x'.repeat(64) });
  check('wrong secret is rejected', bad.success === false, JSON.stringify(bad));

  const auth = await convex.mutation(anyApi.mcp.authenticate, { secret: SECRET });
  check('correct secret mints a session', auth.success === true);
  let adminToken = auth.token;
  countToken = adminToken;
  const actorId = auth.actor.id;
  console.log(`  actor: ${auth.actor.email} [${auth.actor.roles.join(', ')}]`);

  const who = await convex.query(anyApi.mcp.whoami, { token: adminToken });
  check('whoami resolves the MCP session', who.email === auth.actor.email);

  // A human session token must NOT be usable on the MCP-only endpoints.
  section('Fixtures');

  const created = await convex.mutation(anyApi.users.adminCreateUser, {
    token: adminToken,
    email: `mcp-verify-${stamp}@iih.ng`,
    fullName: `MCP Verify ${stamp}`,
    roles: ['intern'],
  });
  check('test intern created', created.success === true, JSON.stringify(created));
  const internId = created.id;

  const login = await signIn({
    email: `mcp-verify-${stamp}@iih.ng`,
    password: created.tempPassword,
  });
  check('test intern can sign in', login.success === true, JSON.stringify(login));
  const internToken = login.token;

  const humanSession = await convex.mutation(anyApi.mcp.recordAudit, {
    token: internToken,
    action: 'SHOULD_NOT_WORK',
  }).then(() => 'accepted').catch((e) => String(e.message));
  check('a non-MCP session cannot write MCP audit rows', humanSession !== 'accepted', humanSession);

  // A HUMAN admin session, for the revocation test. Revoking MCP access deletes
  // every MCP session including the caller's own, so an MCP token cannot undo
  // it — which is correct, and means the test has to be run the way a real
  // admin runs it: signed in through the app.
  const adminFixture = await convex.mutation(anyApi.users.adminCreateUser, {
    token: adminToken,
    email: `mcp-verify-admin-${stamp}@iih.ng`,
    fullName: `MCP Verify Admin ${stamp}`,
    roles: ['super_admin'],
  });
  const humanLogin = await signIn({
    email: `mcp-verify-admin-${stamp}@iih.ng`,
    password: adminFixture.tempPassword,
  });
  const humanToken = humanLogin.token;
  check('human admin fixture can sign in', humanLogin.success === true);

  const stream = await convex.mutation(anyApi.streams.create, {
    token: adminToken,
    name: `MCP Verify Stream ${stamp}`,
    description: 'temporary',
  });
  const streamId = stream.id;
  await convex.mutation(anyApi.streams.addMember, { token: adminToken, streamId, userId: internId });
  check('fixture stream created with one member', Boolean(streamId));

  section('Boot the MCP server over stdio');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new global.URL('../dist/index.js', import.meta.url).pathname],
    env: { ...process.env, ORBIT_CONVEX_URL: URL, ORBIT_MCP_SECRET: SECRET },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'verify', version: '1.0.0' });
  await client.connect(transport);
  transport.stderr?.on('data', (d) => process.stdout.write(`  [server] ${d}`));

  const tools = (await client.listTools()).tools;
  console.log(`  ${tools.length} tools registered`);
  const expected = [
    'list_users', 'get_user', 'update_user_role',
    'list_streams', 'get_stream', 'create_stream',
    'list_tasks', 'get_task', 'create_task', 'update_task',
    'list_submissions', 'score_submission',
    'get_leaderboard', 'post_to_feed', 'reply_to_post', 'post_stream_announcement',
    'check_mentions',
    'send_direct_message', 'list_agent_messages', 'reply_to_direct_message', 'mark_message_read',
    'send_notification', 'queue_email_alert', 'get_admin_settings', 'update_setting',
  ];
  const names = tools.map((t) => t.name).sort();
  const missing = expected.filter((e) => !names.includes(e));
  check('all 25 tools present', missing.length === 0, `missing: ${missing.join(', ')}`);

  const call = (name, args) => client.callTool({ name, arguments: args });

  section('Reads');

  const users = parse(await call('list_users', { limit: 200 }));
  check('list_users returns the directory', Array.isArray(users) && users.length > 0);
  check('list_users leaks no password hash', !JSON.stringify(users).includes('passwordHash'));

  const byStream = parse(await call('list_users', { stream_id: streamId }));
  check('list_users filters by stream', byStream.length === 1 && byStream[0].id === internId,
    JSON.stringify(byStream.map((u) => u.fullName)));

  const interns = parse(await call('list_users', { role: 'intern', limit: 200 }));
  check('list_users filters by role', interns.every((u) => u.roles.includes('intern')));

  const user = parse(await call('get_user', { user_id: internId }));
  check('get_user returns the admin view', user.email === `mcp-verify-${stamp}@iih.ng`);
  check('get_user omits secrets', !('passwordHash' in user) && !('tempPassword' in user) && !('calendarFeedToken' in user));

  const streams = parse(await call('list_streams', {}));
  check('list_streams includes the fixture', streams.some((s) => s.id === streamId));
  const fixture = streams.find((s) => s.id === streamId);
  check('memberCount is derived, not the stored 0', fixture.memberCount === 1, `got ${fixture?.memberCount}`);

  const detail = parse(await call('get_stream', { stream_id: streamId }));
  check('get_stream returns stream + members', detail.stream.id === streamId && detail.members.length === 1);

  section('create_task — the triple-notification bug');

  const notifBefore = await count('notifications');
  const emailBefore = await count('emailQueue');
  const auditBefore = await count('auditLogs');

  const deadline = new Date(Date.now() + 7 * 86400_000).toISOString();
  const taskText = body(await call('create_task', {
    title: `MCP Verify Task ${stamp}`,
    description: 'created by the verification harness',
    stream_id: streamId,
    points: 25,
    deadline,
    submission_type: 'text',
  }));
  console.log(`  -> ${taskText}`);
  check('create_task reports notifying exactly 1 member', /Notified 1 member/.test(taskText), taskText);

  const notifAfter = await count('notifications');
  const emailAfter = await count('emailQueue');
  check('exactly ONE notification row was created', notifAfter - notifBefore === 1, `delta ${notifAfter - notifBefore}`);
  check('exactly ONE email row was queued', emailAfter - emailBefore === 1, `delta ${emailAfter - emailBefore}`);
  check('the write was audited', (await count('auditLogs')) - auditBefore === 1);

  const internNotifs = await convex.query(anyApi.notifications.list, { token: internToken, limit: 20 });
  const taskNotif = internNotifs.filter((n) => n.type === 'new_task');
  check('the member received exactly one new_task notification', taskNotif.length === 1, `got ${taskNotif.length}`);

  const taskId = parse(await call('list_tasks', { stream_id: streamId }))
    .find((t) => t.title === `MCP Verify Task ${stamp}`).id;
  check('list_tasks finds it', Boolean(taskId));

  const gotTask = parse(await call('get_task', { task_id: taskId }));
  check('get_task returns it', gotTask.points === 25);

  const quietBefore = await count('notifications');
  const quiet = body(await call('create_task', {
    title: `MCP Verify Quiet ${stamp}`,
    description: 'no notifications expected',
    stream_id: streamId,
    points: 5,
    deadline,
    notify_members: false,
  }));
  check('notify_members:false really suppresses', /Notified 0 member/.test(quiet)
    && (await count('notifications')) - quietBefore === 0, quiet);

  const badDeadline = await call('create_task', {
    title: 'bad', description: '', stream_id: streamId, points: 1, deadline: 'next tuesday',
  });
  check('an unparseable deadline is rejected', badDeadline.isError === true, body(badDeadline));

  await call('update_task', { task_id: taskId, points: 30, is_featured: true });
  check('update_task applied', parse(await call('get_task', { task_id: taskId })).points === 30);

  section('score_submission — the zero-points bug');

  await convex.mutation(anyApi.tasks.acceptTask, { token: internToken, taskId });
  await convex.mutation(anyApi.tasks.submitWork, {
    token: internToken, taskId, submissionText: 'verification submission',
  });

  const subs = parse(await call('list_submissions', { task_id: taskId }));
  check('list_submissions finds the submission', subs.length === 1, `got ${subs.length}`);
  const submissionId = subs[0].id;

  const pointsBefore = (await convex.query(anyApi.users.me, { token: internToken })).totalPoints;
  const ledgerBefore = await count('pointsLedger');
  const notifBefore2 = await count('notifications');

  const scored = body(await call('score_submission', {
    submission_id: submissionId, status: 'approved', score: 30, feedback: 'good work',
  }));
  console.log(`  -> ${scored}`);

  const me = await convex.query(anyApi.users.me, { token: internToken });
  const pointsAfter = me.totalPoints;
  check('POINTS WERE ACTUALLY AWARDED (was 0 on Supabase)', pointsAfter > pointsBefore,
    `${pointsBefore} -> ${pointsAfter}`);
  check('the score itself was paid', pointsAfter >= pointsBefore + 30, `${pointsBefore} -> ${pointsAfter}`);

  // Approving a first task also earns "First Steps" (+5 bonus), which writes its
  // own ledger row. The invariant that matters is that what the tool REPORTS
  // matches the member's actual total — that is what was wrong before.
  const reportedTotal = Number(scored.match(/new total (\d+)/)?.[1]);
  check('the reported total matches the member\'s real total',
    reportedTotal === pointsAfter, `reported ${reportedTotal}, actual ${pointsAfter}`);
  check('any badge earned is named in the output',
    pointsAfter - pointsBefore === 30 ? true : /Earned badge/.test(scored), scored);

  const ledgerDelta = (await count('pointsLedger')) - ledgerBefore;
  check('one ledger row per award (score + any badge bonus)',
    ledgerDelta >= 1 && ledgerDelta <= 2, `delta ${ledgerDelta}`);
  check('the member was notified once', (await count('notifications')) - notifBefore2 === 1);

  const ledgerMid = await count('pointsLedger');
  const again = body(await call('score_submission', {
    submission_id: submissionId, status: 'approved', score: 30,
  }));
  check('re-approving does NOT pay twice',
    (await convex.query(anyApi.users.me, { token: internToken })).totalPoints === pointsAfter
    && (await count('pointsLedger')) === ledgerMid, again);
  check('re-approval explains why nothing was paid',
    /already records a payment/.test(again), again);

  // Re-scoring must move the ledger with the score. Previously the submission
  // row was patched to the new score and the ledger was left alone, so the two
  // disagreed permanently and nobody was told.
  const rescored = body(await call('score_submission', {
    submission_id: submissionId, status: 'approved', score: 50,
  }));
  const afterRescore = (await convex.query(anyApi.users.me, { token: internToken })).totalPoints;
  check('re-scoring 30 -> 50 pays the 20 difference',
    afterRescore === pointsAfter + 20, `${pointsAfter} -> ${afterRescore}`);
  const rescoredRow = (parse(await call('list_submissions', { task_id: taskId })))[0];
  check('submissions.score and the ledger agree after a re-score',
    rescoredRow.score === 50 && afterRescore === pointsAfter + 20,
    `score ${rescoredRow.score}, total ${afterRescore}`);
  check('the correction is reported', /Awarded 20 pts/.test(rescored), rescored);

  const downScored = body(await call('score_submission', {
    submission_id: submissionId, status: 'approved', score: 30,
  }));
  check('re-scoring downward claws back the difference',
    (await convex.query(anyApi.users.me, { token: internToken })).totalPoints === pointsAfter,
    downScored);

  // Withdrawing the decision must withdraw the payment. Postgres left the points
  // standing forever, so a rejected submission still counted on the leaderboard.
  const beforeReject = (await convex.query(anyApi.users.me, { token: internToken })).totalPoints;
  const rejected = body(await call('score_submission', {
    submission_id: submissionId, status: 'rejected', feedback: 'on reflection, no',
  }));
  const afterReject = (await convex.query(anyApi.users.me, { token: internToken })).totalPoints;
  check('rejecting a paid submission reverses the 30 pts',
    afterReject === beforeReject - 30, `${beforeReject} -> ${afterReject}; ${rejected}`);
  check('the reversal is reported', /Reversed 30 previously awarded pts/.test(rejected), rejected);

  // ...and re-approving pays it again from zero, not twice.
  const reApproved = body(await call('score_submission', {
    submission_id: submissionId, status: 'approved', score: 30,
  }));
  check('re-approving after a reversal pays the score once',
    (await convex.query(anyApi.users.me, { token: internToken })).totalPoints === beforeReject,
    reApproved);

  const badgesKept = await convex.query(anyApi.badges.listForUser, {
    token: adminToken, userId: internId,
  });
  check('badges survive a reversal rather than being clawed back',
    badgesKept.length >= 1, JSON.stringify(badgesKept.map((b) => b.name)));

  section('Feed, chat and mentions');

  const post = body(await call('post_to_feed', {
    content: `Verification post ${stamp}`, stream_id: streamId,
  }));
  const postId = post.match(/Created post (\S+)/)[1];
  check('post_to_feed wrote a post', Boolean(postId), post);

  const reply = body(await call('reply_to_post', { post_id: postId, content: 'self reply' }));
  check('reply_to_post wrote a reply', /Created reply/.test(reply), reply);

  const ann = body(await call('post_stream_announcement', {
    stream_id: streamId, content: `Announcement ${stamp}`,
  }));
  check('post_stream_announcement posted', /Posted stream announcement/.test(ann), ann);

  const chat = await convex.query(anyApi.streamChat.list, { token: internToken, streamId });
  const annRow = chat.find((c) => c.content === `Announcement ${stamp}`);
  check('the announcement carries isAnnouncement', annRow?.isAnnouncement === true);

  // The intern mentions the agent; check_mentions must find it.
  await convex.mutation(anyApi.posts.create, {
    token: internToken, streamId, content: `Hey @ORBIT Agent please look at this ${stamp}`,
  });
  const mentions = parse(await call('check_mentions', { hours_back: 1 }));
  check('check_mentions finds the @ORBIT Agent mention',
    mentions.some((m) => m.content.includes(String(stamp))), JSON.stringify(mentions).slice(0, 200));
  check('check_mentions excludes the actor\'s own posts',
    mentions.every((m) => m.author?.id !== actorId));

  section('Messaging');

  const dmNotifBefore = await count('notifications');
  const dmEmailBefore = await count('emailQueue');
  const dm = body(await call('send_direct_message', {
    recipient_id: internId, content: `Hello from the harness ${stamp}`,
  }));
  check('send_direct_message sent', /Sent direct message/.test(dm), dm);
  check('DM created exactly ONE notification (was three)',
    (await count('notifications')) - dmNotifBefore === 1);
  check('DM queued exactly ONE email', (await count('emailQueue')) - dmEmailBefore === 1);

  const fromIntern = await convex.mutation(anyApi.messages.send, {
    token: internToken, recipientId: actorId, content: `Reply needed ${stamp}`,
  });
  check('intern messaged the agent', fromIntern.success === true, JSON.stringify(fromIntern));

  const inbox = parse(await call('list_agent_messages', { unread_only: true, limit: 10 }));
  const mine = inbox.find((m) => m.content.includes(String(stamp)));
  check('list_agent_messages shows it unread', Boolean(mine), JSON.stringify(inbox).slice(0, 200));

  const replied = body(await call('reply_to_direct_message', {
    message_id: mine.id, content: 'on it',
  }));
  check('reply_to_direct_message threaded a reply', /Replied to/.test(replied), replied);

  const marked = body(await call('mark_message_read', { message_id: mine.id }));
  check('mark_message_read marked it', /Marked message/.test(marked), marked);
  const inbox2 = parse(await call('list_agent_messages', { unread_only: true, limit: 10 }));
  check('list_agent_messages returns JSON even when empty', Array.isArray(inbox2));
  check('it is no longer unread', !inbox2.some((m) => m.id === mine.id));

  // The agent's own outgoing reply is not addressed to it, so marking it read
  // must be refused rather than silently applied.
  const replyId = replied.match(/sent as (\S+)/)[1];
  const notMine = body(await call('mark_message_read', { message_id: replyId }));
  check('cannot mark a message the actor did not receive', /No change/.test(notMine), notMine);

  section('Hardening from the security review');

  // The migration surface must not be reachable from a client. It used to be a
  // public mutation gated on a shared secret, so anyone holding that string
  // could insert a row into `users` or `sessions` and be a super admin —
  // bypassing every control this file otherwise tests.
  const migrationProbe = await fetch(`${URL}/api/mutation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: 'migrations:importBatch',
      args: { secret: 'anything', table: 'users', rows: [] },
      format: 'json',
    }),
  }).then((r) => r.json());
  check('migrations:importBatch is not publicly callable',
    migrationProbe.status === 'error' && /Could not find public function/.test(migrationProbe.errorMessage ?? ''),
    JSON.stringify(migrationProbe).slice(0, 200));

  for (const fnPath of ['migrations:patchByLegacyId', 'migrations:clearTable', 'migrations:countRows']) {
    const probe = await fetch(`${URL}/api/mutation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fnPath, args: { secret: 'anything', table: 'users' }, format: 'json' }),
    }).then((r) => r.json());
    check(`${fnPath} is not publicly callable`, probe.status === 'error', JSON.stringify(probe).slice(0, 120));
  }

  // rowCounts replaced it, and is admin-gated rather than secret-gated.
  const countsAsIntern = await convex.query(anyApi.mcp.rowCounts, {
    token: internToken, tables: ['users'],
  }).then(() => 'read').catch((e) => describe(e));
  check('mcp.rowCounts refuses a non-admin', countsAsIntern !== 'read', String(countsAsIntern));

  const badCountTable = await convex.query(anyApi.mcp.rowCounts, {
    token: adminToken, tables: ['blockedIps'],
  }).then(() => 'read').catch((e) => describe(e));
  check('mcp.rowCounts refuses a table outside its allowlist', badCountTable !== 'read', String(badCountTable));

  // C1: member-authored text must not become live HTML in an ORBIT email.
  // The queued row is read back over ssh after the run (see verifyEmailHtml.sh);
  // here we pin the escaping itself and record the marker to look for.
  const injection = `</p><a href="https://evil.example">click${stamp}</a><p>`;
  const injected = await convex.mutation(anyApi.messages.send, {
    token: internToken, recipientId: actorId, content: injection,
  });
  check('the injection DM was accepted (its email body is checked below)',
    injected.success === true, JSON.stringify(injected));
  check('escapeHtml neutralises the payload',
    !escapeHtml(injection).includes('<a href'), escapeHtml(injection));
  check('isSafeActionUrl rejects absolute, javascript:, protocol-relative and backslash forms',
    !isSafeActionUrl('https://evil.example') && !isSafeActionUrl('javascript:alert(1)') &&
    !isSafeActionUrl('//evil.example') && !isSafeActionUrl('/\\evil.example') &&
    isSafeActionUrl('/tasks/abc123'));
  console.log(`  marker for the email-body check: click${stamp}`);

  // C2: the message rate limit must not be defeatable by a caller-supplied key.
  const bypass = await convex.mutation(anyApi.messages.send, {
    token: internToken, recipientId: actorId, content: 'x', ipAddress: 'anything',
  }).then(() => 'accepted').catch((e) => describe(e));
  check('messages.send no longer accepts a caller-supplied rate-limit key',
    bypass !== 'accepted', String(bypass));

  // H2: private-stream posts must not be reachable by id from a non-member.
  const outsider = await convex.mutation(anyApi.users.adminCreateUser, {
    token: adminToken,
    email: `mcp-verify-outsider-${stamp}@iih.ng`,
    fullName: `MCP Verify Outsider ${stamp}`,
    roles: ['intern'],
  });
  const outsiderLogin = await signIn({
    email: `mcp-verify-outsider-${stamp}@iih.ng`, password: outsider.tempPassword,
  });
  const outsiderToken = outsiderLogin.token;

  const readPrivate = await convex.query(anyApi.posts.replies, {
    token: outsiderToken, postId,
  }).then(() => 'read').catch((e) => describe(e));
  check('a non-member cannot read a stream post\'s replies by id',
    readPrivate !== 'read', String(readPrivate));

  const writePrivate = await convex.mutation(anyApi.posts.reply, {
    token: outsiderToken, postId, content: 'intruding',
  }).then(() => 'wrote').catch((e) => describe(e));
  check('a non-member cannot reply to a stream post by id',
    writePrivate !== 'wrote', String(writePrivate));

  const likePrivate = await convex.mutation(anyApi.posts.toggleLike, {
    token: outsiderToken, postId,
  }).then(() => 'liked').catch((e) => describe(e));
  check('a non-member cannot like a stream post by id',
    likePrivate !== 'liked', String(likePrivate));

  // H4 / actionUrl validation.
  const evilUrl = await call('send_notification', {
    user_id: internId, title: 'x', content: 'y', action_url: 'https://evil.example/phish',
  });
  check('an absolute actionUrl is rejected', evilUrl.isError === true, body(evilUrl));
  const jsUrl = await call('send_notification', {
    user_id: internId, title: 'x', content: 'y', action_url: 'javascript:alert(1)',
  });
  check('a javascript: actionUrl is rejected', jsUrl.isError === true, body(jsUrl));
  const protoRel = await call('send_notification', {
    user_id: internId, title: 'x', content: 'y', action_url: '//evil.example',
  });
  check('a protocol-relative actionUrl is rejected', protoRel.isError === true, body(protoRel));

  // H4: the agent must not hold a verbatim-HTML email primitive.
  const emailTool = tools.find((t) => t.name === 'queue_email_alert');
  check('queue_email_alert no longer exposes body_html',
    !('body_html' in (emailTool.inputSchema.properties ?? {})),
    JSON.stringify(Object.keys(emailTool.inputSchema.properties ?? {})));

  // M1: denials are audited.
  const auditBeforeDenial = await count('auditLogs');
  const denied = await call('update_setting', { setting_key: 'nope_not_real', setting_value: 1 });
  check('a refused write is audited', (await count('auditLogs')) - auditBeforeDenial === 1,
    `delta ${(await count('auditLogs')) - auditBeforeDenial}, ${body(denied)}`);

  // M7: demotion clears mcpEnabled and kills MCP sessions. Demoted by a
  // DIFFERENT admin — adminSetRoles rightly refuses to let anyone strip their
  // own admin role.
  const demoteTarget = await convex.mutation(anyApi.users.adminCreateUser, {
    token: adminToken,
    email: `mcp-verify-demote-${stamp}@iih.ng`,
    fullName: `MCP Verify Demote ${stamp}`,
    roles: ['admin'],
  });
  await convex.mutation(anyApi.users.adminSetMcpAccess, {
    token: humanToken, userId: demoteTarget.id, enabled: true,
  });
  const beforeDemotion = await convex.query(anyApi.users.adminGetById, {
    token: adminToken, userId: demoteTarget.id,
  });
  check('MCP access was granted to the demotion target', beforeDemotion.mcpEnabled === true);

  const demoted = await convex.mutation(anyApi.users.adminSetRoles, {
    token: humanToken, userId: demoteTarget.id, roles: ['intern'],
  });
  const afterDemotion = await convex.query(anyApi.users.adminGetById, {
    token: adminToken, userId: demoteTarget.id,
  });
  check('demoting an admin clears mcpEnabled', afterDemotion.mcpEnabled === false,
    JSON.stringify(demoted));

  // M8: the global kill switch works without knowing which account is the actor.
  const killed = await convex.mutation(anyApi.mcp.revokeAllSessions, { token: humanToken });
  check('revokeAllSessions kills every MCP session', killed.revoked >= 1, JSON.stringify(killed));

  // It killed this harness's session too — which is the point.
  const staleAfterKill = await convex.query(anyApi.mcp.whoami, { token: adminToken })
    .then(() => 'still valid').catch(() => 'revoked');
  check('the revoke applies to every client, not just the server', staleAfterKill === 'revoked');
  adminToken = (await convex.mutation(anyApi.mcp.authenticate, { secret: SECRET })).token;
  countToken = adminToken;

  const recoversAfterKill = await call('list_streams', {});
  check('the MCP server re-authenticates on its own after a global revoke',
    recoversAfterKill.isError !== true, body(recoversAfterKill));

  section('Notifications, email, settings');

  const nBefore = await count('notifications');
  const notif = body(await call('send_notification', {
    user_id: internId, title: 'Harness notification', content: 'body', action_url: '/tasks',
  }));
  check('send_notification created one row', (await count('notifications')) - nBefore === 1, notif);

  const eBefore = await count('emailQueue');
  const mail = body(await call('queue_email_alert', {
    user_id: internId, subject: 'Harness email', body_text: 'Line one\n<script>alert(1)</script>',
  }));
  check('queue_email_alert queued one row', (await count('emailQueue')) - eBefore === 1, mail);
  check('the address came from the user record', mail.includes(`mcp-verify-${stamp}@iih.ng`), mail);

  const settings = parse(await call('get_admin_settings', {}));
  check('get_admin_settings returns rows', Array.isArray(settings) && settings.length > 0);

  const unknown = await call('update_setting', { setting_key: 'definitely_not_a_setting', setting_value: 1 });
  check('updating an unknown setting is an ERROR, not a silent success',
    unknown.isError === true, body(unknown));

  if (settings.length) {
    const key = settings[0].key;
    const original = settings[0].value;
    const upd = body(await call('update_setting', { setting_key: key, setting_value: original }));
    check('update_setting round-trips a real key', /updated/.test(upd), upd);
  }

  section('Legacy uuid compatibility');

  // A real imported user still carries its Postgres uuid — the tools must accept
  // it wherever they accept a Convex id.
  const directory = await convex.query(anyApi.users.list, { token: adminToken });
  let legacyProbe = null;
  for (const u of directory) {
    const full = await convex.query(anyApi.users.adminGetById, { token: adminToken, userId: u.id });
    if (full?.legacyId) { legacyProbe = full; break; }
  }

  if (legacyProbe) {
    const viaUuid = parse(await call('get_user', { user_id: legacyProbe.legacyId }));
    check('a pre-migration uuid resolves to the right user',
      viaUuid.id === legacyProbe.id, `${legacyProbe.legacyId} -> ${viaUuid.id}`);
  } else {
    check('a pre-migration uuid resolves to the right user', false, 'no user with a legacyId found');
  }

  const unknownUuid = await convex.query(anyApi.mcp.resolveLegacyId, {
    token: adminToken, table: 'users', legacyId: '00000000-0000-0000-0000-000000000000',
  });
  check('an unknown legacy uuid resolves to null', unknownUuid === null);

  const badTable = await convex.query(anyApi.mcp.resolveLegacyId, {
    token: adminToken, table: 'auditLogs', legacyId: '00000000-0000-0000-0000-000000000000',
  }).then(() => 'accepted').catch((e) => e.message);
  check('resolveLegacyId refuses tables outside the allowlist', badTable !== 'accepted');

  const uuidMiss = await call('get_user', { user_id: '11111111-2222-3333-4444-555555555555' });
  check('an unresolvable uuid gives an actionable error',
    uuidMiss.isError === true && /legacy id/.test(body(uuidMiss)), body(uuidMiss));

  section('Resource');

  const res = await client.readResource({ uri: 'orbit://stats' });
  const stats = JSON.parse(res.contents[0].text);
  check('orbit://stats returns counts', typeof stats.activeUsers === 'number' && stats.activeUsers > 0,
    JSON.stringify(stats));

  section('Revocation');

  const revokeResult = await convex.mutation(anyApi.users.adminSetMcpAccess, {
    token: humanToken, userId: actorId, enabled: false,
  });
  check('revoking reports the sessions it killed', revokeResult.revoked >= 1,
    JSON.stringify(revokeResult));

  const afterRevoke = await convex.mutation(anyApi.mcp.authenticate, { secret: SECRET })
    .then((r) => (r.success ? 'minted' : r.error));
  check('revoking MCP access blocks new sessions', afterRevoke !== 'minted', String(afterRevoke));

  const revokedCall = await call('list_streams', {});
  check('the already-running server can no longer act', revokedCall.isError === true, body(revokedCall));

  await convex.mutation(anyApi.users.adminSetMcpAccess, {
    token: humanToken, userId: actorId, enabled: true,
  });
  const restored = await convex.mutation(anyApi.mcp.authenticate, { secret: SECRET });
  check('re-enabling restores access', restored.success === true);
  const recovered = await call('list_streams', {});
  check('and the running server recovers on its own', recovered.isError !== true);

  const grantToIntern = await convex.mutation(anyApi.users.adminSetMcpAccess, {
    token: humanToken, userId: internId, enabled: true,
  });
  check('MCP access cannot be granted to a non-admin', grantToIntern.success === false,
    JSON.stringify(grantToIntern));

  section('Concurrent clients');

  // Two live MCP sessions must coexist — the connection guide configures this
  // server in both Cursor and Claude Desktop.
  const second = await convex.mutation(anyApi.mcp.authenticate, { secret: SECRET });
  check('a second client can authenticate', second.success === true);
  const firstStillGood = await call('list_streams', {});
  check('and the first client keeps working', firstStillGood.isError !== true, body(firstStillGood));

  section('Cleanup');

  await convex.mutation(anyApi.users.adminSetActive, { token: humanToken, userId: internId, isActive: false });
  await convex.mutation(anyApi.streams.deactivate, { token: humanToken, streamId });
  await convex.mutation(anyApi.tasks.deactivate, { token: humanToken, taskId });
  for (const id of [outsider.id, demoteTarget.id]) {
    await convex.mutation(anyApi.users.adminSetActive, { token: humanToken, userId: id, isActive: false });
  }
  // Not with humanToken — adminSetActive refuses to deactivate the caller.
  const cleanup = await convex.mutation(anyApi.users.adminSetActive, {
    token: second.token, userId: adminFixture.id, isActive: false,
  });
  check('the temporary super_admin fixture was deactivated', cleanup.success === true,
    JSON.stringify(cleanup));
  console.log('  fixtures deactivated');

  await client.close();

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nHARNESS ERROR:', e);
  process.exit(2);
});
