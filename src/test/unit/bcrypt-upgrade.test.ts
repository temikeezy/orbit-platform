import { describe, it, expect } from 'vitest';
import { BCRYPT_COST_TO_UPGRADE } from '../../../convex/auth';

/**
 * Sign-in rehashes a password whose stored cost is below what ORBIT writes
 * today. Getting the range wrong is quiet in both directions: too narrow and the
 * inherited cost-6 hashes never migrate, too wide and every login rewrites the
 * user row forever — an extra write on the hottest mutation in the system,
 * visible only as unexplained contention.
 *
 * Eight of the nine password hashes in production were cost 6 when this landed.
 */
describe('BCRYPT_COST_TO_UPGRADE', () => {
  it('matches the pgcrypto-era hashes that need upgrading', () => {
    // What crypt(..., gen_salt('bf')) produced, and what was imported verbatim.
    expect(BCRYPT_COST_TO_UPGRADE.test('$2a$06$abcdefghijklmnopqrstuv')).toBe(true);
    expect(BCRYPT_COST_TO_UPGRADE.test('$2b$08$abcdefghijklmnopqrstuv')).toBe(true);
    expect(BCRYPT_COST_TO_UPGRADE.test('$2y$04$abcdefghijklmnopqrstuv')).toBe(true);
  });

  it('does NOT match the cost ORBIT writes, or anything stronger', () => {
    // The important half. A regex written as "not 10" would rehash a cost-12
    // password on every sign-in, forever.
    expect(BCRYPT_COST_TO_UPGRADE.test('$2b$10$abcdefghijklmnopqrstuv')).toBe(false);
    expect(BCRYPT_COST_TO_UPGRADE.test('$2b$12$abcdefghijklmnopqrstuv')).toBe(false);
    expect(BCRYPT_COST_TO_UPGRADE.test('$2b$14$abcdefghijklmnopqrstuv')).toBe(false);
  });

  it('does not match a non-bcrypt or malformed hash', () => {
    expect(BCRYPT_COST_TO_UPGRADE.test('not-a-hash')).toBe(false);
    expect(BCRYPT_COST_TO_UPGRADE.test('$1$06$abcdefgh')).toBe(false);
    expect(BCRYPT_COST_TO_UPGRADE.test('')).toBe(false);
  });
});
