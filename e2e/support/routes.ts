import type { Page } from '@playwright/test';
import type { Role } from './orbit';
import type { Manifest } from './global-setup';

/**
 * The single Screen inventory: every addressable surface of the app, in one
 * place, consumed by both the smoke matrix (smoke.spec.ts) and the visual
 * capture sweep (capture/screens.capture.ts).
 *
 * Before this existed the two would have needed their own route lists, and
 * route lists drift — smoke.spec.ts's inline arrays already had, which is the
 * whole reason 15 screens had never been rendered by any test. `/admin/*` is
 * ONE route rendering thirteen tab states from client-side `useState`, five of
 * them reachable only through a callback from another tab and never from a
 * URL — hence `prepare()`: getting to some of these screens is itself a
 * mid-test action, not just a `goto`.
 */

export const ALL_ROLES: Role[] = ['intern', 'moderator', 'admin', 'super_admin'];

export interface RouteContext {
  manifest: Manifest;
}

/**
 * The four denial shapes actually in the codebase (see the audit this file
 * closes out). A screen carries the ONE that its own guard renders — a test
 * that asserted a generic "Access Denied" for all four would pass against a
 * page whose in-page gate had silently broken, because it would still be
 * reading the OUTER ProtectedRoute's text on a route that has no outer guard
 * at all.
 */
export type Denial =
  // ProtectedRoute's panel, wrapping the whole route: /admin, /review,
  // /admin/submissions.
  | { kind: 'protected-route' }
  // A page-owned gate rendering its own prose, matched by substring.
  | { kind: 'text'; text: string };

export interface Screen {
  /** Stable id, used as the test title and the capture filename stem. */
  id: string;
  /** A literal path, or one resolved from the run's fixtures. */
  path: string | ((ctx: RouteContext) => string);
  /** Roles the route actually admits. Every other role gets the denial test. */
  allowedRoles: Role[];
  /**
   * True for anything reached through AdminDashboard's client-side tab state
   * rather than its own URL. `path` is always '/admin' for these; `prepare`
   * does the clicking that gets from the default Overview tab to this one.
   */
  admin?: boolean;
  /** How a role NOT in `allowedRoles` is refused. Omitted where refusal is
   *  not independently testable (see the two-hop admin tabs below). */
  denial?: Denial;
  /**
   * Skips the denial test even though `denial` may be set on a sibling
   * screen sharing the same path. Used for the eleven admin tabs beyond the
   * base '/admin' entry: they all share ProtectedRoute's guard on the SAME
   * '/admin' url, so re-asserting 'Access Denied' once per tab is the same
   * assertion eleven times over. The base 'admin-overview' screen carries it
   * once for the whole group.
   */
  skipDenialCheck?: boolean;
  /** Public route: reachable with no session at all (and with one). */
  public?: boolean;
  /** Navigates from `path` to the screen itself. Only ever run for a role
   *  that is allowed — a denied role never gets far enough for this to make
   *  sense (see smoke.spec.ts and capture/screens.capture.ts). */
  prepare?: (page: Page, ctx: RouteContext) => Promise<void>;
  /** An extra readiness wait beyond "chrome mounted, no error boundary,
   *  no spinner" — e.g. a heading that proves the right tab is showing. */
  ready?: (page: Page) => Promise<void>;
}

export function resolvePath(screen: Screen, ctx: RouteContext): string {
  return typeof screen.path === 'function' ? screen.path(ctx) : screen.path;
}

async function clickTab(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('button', { name, exact: true }).first();
  // The admin tab row and the SIWES/Settings sub-tab rows are all
  // `overflow-x-auto`. On a 412px capture viewport the later tabs sit outside
  // the visible strip, and while Playwright's own actionability check scrolls
  // an element into view before clicking, that check operates on the PAGE's
  // scroll container — a nested horizontally-scrolling div is not always it.
  // Forcing the scroll explicitly is what stops the mobile admin gallery from
  // becoming seven screenshots of Overview.
  await tab.scrollIntoViewIfNeeded();
  await tab.click();
}

async function clickButton(page: Page, name: string | RegExp): Promise<void> {
  const button = page.getByRole('button', { name }).first();
  await button.scrollIntoViewIfNeeded();
  await button.click();
}

