import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://vitejs.dev/config/
/**
 * Fails the BUILD when VITE_CONVEX_URL is missing.
 *
 * `src/lib/convex.ts` throws when it is absent, but that is a RUNTIME throw —
 * Vite never executes the module while bundling, so the build succeeded and the
 * failure landed on the first user to load the page. Since Supabase was removed
 * there is no fallback path, so a bundle built without this variable can never
 * reach a backend, and the only honest place to notice is here.
 */
function requireConvexUrl(): Plugin {
  return {
    name: 'orbit-require-convex-url',
    // `build` only: `vite dev` reads .env.local, and blocking the dev server on
    // a variable it already has would be noise.
    apply: 'build',
    config(_config, { mode }) {
      const url = loadEnv(mode, process.cwd(), '')['VITE_CONVEX_URL'];
      if (!url) {
        throw new Error(
          'VITE_CONVEX_URL is not set.\n' +
            'It is inlined at build time, so this bundle could not reach a backend. ' +
            'Set it in the build environment (Netlify: Site configuration > Environment variables) and rebuild.',
        );
      }
    },
  };
}

export default defineConfig({
  build: {
    /**
     * PINNED, because vite 7 silently raised the floor.
     *
     * Vite 5 defaulted to `['es2020','edge88','firefox78','chrome87','safari14']`;
     * vite 7 defaults to Baseline Widely Available, which is
     * `['chrome107','edge107','firefox104','safari16']`. Upgrading the build
     * tool therefore dropped iOS 14 and 15 with no diff, no warning and no
     * change in bundle size — the kind of regression that byte-count comparison
     * cannot see.
     *
     * It is already visible in the CSS: at the vite 7 target, Tailwind's
     * `inset: 0` is emitted verbatim instead of being lowered to
     * top/right/bottom/left. The `inset` shorthand only landed in Safari 14.1,
     * so on iOS 14.0 every `fixed inset-0` overlay collapses — including the
     * mobile navigation's dismiss backdrop and every modal. Twenty-six files use
     * it.
     *
     * ORBIT runs on Nigerian student hardware, where old iPhones are common, so
     * which browsers are supported is a product decision and not a side effect
     * of a dependency bump. Raise this deliberately, with a reason, or not at
     * all.
     */
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
    /**
     * Set SEPARATELY, and this is the half that actually matters here.
     *
     * `cssTarget` does not inherit from `target` in a way that restores the old
     * behaviour, and it is the one that governs whether esbuild lowers
     * `inset: 0` into longhand. Setting `target` alone left the bare shorthand
     * in the stylesheet — verified by grepping the built CSS, which is the only
     * way to know: nothing about the build output's size or shape reveals it.
     *
     * No `es2020` here; cssTarget takes browser versions only.
     */
    cssTarget: ['edge88', 'firefox78', 'chrome87', 'safari14'],
  },
  plugins: [
    requireConvexUrl(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      // public/manifest.json is the manifest browsers actually load (index.html
      // links it, and the first <link rel="manifest"> wins). Generating a second
      // one here put two manifests on every page and they drifted apart.
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Workbox installs a NavigationRoute that answers EVERY navigation with
        // the cached index.html — correct for SPA routes, wrong for anything the
        // browser must actually fetch from the network.
        //
        // What is left under /api/* is `/api/calendar-ics`, which netlify.toml
        // proxies to the Convex httpAction. A user pasting that URL performs a
        // real navigation and must get the calendar, not the app shell.
        //
        // This denylist used to exist for the Zoho callback, back when it was a
        // navigation to /api/zoho-oauth-callback and the service worker answered
        // it with the SPA shell — so the callback never ran, the state token was
        // never consumed, and the browser sat on the /api/ URL showing "Invalid
        // OAuth response". That callback now goes straight to the Convex site
        // origin, which a same-origin service worker never intercepts, so the
        // rule no longer protects it. Kept for calendar-ics.
        navigateFallbackDenylist: [/^\/api\//],
        /**
         * No runtime caching of API responses.
         *
         * The `supabase-api` NetworkFirst rule that was here cached every API
         * response for five minutes, which meant a stale read could survive a
         * sign-out — and during this migration it silently served old data over
         * a backend that had already changed, masking breakage during
         * verification. Convex queries come over a WebSocket the service worker
         * does not intercept, and the authenticated file routes are explicitly
         * `no-store` / `no-cache`. Precaching the app shell is kept.
         *
         * The old cache is NOT self-clearing: installed clients keep it until
         * their service worker updates. Purging `supabase-api` is a cutover
         * step.
         */
        runtimeCaching: [],
        // Removing the rule above does not remove the cache it created on
        // clients that already installed it. This deletes it on activation.
        importScripts: ['/sw-cleanup.js'],
      },
    }),
  ],
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
});
