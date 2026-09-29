import '@testing-library/jest-dom';
import { afterEach, beforeEach } from 'vitest';

// Node >= 22 ships an experimental `localStorage` global whose methods are
// unusable without --localstorage-file, and it shadows any working Storage
// for bare `localStorage` references in tests. Install a functional
// in-memory Storage shim on both globalThis and window so tests and
// application code share one working store.
function makeMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => {
      store.clear();
    },
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
}

function needsStorageShim(storage: unknown): boolean {
  const s = storage as Storage | undefined;
  return typeof s?.clear !== 'function' || typeof s?.setItem !== 'function';
}

if (needsStorageShim(globalThis.localStorage)) {
  const localShim = makeMemoryStorage();
  const sessionShim = makeMemoryStorage();
  for (const target of [globalThis, typeof window !== 'undefined' ? window : null]) {
    if (!target) continue;
    Object.defineProperty(target, 'localStorage', {
      value: localShim,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(target, 'sessionStorage', {
      value: sessionShim,
      configurable: true,
      writable: true,
    });
  }
}

// Clear localStorage between tests
beforeEach(() => {
  localStorage.clear();
});

/**
 * Let in-flight work settle before the next test wipes the ground under it.
 *
 * `AuthProvider` validates the cached session asynchronously on mount. That
 * promise can outlive the test that started it, and it reads `localStorage` when
 * it RESOLVES, not when it was issued — so without this it lands after the
 * `beforeEach` above has cleared storage and the next test has re-seeded,
 * concludes the session is gone, and calls `authService.logout()`, which wipes
 * the new test's credentials mid-render. The symptom is a component that
 * inexplicably renders its signed-out state, in a test that never touched auth.
 *
 * Yielding one macrotask here lets that refresh resolve while its OWN seeded
 * data is still in place, so it returns a user and never reaches the logout.
 * The provider also cancels its own setUser on unmount; this covers the side
 * effect that happens inside the service, before the cancel flag is consulted.
 */
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});
