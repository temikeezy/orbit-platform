import { vi } from 'vitest';
import { getFunctionName } from 'convex/server';

/**
 * A controllable stand-in for the Convex client and the httpAction routes.
 *
 * The existing suite mocks `supabase`, which every swapped module has stopped
 * calling — so those tests were passing assertions about plumbing that no longer
 * runs, then failing outright once the modules moved. This replaces the mock at
 * the same seam.
 *
 * Deliberately NOT a full fake backend. Behaviour is verified against a real
 * deployment in `src/test/integration/convex-client-swap.test.ts`; what unit
 * tests need is control over what a call returns, so they can assert what the
 * module does with it.
 */

type Handler = (args: Record<string, unknown>) => unknown;

/** Keyed by the function's dotted path, e.g. `users.list`. */
const queries = new Map<string, Handler>();
const mutations = new Map<string, Handler>();
const routes = new Map<string, Handler>();

/**
 * `module:name` -> `module.name`.
 *
 * Convex's own `getFunctionName`, not `String(ref)`: a function reference is a
 * proxy, and stringifying it throws rather than yielding a path.
 */
function pathOf(ref: unknown): string {
  return getFunctionName(ref as Parameters<typeof getFunctionName>[0]).replace(':', '.');
}

function dispatch(kind: string, table: Map<string, Handler>, ref: unknown, args: Record<string, unknown>) {
  const path = pathOf(ref);
  const handler = table.get(path);

  if (!handler) {
    // Loud rather than undefined: a test that silently receives nothing from an
    // unmocked call fails somewhere far away from the cause.
    throw new Error(`No mock registered for ${kind} ${path}`);
  }

  return handler(args);
}

export const convexMock = {
  /** Registers what a query returns. Throwing from the handler simulates an error. */
  onQuery(path: string, handler: Handler) {
    queries.set(path, handler);
  },

  onMutation(path: string, handler: Handler) {
    mutations.set(path, handler);
  },

  /** Registers an httpAction route, e.g. `/auth/login`. */
  onRoute(path: string, handler: Handler) {
    routes.set(path, handler);
  },

  reset() {
    queries.clear();
    mutations.clear();
    routes.clear();
  },

  /**
   * Answers `auth.me` with whatever user the test seeded into localStorage.
   *
   * AuthProvider revalidates the cached session on mount and SIGNS OUT when
   * `auth.me` returns null — that is the whole point of it, since there is no
   * client-side expiry any more. So a component test that leaves this
   * unregistered, or stubs it as null, silently loses its user before the first
   * assertion and every role-gated element disappears.
   */
  echoSession() {
    queries.set('auth.me', () => {
      const raw = localStorage.getItem('orbit_user_v2');
      if (!raw) return null;

      const u = JSON.parse(raw) as Record<string, unknown>;
      return {
        id: u.id,
        email: u.email,
        fullName: u.full_name,
        profileSlug: 'seeded',
        roles: u.roles,
        totalPoints: u.total_points ?? 0,
        currentLevel: u.current_level ?? 1,
        isActive: true,
        createdAt: 1_700_000_000_000,
      };
    });
    mutations.set('auth.logout', () => ({ success: true }));
  },

  client: {
    // REJECTS rather than throwing synchronously. The real client returns a
    // promise, so code that guards a call with `.catch()` — `authService.logout`
    // fires the server-side revoke that way, deliberately, so a network failure
    // cannot strand someone signed in — would have the throw escape the guard
    // and fail only under the mock.
    query: vi.fn(async (ref: unknown, args: Record<string, unknown> = {}) =>
      dispatch('query', queries, ref, args),
    ),
    mutation: vi.fn(async (ref: unknown, args: Record<string, unknown> = {}) =>
      dispatch('mutation', mutations, ref, args),
    ),
  },

  /** Installs a `fetch` that answers the registered httpAction routes. */
  installFetch() {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const handler = routes.get(url.pathname);

      if (!handler) throw new Error(`No mock registered for route ${url.pathname}`);

      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const result = handler(body);

      return {
        ok: true,
        status: 200,
        json: async () => result,
      } as Response;
    }) as typeof fetch;
  },
};

/**
 * `useQuery` / `useMutation` for components.
 *
 * ConvexProvider wants a real ConvexReactClient — it holds a WebSocket and a
 * query store, neither of which a stub can stand in for — so the HOOKS are
 * replaced instead of the client beneath them. Components under test then read
 * from the same registry as the imperative modules.
 *
 * An unregistered query returns `undefined` rather than throwing, because that
 * is what the real hook returns before its first result arrives: a component
 * has to render in that state, and making it a failure would mean every test
 * had to register every query on the page.
 */
vi.mock('convex/react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return {
    ...actual,
    useQuery: (ref: unknown, args?: Record<string, unknown> | 'skip') => {
      if (args === 'skip') return undefined;
      const handler = queries.get(pathOf(ref));
      return handler ? handler(args ?? {}) : undefined;
    },
    useMutation:
      (ref: unknown) =>
      (args: Record<string, unknown> = {}) =>
        Promise.resolve().then(() => dispatch('mutation', mutations, ref, args)),
  };
});

vi.mock('../../lib/convex', () => ({
  convex: convexMock.client,
  convexHttp: convexMock.client,
  convexEnabled: true,
  // Real modules derive their httpAction URLs from this. A mock that omits it
  // fails at IMPORT time with "No export is defined", which reads like a broken
  // test file rather than an incomplete mock.
  convexSiteUrl: 'https://test.convex.site',
}));
