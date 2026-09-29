import { ConvexReactClient } from 'convex/react';
import { ConvexHttpClient } from 'convex/browser';

/**
 * Convex client.
 *
 * VITE_CONVEX_URL is baked in AT BUILD TIME, so a build made without it
 * produces a bundle that can never reach a backend, whatever the environment
 * does later.
 *
 * This used to fall back to a placeholder URL on the reasoning that every
 * screen still had a working Supabase path, so a missing Convex URL should
 * degrade to "the ported features are unavailable" rather than a white screen.
 * Supabase is gone: there is no other path, and that fallback now produces an
 * app that renders normally and fails every single call against a hostname that
 * does not exist. Failing at module load, loudly, is the honest outcome — and
 * it fails the BUILD's smoke check rather than the user's session.
 */
const url = import.meta.env.VITE_CONVEX_URL as string | undefined;

if (!url) {
  throw new Error(
    'VITE_CONVEX_URL is not set. It is baked in at build time, so this bundle ' +
      'cannot reach a backend. Set it in the build environment and rebuild.',
  );
}

export const convexEnabled = true;

const RESOLVED_URL = url;

/**
 * The REACTIVE client, for `useQuery` in components.
 *
 * A placeholder URL keeps it constructible when the env var is absent: during
 * the migration every screen still has a working Supabase path, so a missing
 * Convex URL should degrade to "the ported features are unavailable", never a
 * white screen.
 *
 * It holds a WebSocket, which is what makes live queries live.
 */
export const convex = new ConvexReactClient(RESOLVED_URL);

/**
 * The REQUEST/RESPONSE client, for the imperative API modules.
 *
 * `src/lib/api/*` are one-shot calls — fetch a list, submit a form — with no
 * subscription semantics. Routing them through the reactive client meant every
 * one of them depended on a live WebSocket, which is both more machinery than
 * the call needs and untestable outside a browser: in jsdom the socket never
 * completes its handshake and every call simply hangs until the test times out.
 *
 * The reactive client stays for components that genuinely want live data.
 */
export const convexHttp = new ConvexHttpClient(RESOLVED_URL);

/**
 * The `.convex.site` origin, where httpActions live — queries and mutations are
 * on `.convex.cloud`. Deriving one from the other keeps a single env var
 * authoritative; three modules were each doing this replace inline.
 */
export const convexSiteUrl = RESOLVED_URL.replace('.convex.cloud', '.convex.site');