const PROTECTED: Denial = { kind: 'protected-route' };

// ── Public, unauthenticated routes ──────────────────────────────────────────

const PUBLIC_SCREENS: Screen[] = [
  { id: 'apply', path: '/apply', allowedRoles: ALL_ROLES, public: true },
  { id: 'magic', path: '/magic', allowedRoles: ALL_ROLES, public: true },
  { id: 'oauthredirect', path: '/oauthredirect', allowedRoles: ALL_ROLES, public: true },
];

/**
 * NOT listed, deliberately: LoginPage's three states (the password form, the
 * magic-link form, and the "Check your email" acknowledgement). They have no
 * URL of their own — ProtectedRoute renders LoginPage inline on WHATEVER
 * protected path was requested — and a Screen is addressed by path and
 * rendered by two consumers that both run authenticated, so an entry here
 * could never reach them. Their coverage lives in auth.spec.ts, the one file
 * allowed to spend the 15-per-15-minutes login budget on real submissions,
 * plus a submit-nothing toggle check in smoke.spec.ts's unauthenticated block
 * for the client-side switch between the two forms.
 */

// ── Common authenticated routes — no role gate at all ───────────────────────

const COMMON_SCREENS: Screen[] = [
  { id: 'home', path: '/', allowedRoles: ALL_ROLES },
  { id: 'tasks', path: '/tasks', allowedRoles: ALL_ROLES },
  { id: 'task-calendar', path: '/task-calendar', allowedRoles: ALL_ROLES },
  { id: 'streams', path: '/streams', allowedRoles: ALL_ROLES },
  { id: 'community', path: '/community', allowedRoles: ALL_ROLES },
  { id: 'leaderboard', path: '/leaderboard', allowedRoles: ALL_ROLES },
  { id: 'badges', path: '/badges', allowedRoles: ALL_ROLES },
  { id: 'profile', path: '/profile', allowedRoles: ALL_ROLES },
  { id: 'profile-edit', path: '/profile/edit', allowedRoles: ALL_ROLES },
  { id: 'messages', path: '/messages', allowedRoles: ALL_ROLES },
  { id: 'notifications', path: '/notifications', allowedRoles: ALL_ROLES },
  { id: 'settings', path: '/settings', allowedRoles: ALL_ROLES },
  { id: 'orientation', path: '/orientation', allowedRoles: ALL_ROLES },
  // No route guard — the nav link is intern-only but any role can type the
  // URL, and it must degrade to "no internship profile yet", not crash.
  { id: 'logbook', path: '/logbook', allowedRoles: ALL_ROLES },
  // The `*` catch-all (NotFoundPage). NOT public, counter-intuitively: App.tsx
  // wraps `/*` in ProtectedRoute, so an unauthenticated visit to an unknown
  // path renders the sign-in form and only a signed-in user ever sees the 404.
  // The `ready` copy is what separates "the 404 rendered" from the failure it
  // replaced — app chrome wrapped around an empty white body, which reads
  // identically to a broken deploy.
  {
    id: 'not-found',
    path: '/this-route-does-not-exist',
    allowedRoles: ALL_ROLES,
    ready: (page) => page.getByText('Page not found').first().waitFor(),
  },
];

// ── Dynamic content routes, resolved from the run's scaffold ────────────────

