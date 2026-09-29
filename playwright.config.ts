import { defineConfig, devices } from '@playwright/test';

/**
 * Browser-level end-to-end tests.
 *
 * Two constraints shape this config, both learned the hard way:
 *
 * 1. THE PORT IS PINNED. `ALLOWED_ORIGINS` in convex/http.ts admits exactly
 *    APP_URL, localhost:3000 and localhost:5173. Vite silently falls back to
 *    5174 when 5173 is taken, and every sign-in would then fail CORS preflight
 *    before the request left the browser — which reads as a broken login, not a
 *    port collision. `strictPort` makes the collision the error instead.
 *
 * 2. THE DEPLOYMENT IS PINNED TO DEV. These specs create users, streams, tasks,
 *    submissions and applications, and several of those have no delete at all.
 *    `assertDevDeployment()` in the global setup refuses anything that is not
 *    the dev deployment (ORBIT_DEV_DEPLOYMENT, default your-dev-deployment).
 */
const PORT = 5173;
// ORBIT_DEV_DEPLOYMENT names your dev deployment (default: the original one).
// The default URL assumes the eu-west-1 region; set E2E_CONVEX_URL for others.
const DEV_DEPLOYMENT = process.env.ORBIT_DEV_DEPLOYMENT || 'your-dev-deployment';
const DEV_CONVEX = `https://${DEV_DEPLOYMENT}.eu-west-1.convex.cloud`;

// `||`, not `??`. GitHub Actions substitutes a MISSING secret as an empty
// string rather than leaving the variable unset, so `??` does not fire and `''`
// flows through to webServer.env.VITE_CONVEX_URL — where the build guard in
// vite.config.ts throws. The fallback exists precisely for the case where the
// secret is absent, which is the one case `??` did not cover.
const CONVEX_URL = process.env.E2E_CONVEX_URL || DEV_CONVEX;

// The support helpers read E2E_CONVEX_URL at import time, and they are imported
// by globalSetup — which runs after this file is evaluated. Writing it back here
// means one variable governs both the browser bundle and the fixture client, so
// they can never end up pointed at different deployments.
process.env.E2E_CONVEX_URL = CONVEX_URL;

export default defineConfig({
  testDir: './e2e',
  // A route x role matrix is a lot of near-identical navigations; running them
  // in parallel is the difference between a suite people run and one they skip.
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './e2e/support/global-setup.ts',
  globalTeardown: './e2e/support/global-teardown.ts',

  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    // capture/** is excluded from the default project: a route x role x
    // viewport screenshot sweep has no business slowing down `npm run test:e2e`,
    // and it is added back below as its own project only when explicitly asked
    // for.
    { name: 'chromium', testIgnore: '**/capture/**', use: { ...devices['Desktop Chrome'] } },
    ...(process.env.ORBIT_CAPTURE
      ? [
          {
            name: 'capture',
            testDir: './e2e/capture',
            testMatch: '**/*.capture.ts',
            // Each test walks the whole screen inventory for one role x
            // viewport combination — dozens of navigations, form fills and
            // full-page screenshots. The default 45s budget is sized for a
            // single page assertion, not a sweep.
            timeout: 300_000,
            use: {
              ...devices['Desktop Chrome'],
              // Its own screenshots are the point; Playwright's failure
              // artefacts would only double the output for no reason.
              trace: 'off' as const,
              screenshot: 'off' as const,
              video: 'off' as const,
            },
          },
        ]
      : []),
  ],

  webServer: {
    // The BUILT bundle, not the dev server. VITE_CONVEX_URL is inlined at build
    // time, so testing `vite dev` would exercise a different artefact than the
    // one that ships — and the build-time guard in vite.config.ts only runs here.
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { VITE_CONVEX_URL: CONVEX_URL },
  },
});
