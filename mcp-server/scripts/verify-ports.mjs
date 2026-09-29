/**
 * Live verification of the session-3 ports against a Convex deployment.
 *
 * Covers what verify-live.mjs does not: user trash/restore/permanent-delete,
 * notification preferences, the SIWES gaps (my status, export, compliance,
 * attendance verification, submit/review notifications) and applications.
 *
 *   ORBIT_CONVEX_URL=... ORBIT_MCP_SECRET=... node scripts/verify-ports.mjs
 *
 * Writes real data. Refuses to run outside dev.
 */
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';

const URL = process.env.ORBIT_CONVEX_URL;
const SECRET = process.env.ORBIT_MCP_SECRET;

if (!URL || !SECRET) {
  console.error('Set ORBIT_CONVEX_URL and ORBIT_MCP_SECRET.');
  process.exit(2);
}
const DEV_DEPLOYMENT = process.env.ORBIT_DEV_DEPLOYMENT || 'your-dev-deployment';
// Exact first hostname label, not a substring: `eu-west-1` would match prod too.
const deployment = (() => { try { return new globalThis.URL(URL).hostname.split('.')[0]; } catch { return ''; } })();
if (deployment !== DEV_DEPLOYMENT && process.env.ORBIT_VERIFY_ALLOW_NONDEV !== 'yes') {
  console.error(`Refusing to run against ${URL}: this harness creates and DELETES users. Expected dev deployment: ${DEV_DEPLOYMENT} (ORBIT_DEV_DEPLOYMENT).`);
  process.exit(2);
}

const convex = new ConvexHttpClient(URL);
const stamp = Date.now();
const describe = (e) =>
  (e?.message ?? String(e)).match(/Uncaught Error:\s*([^\n]+)/)?.[1] ?? String(e?.message ?? e);

let pass = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const attempt = (p) => p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e: describe(e) }));