const DYNAMIC_SCREENS: Screen[] = [
  {
    id: 'stream-detail',
    path: (ctx) => `/streams/${ctx.manifest.scaffold.streamId}`,
    allowedRoles: ALL_ROLES,
  },
  {
    id: 'stream-edit',
    // NO client-side guard at all — any role reaches this by URL and the
    // server rejects the write. It must render, not crash. See
    // task-authoring.spec.ts for the write itself being refused.
    path: (ctx) => `/streams/${ctx.manifest.scaffold.streamId}/edit`,
    allowedRoles: ALL_ROLES,
  },
  {
    id: 'task-detail',
    path: (ctx) => `/tasks/${ctx.manifest.scaffold.taskId}`,
    allowedRoles: ALL_ROLES,
  },
  {
    id: 'task-proposals',
    path: '/tasks/proposals',
    // TaskProposalsPage.tsx:106 — staff only, and its own in-page gate. Note
    // the CASE: 'Access denied', lowercase, distinct from ProtectedRoute's
    // 'Access Denied'. A test that only knew the capital form would pass here
    // even if this gate broke open.
    allowedRoles: ['moderator', 'admin', 'super_admin'],
    denial: { kind: 'text', text: 'Access denied' },
  },
  {
    id: 'task-edit',
    path: (ctx) => `/tasks/${ctx.manifest.scaffold.taskId}/edit`,
    // Gated on STREAM moderation, not the global role — the moderator actor
    // is a stream MEMBER of the scaffold stream, never granted the
    // stream-moderator row, so it is refused exactly like the intern. Only
    // admin/super_admin (who moderate every stream) get through.
    allowedRoles: ['admin', 'super_admin'],
    denial: { kind: 'text', text: "You don't have permission to edit tasks." },
  },
  {
    id: 'stream-add-task',
    path: (ctx) => `/streams/${ctx.manifest.scaffold.streamId}/add-task`,
    allowedRoles: ['admin', 'super_admin'],
    denial: {
      kind: 'text',
      text: "You don't have permission to create tasks in any streams.",
    },
  },
  {
    id: 'user-profile',
    path: (ctx) => `/users/${ctx.manifest.userId}`,
    allowedRoles: ALL_ROLES,
  },
  {
    id: 'message-thread',
    path: (ctx) => {
      const moderator = ctx.manifest.users.find((u) => u.role === 'moderator')!;
      return `/messages/${moderator.id}`;
    },
    allowedRoles: ALL_ROLES,
  },
];

// ── Top-level guarded routes ─────────────────────────────────────────────────

const GUARDED_SCREENS: Screen[] = [
  {
    id: 'review',
    path: '/review',
    allowedRoles: ['moderator', 'admin', 'super_admin'],
    denial: PROTECTED,
  },
  {
    id: 'admin-submissions',
    path: '/admin/submissions',
    allowedRoles: ['moderator', 'admin', 'super_admin'],
    denial: PROTECTED,
  },
];

// ── The admin console: one URL, thirteen tab states ─────────────────────────
//
// Only 'admin-overview' carries the denial check — see `skipDenialCheck`'s
// doc comment. 'bulk-import' is additionally not testable that way at all:
// the Overview quick action that reaches it is hidden from a plain admin
// client-side (see AdminHomePage.tsx), so there is no way to arrive at
// ImportPage as anyone but a super_admin — its own 'Super admin access
// required' gate is consequently unreachable through navigation, and stays
// undrivable from here. bulk-import.spec.ts covers the admin's actual
// experience (the quick action is simply absent).

const ADMIN_STAFF: Role[] = ['admin', 'super_admin'];

