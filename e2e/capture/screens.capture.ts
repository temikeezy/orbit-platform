import { test, devices, type Page, type BrowserContext, type BrowserContextOptions } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { manifest, storageStateFor } from '../support/fixtures';
import { SCREENS, resolvePath, type RouteContext } from '../support/routes';
import type { Role } from '../support/orbit';

/**
 * The visual capture sweep: every screen in support/routes.ts, for every
 * role it is meaningful to check, at two viewports.
 *
 * This is a PROJECT, not a spec that runs with the rest of the suite — see
 * playwright.config.ts, where it is only added when ORBIT_CAPTURE is set. A
 * spec would slow down every ordinary run of `npm run test:e2e`; a standalone
 * script would throw away globalSetup (no fixtures, no scaffold, no
 * storageState) and burn the account's 15-per-15-minutes login budget signing
 * in from scratch for every shot. This gets globalSetup's fixtures for free by
 * being just another Playwright project in the same config.
 *
 * A missing screenshot is a gap in the gallery, not a red build: every shot is
 * wrapped so one broken screen cannot take the rest of the sweep down with it.
 */

const OUTPUT_DIR = path.join(process.cwd(), 'e2e', 'capture', 'output');

interface Viewport {
  id: 'desktop' | 'mobile';
  contextOptions: BrowserContextOptions;
}

const VIEWPORTS: Viewport[] = [
  { id: 'desktop', contextOptions: { viewport: { width: 1440, height: 900 } } },
  { id: 'mobile', contextOptions: { ...devices['Pixel 7'] } },
];

/**
 * Scope. Defaults to admin + intern, both viewports — the publishable build.
 * `npm run capture:all` sets ORBIT_CAPTURE_ROLES to sweep every role; the
 * projected size is printed by gallery.ts, not here, because this file may be
 * run without ever building the gallery.
 */
const ROLES: Role[] = (process.env.ORBIT_CAPTURE_ROLES?.split(',').map((r) => r.trim()) as
  | Role[]
  | undefined) ?? ['admin', 'intern'];

// Kills animations, transitions and the text-cursor blink, so two shots of an
// identical state are byte-identical rather than differing on whichever frame
// of a spinner or a caret happened to be current when the screenshot fired.
const FREEZE_CSS = `
  *, *::before, *::after {
    animation-play-state: paused !important;
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
`;

// A fixed instant, not `clock.install()`. Installing fake timers stalls the
// Convex client's own reconnect backoff — it schedules its next attempt with
// a real `setTimeout`, which a fully faked clock never fires, so
// `networkidle` never arrives and every capture in the run times out.
// `setFixedTime` only pins `Date.now()` / `new Date()`; real timers keep
// running.
const FIXED_TIME = new Date('2026-01-15T09:00:00Z');

async function waitForIdle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  // The real readiness signal. There are TWO loading idioms here, not one:
  // spinners (`animate-spin`) and the skeleton placeholders in
  // components/common/SkeletonLoader.tsx (`animate-pulse`, no spinner at all).
  // This waited only on the first, so every screen that skeletons while it
  // loads — the SIWES tabs, the admin tables — could be captured as grey
  // placeholder bars. Waiting for zero of both is still more honest than a
  // fixed sleep and cheaper than a per-screen ready selector.
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll('.animate-spin').length === 0 &&
        document.querySelectorAll('.animate-pulse').length === 0,
      { timeout: 15_000 },
    )
    .catch(() => {});
}

/** Dismisses whatever celebration overlay happened to be queued. */
async function dismissCelebrations(page: Page): Promise<void> {
  const levelUp = page.getByText(/Level Up/i).first();
  if (await levelUp.isVisible().catch(() => false)) {
    // LevelUpCelebration has no close button — it self-dismisses on a 5s
    // timer (see the component). Waiting it out is the only option.
    await levelUp.waitFor({ state: 'hidden', timeout: 6_000 }).catch(() => {});
  }

  const badgeClose = page.locator('button:has(svg.lucide-x)').first();
  const badgeModal = page.getByText(/new badge/i).first();
  if (await badgeModal.isVisible().catch(() => false)) {
    await badgeClose.click({ timeout: 2_000 }).catch(() => {});
  }
}