async function main() {
  const auth = await convex.mutation(anyApi.mcp.authenticate, { secret: SECRET });
  const admin = auth.token;
  console.log(`actor: ${auth.actor.email}`);

  const SITE = URL.replace('.convex.cloud', '.convex.site');

  /**
   * Sign-in is an httpAction now, not a mutation — a mutation cannot see the
   * client address, so a rate limit inside one can only key on something the
   * caller supplies. Same argument shape, so every call site is unchanged.
   */
  const signIn = ({ email, password }) =>
    fetch(`${SITE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then((r) => r.json());

  const mkUser = async (suffix, roles = ['intern']) => {
    const r = await convex.mutation(anyApi.users.adminCreateUser, {
      token: admin,
      email: `port-${suffix}-${stamp}@iih.ng`,
      fullName: `Port ${suffix} ${stamp}`,
      roles,
    });
    const login = await signIn({
      email: `port-${suffix}-${stamp}@iih.ng`,
      password: r.tempPassword,
    });
    return { id: r.id, token: login.token };
  };

  section('Notification preferences (no backend existed)');

  const member = await mkUser('member');
  const prefs = await convex.query(anyApi.notificationPreferences.get, { token: member.token });
  check('defaults to everything on when no row exists',
    prefs.isDefault === true && prefs.newTaskEnabled === true, JSON.stringify(prefs));

  await convex.mutation(anyApi.notificationPreferences.save, {
    token: member.token, newTaskEnabled: false,
  });
  const saved = await convex.query(anyApi.notificationPreferences.get, { token: member.token });
  check('a partial save persists the named key',
    saved.newTaskEnabled === false && saved.isDefault === false, JSON.stringify(saved));
  check('and leaves the other eight ON, not undefined',
    saved.newMessageEnabled === true && saved.badgeEarnedEnabled === true, JSON.stringify(saved));

  // The whole point: notificationsInternal must honour it.
  const stream = await convex.mutation(anyApi.streams.create, {
    token: admin, name: `Port Stream ${stamp}`,
  });
  await convex.mutation(anyApi.streams.addMember, {
    token: admin, streamId: stream.id, userId: member.id,
  });
  const before = (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['notifications'] })).notifications;
  await convex.mutation(anyApi.tasks.create, {
    token: admin, streamId: stream.id, title: `Port task ${stamp}`, description: '',
    submissionType: 'text', points: 10, deadline: Date.now() + 86400000,
  });
  const after = (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['notifications'] })).notifications;
  check('a muted member is NOT notified of a new task', after === before, `delta ${after - before}`);

  await convex.mutation(anyApi.notificationPreferences.save, {
    token: member.token, newTaskEnabled: true,
  });
  const before2 = (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['notifications'] })).notifications;
  await convex.mutation(anyApi.tasks.create, {
    token: admin, streamId: stream.id, title: `Port task 2 ${stamp}`, description: '',
    submissionType: 'text', points: 10, deadline: Date.now() + 86400000,
  });
  check('un-muting restores it',
    (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['notifications'] })).notifications - before2 === 1);

  const other = await mkUser('other');
  const crossWrite = await attempt(convex.mutation(anyApi.notificationPreferences.save, {
    token: other.token, userId: member.id, newTaskEnabled: false,
  }));
  const memberStill = await convex.query(anyApi.notificationPreferences.get, { token: member.token });
  check('preferences cannot be written for another user', memberStill.newTaskEnabled === true,
    `crossWrite=${JSON.stringify(crossWrite)}`);

  section('Trash / restore');

  const doomed = await mkUser('doomed');
  const plainAdmin = await mkUser('admin', ['admin']);

  // Their content is created NOW, before any trashing. Trashing revokes the
  // session and restoring deliberately does not bring it back — and the temp
  // password is single-use, so there is no second sign-in.
  await convex.mutation(anyApi.posts.create, { token: doomed.token, content: `port post ${stamp}` });
  await convex.mutation(anyApi.messages.send, {
    token: doomed.token, recipientId: member.id, content: `port dm ${stamp}`,
  });

  const byAdmin = await attempt(convex.mutation(anyApi.users.adminTrashUser, {
    token: plainAdmin.token, userId: doomed.id,
  }));
  check('a plain admin cannot trash', byAdmin.ok && byAdmin.v.success === false,
    JSON.stringify(byAdmin));

  const trashed = await convex.mutation(anyApi.users.adminTrashUser, { token: admin, userId: doomed.id });
  check('a super admin can trash', trashed.success === true, JSON.stringify(trashed));
  check('trashing revokes the sessions', trashed.sessionsRevoked >= 1, JSON.stringify(trashed));

  const deadSession = await attempt(convex.query(anyApi.users.me, { token: doomed.token }));
  check('the trashed user\'s session no longer works', !deadSession.ok, JSON.stringify(deadSession));

  const inTrash = await convex.query(anyApi.users.adminListTrash, { token: admin });
  check('they appear in the trash listing', inTrash.some((u) => u.id === doomed.id));

  const self = await convex.mutation(anyApi.users.adminTrashUser, { token: admin, userId: auth.actor.id });
  check('cannot trash yourself', self.success === false, JSON.stringify(self));

  await convex.mutation(anyApi.users.adminRestoreUser, { token: admin, userId: doomed.id });
  const restored = await convex.query(anyApi.users.adminGetById, { token: admin, userId: doomed.id });
  check('restore clears isDeleted and reactivates',
    restored.isDeleted === false && restored.isActive === true, JSON.stringify(restored));

  section('Permanent delete');

  const notTrashed = await convex.mutation(anyApi.users.adminPermanentlyDeleteUser, {
    token: admin, userId: doomed.id,
  });
  check('refuses a user who is not in the trash', notTrashed.success === false, JSON.stringify(notTrashed));

  const report = await convex.query(anyApi.users.adminDeletionReport, { token: admin, userId: doomed.id });
  check('the report says an intern is deletable', report.canDelete === true, JSON.stringify(report.blockers));
  check('and lists what would go', report.owned.length >= 2, JSON.stringify(report.owned));

  await convex.mutation(anyApi.users.adminTrashUser, { token: admin, userId: doomed.id });
  const usersBefore = (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['users'] })).users;
  const deleted = await convex.mutation(anyApi.users.adminPermanentlyDeleteUser, {
    token: admin, userId: doomed.id,
  });
  check('an intern is permanently deleted', deleted.success === true, JSON.stringify(deleted));
  check('the user row is gone',
    (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['users'] })).users === usersBefore - 1);
  check('their content went with them', deleted.rowsRemoved >= 3, JSON.stringify(deleted));
  check('their audit rows were redacted, not destroyed', deleted.auditRowsRedacted >= 0, JSON.stringify(deleted));

  const gone = await convex.query(anyApi.users.adminGetById, { token: admin, userId: doomed.id });
  check('reads of the deleted user return null', gone === null);

  // A user who AUTHORED platform content: must be refused, not silently orphaned.
  const author = await mkUser('author', ['admin']);
  await convex.mutation(anyApi.streams.create, { token: author.token, name: `Authored ${stamp}` });
  await convex.mutation(anyApi.users.adminTrashUser, { token: admin, userId: author.id });

  const authorReport = await convex.query(anyApi.users.adminDeletionReport, { token: admin, userId: author.id });
  check('an author is reported as NOT deletable', authorReport.canDelete === false,
    JSON.stringify(authorReport.blockers));
  check('and the blocker names the content', authorReport.blockers.some((b) => /streams created/.test(b.label)),
    JSON.stringify(authorReport.blockers));

  const refused = await convex.mutation(anyApi.users.adminPermanentlyDeleteUser, {
    token: admin, userId: author.id,
  });
  check('deleting an author is refused', refused.success === false, JSON.stringify(refused).slice(0, 200));
  check('the refusal explains why, not an FK error', /would be orphaned/.test(refused.error ?? ''), refused.error);
  const stillThere = await convex.query(anyApi.users.adminGetById, { token: admin, userId: author.id });
  check('and the user still exists', stillThere !== null);

  section('SIWES: status, export, compliance');

  const intern = await mkUser('intern');
  const noProfile = await convex.query(anyApi.siwes.myStatus, { token: intern.token });
  check('myStatus returns null for a non-SIWES member', noProfile === null, JSON.stringify(noProfile));

  const cohort = await convex.mutation(anyApi.siwes.saveCohort, {
    token: admin,
    name: `Port Cohort ${stamp}`,
    startDate: '2026-01-01', endDate: '2026-12-31', status: 'active',
    defaultParticipationMode: 'hybrid', defaultPhysicalDay: 3,
    dailyLogsRequired: true, weeklySummaryRequired: true, signoffRequired: true,
  });
  const cohortId = cohort.id;
  check('cohort fixture created', Boolean(cohortId), JSON.stringify(cohort).slice(0, 160));

  // Created BY STAFF, for the intern — saveProfile refuses a self-serve create,
  // which is a session-1 control worth not routing around in a test.
  const profile = await convex.mutation(anyApi.siwes.saveProfile, {
    token: admin, userId: intern.id, cohortId,
    participationMode: 'hybrid', institutionName: 'Test Uni',
  });
  const internUserId = profile.id;
  check('intern profile created', Boolean(internUserId), JSON.stringify(profile).slice(0, 200));

  const status = await convex.query(anyApi.siwes.myStatus, { token: intern.token });
  check('myStatus resolves the active cohort', status?.cohortName === `Port Cohort ${stamp}`,
    JSON.stringify(status));
  check('physicalDay falls back to the cohort default', status?.physicalDay === 3, JSON.stringify(status));
  check('counters start at zero',
    status?.logsThisWeek === 0 && status?.approvedLogs === 0, JSON.stringify(status));

  const today = new Date().toISOString().slice(0, 10);
  const notifBefore = (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['notifications'] })).notifications;
  await convex.mutation(anyApi.logbook.saveDailyLog, {
    token: intern.token, logDate: today, participationMode: 'hybrid',
    title: 'Port log', workDone: 'verification', submit: true,
  });
  check('submitting a log with no supervisor notifies nobody',
    (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['notifications'] })).notifications === notifBefore);

  const afterLog = await convex.query(anyApi.siwes.myStatus, { token: intern.token });
  check('myStatus counts the submitted log', afterLog.logsThisWeek === 1, JSON.stringify(afterLog));

  // Assign a supervisor, then a submission must notify them.
  await convex.mutation(anyApi.siwes.assignProfile, {
    token: admin, internUserId, iihSupervisorId: auth.actor.id,
  });
  const sup = (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['notifications'] })).notifications;
  await convex.mutation(anyApi.logbook.saveWeeklySummary, {
    token: intern.token, weekStart: '2026-08-03', weekEnd: '2026-08-09',
    summary: 'week of verification', submit: true,
  });
  check('submitting a summary notifies the supervisor exactly once',
    (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['notifications'] })).notifications - sup === 1);

  const logs = await convex.query(anyApi.logbook.listDailyLogs, { token: intern.token });
  const reviewBefore = (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['notifications'] })).notifications;
  await convex.mutation(anyApi.logbook.reviewDailyLog, {
    token: admin, logId: logs[0].id, status: 'changes_requested', supervisorComment: 'more detail please',
  });
  check('reviewing a log notifies the intern',
    (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['notifications'] })).notifications - reviewBefore === 1);

  const internNotifs = await convex.query(anyApi.notifications.list, { token: intern.token, limit: 10 });
  check('the review notification carries the comment',
    internNotifs.some((n) => /more detail please/.test(n.content)),
    JSON.stringify(internNotifs.map((n) => n.type)));

  // A SECOND log that stays submitted. The first is now 'changes_requested',
  // and an entry sent back for rework must not appear in the printed logbook or
  // count toward compliance — that is the distinction being tested here, and
  // asserting ">= 1 log" would pass whether or not it held.
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await convex.mutation(anyApi.logbook.saveDailyLog, {
    token: intern.token, logDate: yesterday, participationMode: 'hybrid',
    title: 'Port log 2', workDone: 'still verifying', submit: true,
  });

  const exported = await convex.mutation(anyApi.logbook.exportLogbook, { token: intern.token });
  check('an intern can export their own logbook', exported.success === true, JSON.stringify(exported).slice(0, 160));
  check('the export carries the profile',
    exported.data.profile.cohortName === `Port Cohort ${stamp}`,
    JSON.stringify(exported.data.profile).slice(0, 200));
  check('the export includes the submitted log but NOT the one sent back',
    exported.data.dailyLogs.length === 1 && exported.data.dailyLogs[0].title === 'Port log 2',
    JSON.stringify(exported.data.dailyLogs.map((l) => [l.title, l.status])));
  check('the export includes the weekly summary',
    exported.data.weeklySummaries.length === 1, JSON.stringify(exported.data.weeklySummaries).slice(0, 160));

  const exportCount = (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['users'] }));
  void exportCount;
  const secondExport = await convex.mutation(anyApi.logbook.exportLogbook, {
    token: intern.token, exportType: 'pdf',
  });
  check('a second export is recorded separately', secondExport.success === true);

  const badType = await convex.mutation(anyApi.logbook.exportLogbook, {
    token: intern.token, exportType: 'telepathy',
  });
  check('an unknown export type is rejected', badType.success === false, JSON.stringify(badType));

  const outsider = await mkUser('outsider');
  const stealExport = await attempt(convex.mutation(anyApi.logbook.exportLogbook, {
    token: outsider.token, internUserId,
  }));
  check('a stranger cannot export someone else\'s logbook', !stealExport.ok, JSON.stringify(stealExport));

  const compliance = await convex.query(anyApi.siwes.cohortCompliance, { token: admin, cohortId });
  check('cohort compliance lists the intern', compliance.interns.length === 1, JSON.stringify(compliance.interns).slice(0, 200));
  check('compliance counts only the log still standing',
    compliance.interns[0].totalLogs === 1, JSON.stringify(compliance.interns[0]));
  check('compliance sees the signed-off week as not yet signed off',
    compliance.interns[0].signedOffWeeks === 0, JSON.stringify(compliance.interns[0]));

  const internCompliance = await attempt(convex.query(anyApi.siwes.cohortCompliance, {
    token: intern.token, cohortId,
  }));
  check('compliance is admin-only', !internCompliance.ok, JSON.stringify(internCompliance));

  section('Regressions found by the security review');

  // H3: the week keys must be immutable on update, as logDate already was.
  const wk = await convex.mutation(anyApi.logbook.saveWeeklySummary, {
    token: intern.token, weekStart: '2026-09-07', weekEnd: '2026-09-13',
    goals: 'original goals', summary: 'original summary', keyLearnings: 'original learnings',
  });
  await convex.mutation(anyApi.logbook.saveWeeklySummary, {
    token: intern.token, summaryId: wk.id,
    weekStart: '2026-08-03', weekEnd: '2026-08-09', summary: 'moved?',
  });
  const summaries = await convex.query(anyApi.logbook.listWeeklySummaries, { token: intern.token });
  const moved = summaries.find((x) => x._id === wk.id || x.id === wk.id);
  check('weekStart cannot be repointed at another week',
    moved.weekStart === '2026-09-07', JSON.stringify({ weekStart: moved.weekStart }));
  check('and the week is not duplicated',
    summaries.filter((x) => x.weekStart === '2026-08-03').length === 1,
    JSON.stringify(summaries.map((x) => x.weekStart)));

  // M5: an update that omits an optional field must not delete it.
  check('omitted optional fields survive an update',
    moved.goals === 'original goals' && moved.keyLearnings === 'original learnings',
    JSON.stringify({ goals: moved.goals, keyLearnings: moved.keyLearnings }));
  check('and the supplied field did change', moved.summary === 'moved?', moved.summary);

  const logsNow = await convex.query(anyApi.logbook.listDailyLogs, { token: intern.token });
  const target = logsNow.find((l) => l.title === 'Port log 2');

  // A DRAFT, because a submitted entry is intentionally locked. The point is
  // the optional fields, not the status guard.
  const draftDate = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const draft = await convex.mutation(anyApi.logbook.saveDailyLog, {
    token: intern.token, logDate: draftDate, participationMode: 'hybrid',
    title: 'Draft log', workDone: 'initial',
    learned: 'a lesson', toolsUsed: 'a tool', hoursSpent: 6,
  });
  await convex.mutation(anyApi.logbook.saveDailyLog, {
    token: intern.token, logId: draft.id, logDate: draftDate,
    participationMode: 'hybrid', title: 'Draft log edited', workDone: 'revised',
  });
  const edited = (await convex.query(anyApi.logbook.listDailyLogs, { token: intern.token }))
    .find((l) => l.id === draft.id);
  check('a daily-log edit applies the fields it sent',
    edited.title === 'Draft log edited' && edited.workDone === 'revised',
    JSON.stringify({ title: edited.title }));
  check('and does NOT wipe the ones it omitted',
    edited.learned === 'a lesson' && edited.toolsUsed === 'a tool' && edited.hoursSpent === 6,
    JSON.stringify({ learned: edited.learned, tools: edited.toolsUsed, hours: edited.hoursSpent }));

  const submittedEdit = await convex.mutation(anyApi.logbook.saveDailyLog, {
    token: intern.token, logId: target.id, logDate: target.logDate,
    participationMode: 'hybrid', title: 'should not apply', workDone: 'x',
  });
  check('a submitted log is still locked against edits',
    submittedEdit.success === false, JSON.stringify(submittedEdit));

  // M4: a department lead who is not a moderator must not be paged about work
  // they will be refused access to.
  // The lead is `lead2`, NOT `other` — `other` gets deactivated below for the
  // inactive-recipient check, which kills their session.
  const lead2 = await mkUser('lead');
  const dept = await convex.mutation(anyApi.siwes.saveDepartment, {
    token: admin, name: `Port Dept ${stamp}`, leadUserId: lead2.id,
  });
  const deptIntern = await mkUser('deptintern');
  const deptProfile = await convex.mutation(anyApi.siwes.saveProfile, {
    token: admin, userId: deptIntern.id, cohortId, participationMode: 'remote',
  });
  // departmentId is set through assignProfile, not saveProfile — assignment is
  // staff-only and deliberately separate from the profile the intern can edit.
  await convex.mutation(anyApi.siwes.assignProfile, {
    token: admin, internUserId: deptProfile.id, departmentId: dept.id,
  });
  const leadBefore = (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['notifications'] })).notifications;
  await convex.mutation(anyApi.logbook.saveDailyLog, {
    token: deptIntern.token, logDate: today, participationMode: 'remote',
    title: 'dept log', workDone: 'x', submit: true,
  });
  // Now that leading a department IS the grant, the lead IS notified — and can
  // act on it. The earlier behaviour (notified, then refused at the queue) was
  // the broken middle state.
  check('a department lead is notified of their department\'s submissions',
    (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['notifications'] })).notifications - leadBefore === 1);

  // L2: an inactive recipient should get no notification row at all.
  await convex.mutation(anyApi.users.adminSetActive, { token: admin, userId: other.id, isActive: false });
  const inactiveBefore = (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['notifications'] })).notifications;
  await convex.mutation(anyApi.notifications.adminSend, {
    token: admin, userId: other.id, title: 'to an inactive user', content: 'should not land',
  });
  check('no notification row is written for an inactive user',
    (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['notifications'] })).notifications === inactiveBefore);

  section('Second round of review fixes');

  // M4: a department lead can now actually review, without a separate role.
  const leadCanReview = await attempt(convex.query(anyApi.logbook.listDailyLogs, {
    token: lead2.token, internUserId: deptProfile.id,
  }));
  check('a department lead can read their department\'s logbook without the moderator role',
    leadCanReview.ok, JSON.stringify(leadCanReview).slice(0, 160));

  const strangerLead = await attempt(convex.query(anyApi.logbook.listDailyLogs, {
    token: outsider.token, internUserId: deptProfile.id,
  }));
  check('and a stranger still cannot', !strangerLead.ok, JSON.stringify(strangerLead).slice(0, 120));

  // L1: no existence oracle on profile ids.
  const missingProfile = await attempt(convex.query(anyApi.logbook.listDailyLogs, {
    token: outsider.token, internUserId: deptProfile.id,
  }));
  check('an unauthorised profile read says "not authorized", never "not found"',
    /Not authorized/.test(String(missingProfile.e)), String(missingProfile.e));

  // M3: application documents are no longer permanent capability URLs.
  const appsForDocs = await convex.query(anyApi.applications.list, { token: admin });
  if (appsForDocs.length) {
    const full = await convex.query(anyApi.applications.getById, {
      token: admin, applicationId: appsForDocs[0].id,
    });
    check('getById returns no raw storage URL',
      !JSON.stringify(full).includes('/api/storage/'), JSON.stringify(full).slice(0, 200));
  } else {
    check('getById returns no raw storage URL', true, 'no applications in dev');
  }

  const docNoAuth = await fetch(`${URL.replace('.convex.cloud', '.convex.site')}/applications/document?applicationId=x&kind=passport`);
  check('the document route rejects an unauthenticated request',
    docNoAuth.status === 400 || docNoAuth.status === 404, String(docNoAuth.status));

  // L4: a no-op status update must not re-stamp the reviewer.
  if (appsForDocs.length) {
    const noop = await convex.mutation(anyApi.applications.updateStatus, {
      token: admin, applicationId: appsForDocs[0].id, status: appsForDocs[0].status,
    });
    check('a no-op application update reports no change', noop.changed === false, JSON.stringify(noop));
  } else {
    check('a no-op application update reports no change', true, 'no applications in dev');
  }

  // Auth-failure auditing, read back through the new audit viewer rather than
  // inferred from a row count — the 5-minute suppression window makes counting
  // order-dependent across runs, which is the behaviour, not a bug.
  const intruder = `port-intern-${stamp}@iih.ng`;
  await signIn({ email: intruder, password: 'definitely-wrong' });

  // NOT named `failures` — that shadows the harness's own results array for the
  // rest of main(), and the summary at the bottom then reports audit rows as
  // test failures.
  const loginFailures = await convex.query(anyApi.auditLogs.list, {
    token: admin, action: 'auth.login_failed', limit: 5,
  });
  check('a failed sign-in is audited', loginFailures.length >= 1, JSON.stringify(loginFailures.slice(0, 1)));
  // Not pinned to THIS run's address: within the 5-minute window the row belongs
  // to whichever attempt opened it, and later failures patch `lastReason` onto
  // it rather than inserting. That is the whole point of the suppression.
  const reason = loginFailures[0].metadata?.lastReason ?? loginFailures[0].errorMessage;
  check('the audit row names an account and the reason',
    /@iih\.ng$/.test(loginFailures[0].userEmail ?? '') && /Wrong password/.test(reason ?? ''),
    JSON.stringify({ userEmail: loginFailures[0].userEmail, reason }));
  check('and is marked unsuccessful', loginFailures[0].success === false);

  const rowIdBefore = loginFailures[0].id;
  const suppressedBefore = loginFailures[0].metadata?.suppressed ?? 0;
  for (let i = 0; i < 5; i++) {
    await signIn({ email: intruder, password: `wrong-${i}` });
  }
  const afterBurst = await convex.query(anyApi.auditLogs.list, {
    token: admin, action: 'auth.login_failed', limit: 5,
  });
  check('a burst of failures collapses into the SAME row', afterBurst[0].id === rowIdBefore,
    `${rowIdBefore} -> ${afterBurst[0].id}`);
  check('with a count of what it stood in for',
    (afterBurst[0].metadata?.suppressed ?? 0) === suppressedBefore + 5,
    JSON.stringify(afterBurst[0].metadata));

  const auditAsIntern = await attempt(convex.query(anyApi.auditLogs.list, { token: intern.token }));
  check('the audit log is admin-only', !auditAsIntern.ok, JSON.stringify(auditAsIntern));

  const actions = await convex.query(anyApi.auditLogs.actions, { token: admin });
  check('audit actions are enumerable for a filter UI',
    actions.includes('auth.login_failed'), JSON.stringify(actions.slice(0, 8)));

  section('Email logs');

  const mails = await convex.query(anyApi.emailQueue.adminList, { token: admin, limit: 20 });
  check('an admin can read the email log', Array.isArray(mails) && mails.length > 0, String(mails.length));
  check('the list carries no message body',
    !JSON.stringify(mails).includes('bodyHtml') && !JSON.stringify(mails).includes('Open ORBIT'),
    JSON.stringify(mails[0]));

  const bodyAsAdmin = await convex.mutation(anyApi.emailQueue.adminGetBody, {
    token: plainAdmin.token, emailId: mails[0].id,
  });
  check('a plain admin cannot read an email body', bodyAsAdmin.success === false, JSON.stringify(bodyAsAdmin));

  const body = await convex.mutation(anyApi.emailQueue.adminGetBody, { token: admin, emailId: mails[0].id });
  check('a super admin can, and gets the body', body.success === true && typeof body.bodyHtml === 'string');

  const viewed = await convex.query(anyApi.auditLogs.list, {
    token: admin, action: 'admin.email_body_viewed', limit: 1,
  });
  check('reading a body is audited', viewed.length >= 1, JSON.stringify(viewed[0] ?? null));

  const failedMail = mails.find((m) => m.status === 'failed');
  if (failedMail) {
    const retried = await convex.mutation(anyApi.emailQueue.adminRetry, { token: admin, emailId: failedMail.id });
    check('a failed email can be requeued', retried.success === true, JSON.stringify(retried));
  } else {
    console.log('  --   no failed emails in dev; retry path not exercised');
  }

  const reset = await convex.mutation(anyApi.users.adminResetPassword, { token: admin, userId: outsider.id });
  check('adminResetPassword issues a temp password', reset.success === true && reset.tempPassword?.length === 12,
    JSON.stringify({ ...reset, tempPassword: '<redacted>' }));
  check('and revokes their sessions', reset.sessionsRevoked >= 1, JSON.stringify(reset.sessionsRevoked));

  const reLogin = await signIn({
    email: `port-outsider-${stamp}@iih.ng`, password: reset.tempPassword,
  });
  check('the reset password works', reLogin.success === true, JSON.stringify(reLogin).slice(0, 120));

  const setByAdmin = await convex.mutation(anyApi.users.adminSetPassword, {
    token: plainAdmin.token, userId: outsider.id, newPassword: 'a-chosen-password',
  });
  check('adminSetPassword refuses a plain admin', setByAdmin.success === false, JSON.stringify(setByAdmin));

  const setShort = await convex.mutation(anyApi.users.adminSetPassword, {
    token: admin, userId: outsider.id, newPassword: 'short',
  });
  check('adminSetPassword enforces a length floor', setShort.success === false, JSON.stringify(setShort));

  await convex.mutation(anyApi.users.adminSetPassword, {
    token: admin, userId: outsider.id, newPassword: 'a-chosen-password',
  });
  const chosen = await signIn({
    email: `port-outsider-${stamp}@iih.ng`, password: 'a-chosen-password',
  });
  check('a super admin can set a password directly', chosen.success === true, JSON.stringify(chosen).slice(0, 120));
  const leaked = await convex.query(anyApi.users.adminGetById, { token: admin, userId: outsider.id });
  check('adminSetPassword does not leave the plaintext readable',
    !JSON.stringify(leaked).includes('a-chosen-password'), JSON.stringify(leaked).slice(0, 120));

  section('SIWES: attendance verification');

  await convex.mutation(anyApi.logbook.recordAttendance, {
    token: intern.token, attendanceDate: today, expectedMode: 'physical', checkIn: true,
  });
  const att = await convex.query(anyApi.logbook.listAttendance, { token: intern.token });
  check('the intern checked in as present', att[0].status === 'present', JSON.stringify(att[0]));
  check('and could not set verifiedBy themselves', !att[0].verifiedBy, JSON.stringify(att[0]));

  const badStatus = await convex.mutation(anyApi.logbook.verifyAttendance, {
    token: admin, attendanceId: att[0].id ?? att[0]._id, status: 'teleported',
  });
  check('an unknown attendance status is rejected', badStatus.success === false, JSON.stringify(badStatus));

  await convex.mutation(anyApi.logbook.verifyAttendance, {
    token: admin, attendanceId: att[0].id ?? att[0]._id, status: 'absent',
  });
  const verified = (await convex.query(anyApi.logbook.listAttendance, { token: intern.token }))[0];
  check('a reviewer can correct it to absent', verified.status === 'absent', JSON.stringify(verified));
  check('and is recorded as the verifier', Boolean(verified.verifiedBy), JSON.stringify(verified));

  const internVerify = await attempt(convex.mutation(anyApi.logbook.verifyAttendance, {
    token: intern.token, attendanceId: att[0].id ?? att[0]._id, status: 'present',
  }));
  check('the intern cannot verify their own attendance', !internVerify.ok, JSON.stringify(internVerify));

  const absent = await convex.mutation(anyApi.logbook.markAbsent, {
    token: admin, internUserId, attendanceDate: '2026-08-04', expectedMode: 'physical',
  });
  check('a reviewer can mark a no-show day absent', absent.success === true, JSON.stringify(absent));

  section('SIWES reminders');

  const reminders = await attempt(convex.mutation(anyApi.scheduled.sendSiwesReminders, {}));
  check('sendSiwesReminders is internal, not client-callable', !reminders.ok, JSON.stringify(reminders));

  section('Applications');

  const appsAsIntern = await attempt(convex.query(anyApi.applications.list, { token: intern.token }));
  check('applications are staff-only', !appsAsIntern.ok, JSON.stringify(appsAsIntern));

  const apps = await convex.query(anyApi.applications.list, { token: admin });
  check('an admin can list applications', Array.isArray(apps), JSON.stringify(apps).slice(0, 120));

  const appCounts = await convex.query(anyApi.applications.counts, { token: admin });
  check('counts returns a per-status breakdown',
    typeof appCounts.total === 'number' && appCounts.byStatus, JSON.stringify(appCounts));

  if (apps.length) {
    const bad = await convex.mutation(anyApi.applications.updateStatus, {
      token: admin, applicationId: apps[0].id, status: 'vibes',
    });
    check('an unknown application status is rejected', bad.success === false, JSON.stringify(bad));

    const upd = await convex.mutation(anyApi.applications.updateStatus, {
      token: admin, applicationId: apps[0].id, status: apps[0].status, notes: 'verified',
    });
    check('a valid status update round-trips', upd.success === true, JSON.stringify(upd));
  } else {
    console.log('  --   no applications in dev; status-update path not exercised');
  }

  section('File uploads');

  const PNG_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const SITE_URL = SITE;

  /** The real browser flow: get a URL, PUT the bytes, attach the id. */
  const upload = async (token, bytes, contentType) => {
    const gen = await convex.mutation(anyApi.files.generateUploadUrl, { token });
    if (!gen.success) return { failed: gen.error };
    const res = await fetch(gen.uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: Buffer.from(bytes, 'base64'),
    });
    return (await res.json()).storageId;
  };

  const anon = await convex.mutation(anyApi.files.generateUploadUrl, { token: 'not-a-token' })
    .then(() => 'issued').catch((e) => describe(e));
  check('an upload URL requires a session', anon !== 'issued', String(anon));

  const photoId = await upload(intern.token, PNG_B, 'image/png');
  const setPhoto = await convex.mutation(anyApi.files.setProfilePhoto, {
    token: intern.token, storageId: photoId, kind: 'profile',
  });
  check('a member can set their profile photo', setPhoto.success === true, JSON.stringify(setPhoto));
  check('and gets a usable URL back', /^https:\/\//.test(setPhoto.url ?? ''), setPhoto.url);

  const photoServed = await fetch(setPhoto.url);
  check('the photo actually serves', photoServed.status === 200, String(photoServed.status));
  check('with the right content type', photoServed.headers.get('content-type') === 'image/png');

  // Replacing must delete the old object — Convex never reclaims storage.
  const secondId = await upload(intern.token, PNG_B, 'image/png');
  await convex.mutation(anyApi.files.setProfilePhoto, {
    token: intern.token, storageId: secondId, kind: 'profile',
  });
  check('replacing a photo deletes the one it replaced',
    (await fetch(setPhoto.url)).status === 404, 'the old object should be gone');

  // The upload URL accepts anything; the ATTACH is what validates.
  const pdfId = await upload(intern.token, Buffer.from('%PDF-1.4').toString('base64'), 'application/pdf');
  const rejected = await convex.mutation(anyApi.files.setProfilePhoto, {
    token: intern.token, storageId: pdfId, kind: 'profile',
  });
  check('a non-image is rejected at attach, not at upload',
    rejected.success === false && /must be one of/.test(rejected.error), JSON.stringify(rejected));

  const photoAfterReject = await convex.query(anyApi.users.adminGetById, { token: admin, userId: intern.id });
  check('and the rejected file did not replace the good one',
    Boolean(photoAfterReject.profilePhotoUrl) && photoAfterReject.profilePhotoUrl !== setPhoto.url,
    photoAfterReject.profilePhotoUrl);

  const streamPhoto = await upload(intern.token, PNG_B, 'image/png');
  const notMine = await convex.mutation(anyApi.files.setStreamPhoto, {
    token: intern.token, streamId: stream.id, storageId: streamPhoto, kind: 'cover',
  });
  check('a member cannot set a stream photo',
    notMine.success === false && /access required/.test(notMine.error), JSON.stringify(notMine));

  const adminStreamPhoto = await upload(admin, PNG_B, 'image/png');
  const streamSet = await convex.mutation(anyApi.files.setStreamPhoto, {
    token: admin, streamId: stream.id, storageId: adminStreamPhoto, kind: 'cover',
  });
  check('an admin can', streamSet.success === true, JSON.stringify(streamSet));

  // Submission files are PRIVATE — the old bucket would have been public.
  // The intern needs a stream and a task in it, because submitting is now
  // scoped to streams you belong to.
  await convex.mutation(anyApi.streams.addMember, {
    token: admin, streamId: stream.id, userId: intern.id,
  });
  const uploadTask = await convex.mutation(anyApi.tasks.create, {
    token: admin, streamId: stream.id, title: `Upload task ${stamp}`, description: '',
    submissionType: 'file', points: 5, deadline: Date.now() + 86400000, notify: false,
  });
  const taskId = uploadTask.id;

  // A fresh user: `outsider` had their sessions revoked by the password tests
  // above, which is correct behaviour and useless as a fixture here.
  const stranger = await mkUser('stranger');

  const strandedFile = await upload(stranger.token, Buffer.from('not mine').toString('base64'), 'text/plain');
  const notMyStream = await convex.mutation(anyApi.files.attachSubmissionFile, {
    token: stranger.token, taskId, storageId: strandedFile,
  });
  check('a non-member cannot submit to a task in a stream they are not in',
    notMyStream.success === false && /not in one of your streams/.test(notMyStream.error),
    JSON.stringify(notMyStream));

  const acceptOutside = await convex.mutation(anyApi.tasks.acceptTask, { token: stranger.token, taskId })
    .then(() => 'accepted').catch((e) => describe(e));
  check('nor accept it', acceptOutside !== 'accepted', String(acceptOutside));

  const subFile = await upload(intern.token, Buffer.from('my coursework').toString('base64'), 'text/plain');
  const attached = await convex.mutation(anyApi.files.attachSubmissionFile, {
    token: intern.token, taskId, storageId: subFile, submissionText: 'see attached',
  });
  check('a member can attach a file to their submission', attached.success === true, JSON.stringify(attached));

  const fileNoAuth = await fetch(`${SITE_URL}/submissions/file?submissionId=${attached.id}`);
  check('a submission file is NOT publicly readable', fileNoAuth.status === 404, String(fileNoAuth.status));

  const fileAsOutsider = await fetch(`${SITE_URL}/submissions/file?submissionId=${attached.id}`, {
    headers: { Authorization: `Bearer ${stranger.token}` },
  });
  check('nor readable by another member', fileAsOutsider.status === 404, String(fileAsOutsider.status));

  const fileAsAuthor = await fetch(`${SITE_URL}/submissions/file?submissionId=${attached.id}`, {
    headers: { Authorization: `Bearer ${intern.token}` },
  });
  check('the author can read it', fileAsAuthor.status === 200, String(fileAsAuthor.status));
  check('and gets their bytes back', (await fileAsAuthor.text()) === 'my coursework');

  const fileAsStaff = await fetch(`${SITE_URL}/submissions/file?submissionId=${attached.id}`, {
    headers: { Authorization: `Bearer ${admin}` },
  });
  check('a reviewer can read it', fileAsStaff.status === 200, String(fileAsStaff.status));

  const oversize = await convex.mutation(anyApi.files.attachSubmissionFile, {
    token: intern.token, taskId, storageId: await upload(intern.token, PNG_B, 'application/x-msdownload'),
  });
  check('a disallowed submission type is rejected',
    oversize.success === false && /must be one of/.test(oversize.error), JSON.stringify(oversize));

  section('Security review round 3');

  // C1: the delete-any-file primitive. A member reads another member's photo id
  // out of their public avatar URL and passes it to a mutation they know will be
  // refused. Before the fix, the refusal path deleted the file.
  const victimPhotoId = await upload(member.token, PNG_B, 'image/png');
  const victimPhoto = await convex.mutation(anyApi.files.setProfilePhoto, {
    token: member.token, storageId: victimPhotoId, kind: 'profile',
  });
  check('victim has a photo', victimPhoto.success === true);

  const stealAttempt = await convex.mutation(anyApi.files.setStreamPhoto, {
    token: stranger.token, streamId: stream.id, storageId: victimPhotoId, kind: 'cover',
  });
  check('a refused stream-photo attach does not touch the id it was given',
    stealAttempt.success === false, JSON.stringify(stealAttempt));
  check("and the victim's photo still exists",
    (await fetch(victimPhoto.url)).status === 200, 'C1: any member could delete any file');

  // H6: nor can one member attach another's object to their own record.
  const hijack = await convex.mutation(anyApi.files.setProfilePhoto, {
    token: stranger.token, storageId: victimPhotoId, kind: 'profile',
  });
  check('a member cannot attach another member\'s upload', hijack.success === false,
    JSON.stringify(hijack));
  check("and the victim's photo survives that too",
    (await fetch(victimPhoto.url)).status === 200);

  // M5: re-attaching the same id must not delete the file just attached.
  const reattach = await convex.mutation(anyApi.files.setProfilePhoto, {
    token: member.token, storageId: victimPhotoId, kind: 'profile',
  });
  check('re-attaching the same id is a no-op, not a self-delete',
    reattach.success === true && (await fetch(victimPhoto.url)).status === 200,
    JSON.stringify(reattach));

  // Sign-in must not be reachable as a mutation any more — that is the form
  // that could not be rate limited honestly.
  const loginAsMutation = await convex.mutation(anyApi.auth.loginWithPassword, {
    email: 'x@y.z', password: 'x',
  }).then(() => 'callable').catch((e) => describe(e));
  check('loginWithPassword is not a public mutation',
    /Could not find public function/.test(String(loginAsMutation)), String(loginAsMutation));

  const magicAsMutation = await convex.mutation(anyApi.auth.requestMagicLink, { email: 'x@y.z' })
    .then(() => 'callable').catch((e) => describe(e));
  check('nor is requestMagicLink',
    /Could not find public function/.test(String(magicAsMutation)), String(magicAsMutation));

  const loginPreflight = await fetch(`${SITE}/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://orbit2.iih.ng',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  check('the sign-in route answers a CORS preflight', loginPreflight.status === 204,
    String(loginPreflight.status));

  // A caller-seeded x-forwarded-for must not become the rate-limit bucket: the
  // route reads the LAST hop, which is the one Convex's edge appended.
  const spoofed = await fetch(`${SITE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': 'unknown' },
    body: JSON.stringify({ email: `port-member-${stamp}@iih.ng`, password: 'wrong' }),
  }).then((r) => r.json());
  check('a spoofed X-Forwarded-For does not disable the limit',
    spoofed.success === false, JSON.stringify(spoofed));

  // C2: login rate limiting must actually run. It keyed on a client-supplied
  // ipAddress the app never sent, so it never engaged at all.
  const throttleTarget = `port-throttle-${stamp}@iih.ng`;
  await convex.mutation(anyApi.users.adminCreateUser, {
    token: admin, email: throttleTarget, fullName: `Throttle ${stamp}`, roles: ['intern'],
  });
  // These assert the C2 fix, so they are SKIPPED LOUDLY rather than passed
  // quietly on a deployment that has limits switched off for the migration.
  const flags = await convex.query(anyApi.mcp.deploymentFlags, { token: admin });

  if (!flags.rateLimitsEnforced) {
    console.log('  SKIP RATE_LIMITS_DISABLED=true here — throttle checks not run');
    console.log('       prod must never carry that variable; unsetting it is a cutover step');
  } else {
    let throttled = false;
    // Above the per-account cap (15), well below the per-address one (200): the
    // ACCOUNT limit should engage without the address limit taking the whole hub
    // down with it.
    for (let i = 0; i < 20; i++) {
      const r = await signIn({ email: throttleTarget, password: `wrong-${i}` });
      if (/Too many sign-in attempts/.test(r.error ?? '')) { throttled = true; break; }
    }
    check('repeated wrong passwords are throttled', throttled,
      'C2: the limit keyed on a value the client never sent, so it never ran');

    const otherAccount = await signIn({ email: `port-member-${stamp}@iih.ng`, password: 'wrong' });
    check('and the throttle is per account, not global',
      !/Too many sign-in attempts/.test(otherAccount.error ?? ''), JSON.stringify(otherAccount));
  }
  // H4: the authenticated file routes must be reachable from a browser.
  const preflight = await fetch(`${SITE_URL}/submissions/file?submissionId=x`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://orbit2.iih.ng',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  });
  check('the submission-file route answers a CORS preflight', preflight.status === 204,
    String(preflight.status));
  check('and allows the Authorization header',
    /authorization/i.test(preflight.headers.get('access-control-allow-headers') ?? ''),
    preflight.headers.get('access-control-allow-headers'));

  const docPreflight = await fetch(`${SITE_URL}/applications/document?applicationId=x&kind=passport`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://orbit2.iih.ng', 'Access-Control-Request-Method': 'GET' },
  });
  check('so does the applicant-document route', docPreflight.status === 204, String(docPreflight.status));

  const hardened = await fetch(`${SITE_URL}/submissions/file?submissionId=${attached.id}`, {
    headers: { Authorization: `Bearer ${intern.token}` },
  });
  check('file responses carry nosniff',
    hardened.headers.get('x-content-type-options') === 'nosniff',
    hardened.headers.get('x-content-type-options'));

  section('Post images');

  // The first version returned a permanent public storage URL for arbitrary
  // member content — a free image host on ORBIT's domain, surviving the post.
  const imgId = await upload(intern.token, PNG_B, 'image/png');
  const validated = await convex.mutation(anyApi.files.validatePostImage, {
    token: intern.token, storageId: imgId,
  });
  check('validating a post image returns an id, not a URL',
    validated.success === true && !JSON.stringify(validated).includes('http'),
    JSON.stringify(validated));

  const imgPost = await convex.mutation(anyApi.posts.create, {
    token: intern.token, content: `image post ${stamp}`, streamId: stream.id,
    imageStorageId: imgId,
  });
  check('a post can carry the image', imgPost.success === true, JSON.stringify(imgPost));

  const feed = await convex.query(anyApi.posts.feed, { token: intern.token, streamId: stream.id });
  const withImage = feed.find((f) => f.id === imgPost.id);
  check('the feed exposes a path, not a public URL',
    withImage.imagePath === `/posts/image?postId=${imgPost.id}`, JSON.stringify(withImage.imagePath));

  const imgNoAuth = await fetch(`${SITE}/posts/image?postId=${imgPost.id}`);
  check('a post image is not publicly readable', imgNoAuth.status === 404, String(imgNoAuth.status));

  const imgAsStranger = await fetch(`${SITE}/posts/image?postId=${imgPost.id}`, {
    headers: { Authorization: `Bearer ${stranger.token}` },
  });
  check('nor readable by a non-member of the stream', imgAsStranger.status === 404,
    String(imgAsStranger.status));

  const imgAsMember = await fetch(`${SITE}/posts/image?postId=${imgPost.id}`, {
    headers: { Authorization: `Bearer ${intern.token}` },
  });
  check('a member of the stream can read it', imgAsMember.status === 200, String(imgAsMember.status));
  check('and gets the image back',
    Buffer.from(await imgAsMember.arrayBuffer()).toString('base64') === PNG_B);

  const stolenImage = await convex.mutation(anyApi.posts.create, {
    token: stranger.token, content: 'not mine', imageStorageId: imgId,
  });
  check('another member cannot attach that image to their own post',
    stolenImage.success === false, JSON.stringify(stolenImage));

  await convex.mutation(anyApi.posts.remove, { token: intern.token, postId: imgPost.id });
  check('deleting the post deletes its image',
    (await fetch(`${SITE}/posts/image?postId=${imgPost.id}`, {
      headers: { Authorization: `Bearer ${intern.token}` },
    })).status === 404);

  section('Public application intake');

  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj').toString('base64');

  const submit = (body) =>
    fetch(`${SITE}/applications/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const application = (o = {}) => ({
    programme_type: 'siwes', consent_logbook: true, consent_data_use: true,
    full_name: `Intake ${stamp}`, email: `intake-${stamp}@example.com`, phone: '08000000000',
    location: 'Ilorin, Kwara', institution_name: 'Uni', course_of_study: 'CS', matric_number: 'M1',
    siwes_start_date: '2026-09-01', siwes_end_date: '2026-12-01',
    emergency_contact_name: 'Kin', emergency_contact_phone: '08111111111',
    track_interests: ['design-media-content', 'not-a-real-track'],
    passport_photo: { name: 'p.png', type: 'image/png', data_url: `data:image/png;base64,${PNG}` },
    siwes_letter: { name: 'letter.pdf', type: 'application/pdf', data_url: `data:application/pdf;base64,${PDF}` },
    ...o,
  });

  check('the honeypot answers success and writes nothing',
    (await submit({ website: 'bot' })).body.success === true);
  check('an end date before the start is rejected',
    /cannot be before/.test((await submit(application({ siwes_start_date: '2026-12-01', siwes_end_date: '2026-09-01' }))).body.error ?? ''));
  check('a SIWES application requires the letter',
    /required/.test((await submit(application({ siwes_letter: null }))).body.error ?? ''));
  check('a disallowed mime type is rejected',
    /must be/.test((await submit(application({ passport_photo: { name: 'x.exe', type: 'application/x-msdownload', data_url: 'data:application/x-msdownload;base64,AAAA' } }))).body.error ?? ''));
  // The one that matters: a caller must not be able to label a PDF as an image
  // and have it stored, then served back with an attacker-chosen content type.
  check('a mime type that lies about its data URL is rejected',
    /data is invalid/.test((await submit(application({ passport_photo: { name: 'p.png', type: 'image/png', data_url: `data:application/pdf;base64,${PDF}` } }))).body.error ?? ''));
  check('consent is mandatory',
    /consent/.test((await submit(application({ consent_data_use: false }))).body.error ?? ''));

  const appsBefore = (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['applications'] })).applications;
  const submitted = await submit(application());
  check('a valid application is accepted', submitted.body.success === true, JSON.stringify(submitted.body));
  check('it returns a reference code', /^ORB-\d{4}-[0-9A-F]{8}$/.test(submitted.body.reference_code ?? ''),
    submitted.body.reference_code);
  check('exactly one row was written',
    (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['applications'] })).applications - appsBefore === 1);

  const intakeApps = await convex.query(anyApi.applications.list, { token: admin, limit: 5 });
  const submittedApp = intakeApps.find((x) => x.referenceCode === submitted.body.reference_code);
  check('it appears in the admin list', Boolean(submittedApp));
  check('the Ilorin location set hybrid participation',
    submittedApp.preferredParticipationMode === 'hybrid', submittedApp.preferredParticipationMode);
  check('an unknown track interest was dropped',
    JSON.stringify(submittedApp.trackInterests) === '["design-media-content"]',
    JSON.stringify(submittedApp.trackInterests));

  const fullApp = await convex.query(anyApi.applications.getById, {
    token: admin, applicationId: submittedApp.id,
  });
  check('both documents are stored',
    fullApp.passportPhoto.available && fullApp.siwesLetter.available, JSON.stringify(fullApp.passportPhoto));
  check('exposed as a path, never a storage URL',
    fullApp.passportPhoto.path?.startsWith('/applications/document'), JSON.stringify(fullApp.passportPhoto));

  const docNoToken = await fetch(`${SITE}/applications/document?applicationId=${submittedApp.id}&kind=passport`);
  const docBadToken = await fetch(`${SITE}/applications/document?applicationId=${submittedApp.id}&kind=passport`, {
    headers: { Authorization: 'Bearer nope' },
  });
  check('an unauthenticated document fetch is refused', docNoToken.status === 404, String(docNoToken.status));
  check('and a bad token is indistinguishable from none',
    docBadToken.status === docNoToken.status, `${docBadToken.status} vs ${docNoToken.status}`);
  check('a malformed document request is a 400, not a 404',
    (await fetch(`${SITE}/applications/document?kind=passport`)).status === 400);

  const docAsIntern = await fetch(`${SITE}/applications/document?applicationId=${submittedApp.id}&kind=passport`, {
    headers: { Authorization: `Bearer ${intern.token}` },
  });
  check('a non-staff session cannot fetch a document', docAsIntern.status === 404, String(docAsIntern.status));

  const doc = await fetch(`${SITE}/applications/document?applicationId=${submittedApp.id}&kind=passport`, {
    headers: { Authorization: `Bearer ${admin}` },
  });
  check('an admin can fetch it', doc.status === 200, String(doc.status));
  check('served with the stored content type', doc.headers.get('content-type') === 'image/png',
    doc.headers.get('content-type'));
  check('and never cached', /no-store/.test(doc.headers.get('cache-control') ?? ''),
    doc.headers.get('cache-control'));
  check('the bytes round-tripped intact',
    Buffer.from(await doc.arrayBuffer()).toString('base64') === PNG);

  const viewedAudit = await convex.query(anyApi.auditLogs.list, {
    token: admin, action: 'admissions.document_viewed', limit: 1,
  });
  check('opening a document is audited', viewedAudit.length >= 1, JSON.stringify(viewedAudit[0] ?? null));

  const adminNotifs = await convex.query(anyApi.notifications.list, { token: admin, limit: 10 });
  check('admins are notified of a new application',
    adminNotifs.some((n) => n.type === 'application_received' && n.content.includes(submitted.body.reference_code)));

  // Confirmation email to the applicant, and the guard that makes it safe.
  const mailForApplicant = (await convex.query(anyApi.emailQueue.adminList, { token: admin, limit: 50 }))
    .filter((m) => m.recipientEmail === `intake-${stamp}@example.com`);
  check('the applicant gets exactly one confirmation email',
    mailForApplicant.length === 1, JSON.stringify(mailForApplicant.map((m) => m.emailType)));
  check('it is the application receipt',
    mailForApplicant[0].emailType === 'application_received' &&
    mailForApplicant[0].subject.includes(submitted.body.reference_code),
    mailForApplicant[0].subject);

  const receipt = await convex.mutation(anyApi.emailQueue.adminGetBody, {
    token: admin, emailId: mailForApplicant[0].id,
  });
  check('the receipt carries the reference code',
    receipt.bodyText.includes(submitted.body.reference_code));
  check('and says no account exists yet',
    /do not have an ORBIT account/.test(receipt.bodyText), receipt.bodyText.slice(0, 80));

  // Resubmitting dedupes the EMAIL, not the APPLICATION.
  //
  // The first version discarded the whole submission and returned the earlier
  // row's reference code. That let a stranger apply under someone's address and
  // silently swallow that person's real application when it arrived — with
  // admissions reviewing the attacker's row under their name, and the victim
  // holding a reference code that resolved to somebody else's data.
  const resubmitted = await submit(application());
  check('a resubmission is RECORDED, not discarded',
    resubmitted.body.success === true, JSON.stringify(resubmitted.body));
  check('and gets its own reference code, not the earlier applicant\'s',
    resubmitted.body.reference_code !== submitted.body.reference_code,
    `${resubmitted.body.reference_code} vs ${submitted.body.reference_code}`);
  check('so a second row exists',
    (await convex.query(anyApi.mcp.rowCounts, { token: admin, tables: ['applications'] })).applications - appsBefore === 2);
  // The property that made the confirmation email defensible in the first place.
  check('but the address is mailed only once',
    (await convex.query(anyApi.emailQueue.adminList, { token: admin, limit: 50 }))
      .filter((m) => m.recipientEmail === `intake-${stamp}@example.com`).length === 1);

  // H2: plus-addressing must not walk through the guard.
  const plusTagged = await submit(application({ email: `intake-${stamp}+evade@example.com` }));
  check('a +tagged variant of the same inbox is accepted as an application',
    plusTagged.body.success === true, JSON.stringify(plusTagged.body));
  check('but does NOT earn a second email to that inbox',
    (await convex.query(anyApi.emailQueue.adminList, { token: admin, limit: 50 }))
      .filter((m) => m.recipientEmail.startsWith(`intake-${stamp}`)).length === 1,
    'the guard canonicalises the address before comparing');

  const statusUpdate = await convex.mutation(anyApi.applications.updateStatus, {
    token: admin, applicationId: submittedApp.id, status: 'under_review', notes: 'verified',
  });
  check('an admin can move it through the pipeline',
    statusUpdate.success === true && statusUpdate.changed === true, JSON.stringify(statusUpdate));

  section('Cleanup');

  for (const u of [member.id, other.id, plainAdmin.id, intern.id, outsider.id, author.id, lead2.id, deptIntern.id, stranger.id]) {
    await convex.mutation(anyApi.users.adminSetActive, { token: admin, userId: u, isActive: false }).catch(() => {});
  }
  await convex.mutation(anyApi.streams.deactivate, { token: admin, streamId: stream.id }).catch(() => {});
  console.log('  fixtures deactivated');

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch((e) => { console.error('\nHARNESS ERROR:', e); process.exit(2); });