const ADMIN_SCREENS: Screen[] = [
  {
    id: 'admin-overview',
    path: '/admin',
    allowedRoles: ADMIN_STAFF,
    admin: true,
    denial: PROTECTED,
    ready: (page) => page.getByText('Admin Overview').first().waitFor(),
  },
  {
    id: 'admin-streams',
    path: '/admin',
    allowedRoles: ADMIN_STAFF,
    admin: true,
    skipDenialCheck: true,
    prepare: (page) => clickTab(page, 'Streams'),
    ready: (page) => page.getByText('Stream Management').first().waitFor(),
  },
  {
    id: 'admin-users',
    path: '/admin',
    allowedRoles: ADMIN_STAFF,
    admin: true,
    skipDenialCheck: true,
    prepare: (page) => clickTab(page, 'Users'),
    // The h1 UsersManagementPage renders, and the one string on it that
    // appears nowhere else in the app — Overview's quick action says 'Manage
    // Users', not this. Without a ready wait this was the single admin tab
    // where smoke could pass with the PREVIOUS tab still on screen, so a
    // UsersManagementPage that failed to mount was invisible.
    ready: (page) => page.getByText('User Management').first().waitFor(),
  },
  {
    id: 'admin-tasks',
    path: '/admin',
    allowedRoles: ADMIN_STAFF,
    admin: true,
    skipDenialCheck: true,
    prepare: (page) => clickTab(page, 'Tasks'),
    ready: (page) => page.getByText('Task Management').first().waitFor(),
  },
  {
    id: 'admin-applications',
    path: '/admin',
    allowedRoles: ADMIN_STAFF,
    admin: true,
    skipDenialCheck: true,
    prepare: (page) => clickTab(page, 'Applications'),
    // 'All Applications' is the heading AdminDashboard passes into
    // ApplicationsTab on this tab and nowhere else, so it can never match the
    // tab BUTTON's own 'Applications' label — which stays on screen whether or
    // not the tab's content mounted — and the SIWES section's copy of the same
    // component is headed 'SIWES Applications', which does not contain it.
    ready: (page) => page.getByText('All Applications').first().waitFor(),
  },
  {
    id: 'admin-siwes',
    path: '/admin',
    allowedRoles: ADMIN_STAFF,
    admin: true,
    skipDenialCheck: true,
    prepare: (page) => clickTab(page, 'SIWES'),
    ready: (page) => page.getByText('SIWES Management').first().waitFor(),
  },
  {
    id: 'admin-gamification',
    path: '/admin',
    allowedRoles: ADMIN_STAFF,
    admin: true,
    skipDenialCheck: true,
    prepare: (page) => clickTab(page, 'Gamification'),
    ready: (page) => page.getByText('Gamification Management').first().waitFor(),
  },
  {
    id: 'admin-settings',
    path: '/admin',
    allowedRoles: ADMIN_STAFF,
    admin: true,
    skipDenialCheck: true,
    prepare: (page) => clickTab(page, 'Settings'),
    ready: (page) => page.getByText('Admin Settings').first().waitFor(),
  },
  {
    id: 'admin-levels',
    path: '/admin',
    allowedRoles: ADMIN_STAFF,
    admin: true,
    skipDenialCheck: true,
    // Two hops: nothing but this callback wiring reaches LevelsManagementPage.
    prepare: async (page) => {
      await clickTab(page, 'Gamification');
      await clickButton(page, 'Manage Levels');
    },
    ready: (page) => page.getByText('Level Management').first().waitFor(),
  },
  {
    id: 'admin-badges',
    path: '/admin',
    allowedRoles: ADMIN_STAFF,
    admin: true,
    skipDenialCheck: true,
    prepare: async (page) => {
      await clickTab(page, 'Gamification');
      await clickButton(page, 'Manage Badges');
    },
    ready: (page) => page.getByText('Badges Management').first().waitFor(),
  },
  {
    id: 'admin-email-logs',
    path: '/admin',
    allowedRoles: ADMIN_STAFF,
    admin: true,
    skipDenialCheck: true,
    prepare: async (page) => {
      await clickTab(page, 'Settings');
      await clickTab(page, 'Email Configuration');
      await clickButton(page, 'View Email Logs');
    },
    ready: (page) => page.getByText('Email Logs').first().waitFor(),
  },
  {
    id: 'admin-backup-management',
    path: '/admin',
    allowedRoles: ADMIN_STAFF,
    admin: true,
    skipDenialCheck: true,
    prepare: async (page) => {
      await clickTab(page, 'Settings');
      await clickTab(page, 'Database Backup');
      await clickButton(page, 'View All Backups');
    },
    ready: (page) => page.getByText('Backups').first().waitFor(),
  },
  {
    id: 'admin-bulk-import',
    path: '/admin',
    // Overview's quick action is superAdminOnly-filtered client-side — a
    // plain admin never sees the button, so this is reachable only as a
    // super_admin. See the module comment for why no role gets a denial test.
    allowedRoles: ['super_admin'],
    admin: true,
    skipDenialCheck: true,
    prepare: (page) => clickButton(page, /Bulk Import/),
    ready: (page) => page.getByText('Import Users').first().waitFor(),
  },
];

export const SCREENS: Screen[] = [
  ...PUBLIC_SCREENS,
  ...COMMON_SCREENS,
  ...DYNAMIC_SCREENS,
  ...GUARDED_SCREENS,
  ...ADMIN_SCREENS,
];
