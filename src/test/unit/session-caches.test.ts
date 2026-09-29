import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The registry that empties in-memory caches when a session ends.
 *
 * This exists because clearing localStorage on sign-out left two module-level
 * caches standing: admin settings, held for 60 seconds and served BEFORE any
 * token check while warm, and the level ladder. On a shared machine the next
 * person to sign in within that window could be handed the previous admin's
 * settings with no server authorization anywhere in the path.
 *
 * Two properties matter and neither was pinned: every registered cache is
 * cleared, and one that throws cannot stop the others or block the sign-out
 * that called it. The module keeps state in a module-level Set, so each test
 * re-imports it fresh.
 */

async function freshModule() {
  vi.resetModules();
  return import('../../lib/sessionCaches');
}

describe('sessionCaches', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('clears every registered cache', async () => {
    const { registerSessionCache, clearSessionCaches } = await freshModule();
    const first = vi.fn();
    const second = vi.fn();

    registerSessionCache(first);
    registerSessionCache(second);
    clearSessionCaches();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('keeps clearing after one cache throws', async () => {
    // The whole point of the try/catch: a stale settings cache surviving a
    // sign-out is the exact exposure this module was written to close, so one
    // misbehaving owner must not shield the others.
    const { registerSessionCache, clearSessionCaches } = await freshModule();
    const explodes = vi.fn(() => {
      throw new Error('cache owner is broken');
    });
    const after = vi.fn();

    registerSessionCache(explodes);
    registerSessionCache(after);

    expect(() => clearSessionCaches()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('never throws out of sign-out, even when every cache fails', async () => {
    const { registerSessionCache, clearSessionCaches } = await freshModule();
    registerSessionCache(() => {
      throw new Error('one');
    });
    registerSessionCache(() => {
      throw new Error('two');
    });

    expect(() => clearSessionCaches()).not.toThrow();
  });

  it('is safe to call with nothing registered', async () => {
    const { clearSessionCaches } = await freshModule();
    expect(() => clearSessionCaches()).not.toThrow();
  });

  it('clears again on a second sign-out rather than deregistering owners', async () => {
    // Owners register once at module load, so a second session on the same page
    // load has to be cleared by the same registration.
    const { registerSessionCache, clearSessionCaches } = await freshModule();
    const clear = vi.fn();

    registerSessionCache(clear);
    clearSessionCaches();
    clearSessionCaches();

    expect(clear).toHaveBeenCalledTimes(2);
  });

  it('registers a given function once, however many times it is added', async () => {
    const { registerSessionCache, clearSessionCaches } = await freshModule();
    const clear = vi.fn();

    registerSessionCache(clear);
    registerSessionCache(clear);
    clearSessionCaches();

    expect(clear).toHaveBeenCalledTimes(1);
  });
});
