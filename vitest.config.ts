import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://localhost:3000',
      },
    },
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    // Vitest's default include is the whole repo, so it collected the Playwright
    // specs and failed on `test.use`, which is not a vitest API. The two runners
    // own separate directories; say so rather than relying on file naming.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // A FRESH CLONE HAS NO .env.local, and src/lib/convex.ts throws at import
    // without VITE_CONVEX_URL (deliberately — a real build must not ship without
    // it). Unit and component tests mock the client and never reach a backend,
    // so they get a placeholder; the live integration suite still runs only when
    // a real dev deployment URL is exported (convex-client-swap.test.ts checks).
    env: {
      VITE_CONVEX_URL: process.env.VITE_CONVEX_URL ?? 'https://placeholder-for-tests.convex.cloud',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: { lines: 45, functions: 40, branches: 30 },
      // 'supabase/**' is gone — that directory was deleted with the migration.
      // 'e2e/**' is Playwright's, which vitest neither runs nor should measure.
      exclude: ['src/test/**', 'src/types/**', 'e2e/**', 'src/main.tsx'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