async function resetInteractionState(page: Page): Promise<void> {
  await page.mouse.move(0, 0).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

interface Sidecar {
  id: string;
  role: Role;
  viewport: 'desktop' | 'mobile';
  permitted: boolean;
  deniedShown: boolean;
  capturedAt: string;
  /** True when the page was too tall for one bitmap and only the viewport was taken. */
  clipped?: boolean;
  path: string;
  error?: string;
}

async function captureOne(
  context: BrowserContext,
  role: Role,
  viewport: Viewport,
  routeCtx: RouteContext,
): Promise<Sidecar[]> {
  const results: Sidecar[] = [];
  const dir = path.join(OUTPUT_DIR, role, viewport.id);
  mkdirSync(dir, { recursive: true });

  for (const screen of SCREENS) {
    if (screen.public && role !== ROLES[0]) continue; // public screens: one role is enough

    const permitted = screen.allowedRoles.includes(role);
    const page = await context.newPage();

    try {
      await page.clock.setFixedTime(FIXED_TIME);
      await page.addStyleTag({ content: FREEZE_CSS });
      await page.goto(resolvePath(screen, routeCtx), { waitUntil: 'domcontentloaded' });
      await waitForIdle(page);

      if (permitted && screen.prepare) {
        await screen.prepare(page, routeCtx).catch(() => {});
        await waitForIdle(page);
      }
      if (permitted && screen.ready) {
        await screen.ready(page).catch(() => {});
      }

      await dismissCelebrations(page);
      await resetInteractionState(page);
      await page.addStyleTag({ content: FREEZE_CSS }); // re-applied post-navigation content

      const deniedShown = await page
        .getByText(/Access Denied|Access denied|Super admin access required/)
        .first()
        .isVisible()
        .catch(() => false);

      const file = path.join(dir, `${screen.id}.png`);

      /**
       * Full page where possible, viewport where the page is too tall to exist
       * as one image.
       *
       * `fullPage` asks Chrome for a single bitmap the height of the document,
       * and the admin list screens render every row they are given: on a
       * deployment carrying thousands of users or tasks that is a document tens
       * of thousands of pixels tall, and taller again at a phone's width. Past
       * roughly sixteen thousand pixels `Page.captureScreenshot` returns a
       * protocol error, and retrying it repeatedly took the whole browser
       * context down with it — which is what left admin and super_admin four
       * screens short at mobile, with the run reported as a timeout rather than
       * as the size limit it actually was.
       *
       * A viewport-height shot of those screens is worth far more than a gap,
       * so the fallback records what it did rather than failing the sweep.
       */
      let clipped = false;
      try {
        await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
      } catch {
        clipped = true;
        await page.screenshot({ path: file, fullPage: false, animations: 'disabled' });
        console.log(`[capture] ${role}/${viewport.id}/${screen.id} too tall for one image — captured the viewport instead`);
      }

      const sidecar: Sidecar = {
        id: screen.id,
        role,
        viewport: viewport.id,
        permitted,
        deniedShown,
        capturedAt: new Date().toISOString(),
        clipped,
        path: path.relative(OUTPUT_DIR, file),
      };
      writeFileSync(path.join(dir, `${screen.id}.json`), JSON.stringify(sidecar, null, 2));
      results.push(sidecar);
    } catch (error) {
      // A missing screenshot is a gap in the gallery, not a red build.
      console.warn(`[capture] ${role}/${viewport.id}/${screen.id} failed:`, error);
      const sidecar: Sidecar = {
        id: screen.id,
        role,
        viewport: viewport.id,
        permitted,
        deniedShown: false,
        capturedAt: new Date().toISOString(),
        path: '',
        error: error instanceof Error ? error.message : String(error),
      };
      writeFileSync(path.join(dir, `${screen.id}.json`), JSON.stringify(sidecar, null, 2));
      results.push(sidecar);
    } finally {
      await page.close().catch(() => {});
    }
  }

  return results;
}

test.describe('capture', () => {
  for (const role of ROLES) {
    for (const viewport of VIEWPORTS) {
      test(`${role} @ ${viewport.id}`, async ({ browser }) => {
        const routeCtx: RouteContext = { manifest: manifest() };
        const context = await browser.newContext({
          storageState: storageStateFor(role),
          ...viewport.contextOptions,
        });

        const results = await captureOne(context, role, viewport, routeCtx);
        await context.close();

        const failed = results.filter((r) => r.error);
        console.log(
          `[capture] ${role}/${viewport.id}: ${results.length - failed.length}/${results.length} shots (${failed.length} gaps)`,
        );
      });
    }
  }
});
