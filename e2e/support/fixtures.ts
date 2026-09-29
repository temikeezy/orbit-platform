import { test as base, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Manifest } from './global-setup';
import type { Role } from './orbit';

export { expect };

const MANIFEST_PATH = path.join(process.cwd(), 'e2e', '.auth', 'manifest.json');

export function manifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
}

export function storageStateFor(role: Role): string {
  return path.join(process.cwd(), 'e2e', '.auth', `${role}.json`);
}

/**
 * Console and page errors, collected per test.
 *
 * This is the point of the smoke matrix. A React page that throws on mount
 * still renders the surrounding chrome, so a test that only asserts "the header
 * is visible" passes over a completely broken page. Failing the test on an
 * uncaught error is what turns navigation into a real assertion.
 *
 * Not every console.error is a defect, so the filter below is deliberately
 * narrow — see IGNORED.
 */
const IGNORED: RegExp[] = [
  // React's own dev warnings are noise here, not page failures.
  /Warning: ReactDOM.render/,
  /Warning: An update to .* inside a test was not wrapped in act/,
  // The PWA registers a service worker against a preview server that has no
  // scope for it; harmless and unrelated to the page under test.
  /ServiceWorker|workbox|sw\.js/i,
  // Favicon and manifest 404s from vite preview.
  /favicon|manifest\.webmanifest/i,
];

export interface PageErrors {
  errors: string[];
  assertClean(): void;
}

export function watchForErrors(page: Page): PageErrors {
  const errors: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED.some((re) => re.test(text))) return;
    errors.push(`console.error: ${text}`);
  });

  // An uncaught exception in a component — the "page throws on mount" case that
  // nothing in the repo could previously detect.
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  return {
    errors,
    assertClean() {
      expect(errors, `page reported errors:\n${errors.join('\n')}`).toEqual([]);
    },
  };
}

/** A test with error-watching wired in and the manifest available. */
export const test = base.extend<{ pageErrors: PageErrors }>({
  // The second argument is Playwright's fixture-provider callback. It is named
  // `provide` rather than the conventional `use` because eslint's
  // react-hooks/rules-of-hooks reads a bare `use(...)` call as React's `use`
  // hook and rejects it outside a component.
  pageErrors: async ({ page }, provide) => {
    const watcher = watchForErrors(page);
    await provide(watcher);
  },
});
