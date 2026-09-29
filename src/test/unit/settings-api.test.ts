import { describe, it, expect, vi, beforeEach } from 'vitest';
import { convexMock } from '../mocks/convex';
import { settingsApi } from '../../lib/api/settings';
import { mockAdminUser, seedLocalStorage } from '../fixtures';

/**
 * The cache is the whole reason this module has tests — SettingsPage reloads
 * the full list after every save and on every tab change, so a cache that never
 * hits, or one that never expires, is the difference between one call and a
 * dozen.
 *
 * The `getSettingByKey` tests are gone with the function. It, `createSetting`,
 * `getSettingsByCategory`, `getSiteName`, `getSiteTitle`, `getSiteLogo`,
 * `updateSiteBranding` and `getMaxStreamsPerIntern` had no callers anywhere in
 * the app; porting them would have meant writing server functions to serve code
 * nothing runs.
 */

const convexSetting = {
  key: 'site_name',
  value: { value: 'ORBIT' },
  category: 'general',
  description: 'The platform name',
  updatedAt: 1_700_000_000_000,
};

beforeEach(() => {
  localStorage.clear();
  convexMock.reset();
  vi.clearAllMocks();
  settingsApi.clearCache();
});

describe('settingsApi', () => {
  describe('getAllSettings() — caching', () => {
    it('fetches on the first call', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');
      let calls = 0;
      convexMock.onQuery('adminSettings.list', () => {
        calls++;
        return [convexSetting];
      });

      await settingsApi.getAllSettings();
      expect(calls).toBe(1);
    });

    it('serves the second call from cache', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');
      let calls = 0;
      convexMock.onQuery('adminSettings.list', () => {
        calls++;
        return [convexSetting];
      });

      await settingsApi.getAllSettings();
      await settingsApi.getAllSettings();
      expect(calls).toBe(1);
    });

    it('re-fetches once the cache is cleared', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');
      let calls = 0;
      convexMock.onQuery('adminSettings.list', () => {
        calls++;
        return [convexSetting];
      });

      await settingsApi.getAllSettings();
      settingsApi.clearCache();
      await settingsApi.getAllSettings();
      expect(calls).toBe(2);
    });

    it('maps a setting into the snake_case shape the page renders', async () => {
      seedLocalStorage(mockAdminUser, 'admin-tok');
      convexMock.onQuery('adminSettings.list', () => [convexSetting]);

      const [setting] = await settingsApi.getAllSettings();

      expect(setting.setting_key).toBe('site_name');
      expect(setting.category).toBe('general');
      expect(setting.setting_value).toEqual({ value: 'ORBIT' });
      // The key IS the identity: adminSettings is keyed on it and the page
      // addresses every setting by name. The row id was never used.
      expect(setting.id).toBe('site_name');
      expect(setting.updated_at).toBe(new Date(1_700_000_000_000).toISOString());
    });
  });

  describe('updateSetting()', () => {
    it('sends the key and value, and clears the cache', async () => {
      seedLocalStorage(mockAdminUser, 'tok');

      let calls = 0;
      convexMock.onQuery('adminSettings.list', () => {
        calls++;
        return [{ ...convexSetting, value: { value: 'New Name' } }];
      });

      let received: Record<string, unknown> = {};
      convexMock.onMutation('adminSettings.set', (args) => {
        received = args;
        return { success: true, previous: { value: 'ORBIT' } };
      });

      await settingsApi.getAllSettings();
      expect(calls).toBe(1);

      await settingsApi.updateSetting('site_name', { setting_value: { value: 'New Name' } });

      expect(received.key).toBe('site_name');
      expect(received.value).toEqual({ value: 'New Name' });
      // The re-read after the write is itself a cache miss, so this proves the
      // cache was invalidated rather than serving the pre-update copy back.
      expect(calls).toBe(2);
    });

    it('throws when the key does not exist', async () => {
      seedLocalStorage(mockAdminUser, 'tok');
      convexMock.onMutation('adminSettings.set', () => ({
        success: false,
        error: 'No such setting: typo_key',
      }));

      // The RPC ran `.update().eq('setting_key', k)`, which matched zero rows
      // and returned no error — so a typo reported "Settings saved
      // successfully" and did nothing.
      await expect(
        settingsApi.updateSetting('typo_key', { setting_value: 'x' }),
      ).rejects.toThrow('No such setting: typo_key');
    });
  });

  describe('sendEmail()', () => {
    it('addresses a USER by id, not an arbitrary address', async () => {
      seedLocalStorage(mockAdminUser, 'tok');

      let received: Record<string, unknown> = {};
      convexMock.onMutation('emailQueue.adminEnqueue', (args) => {
        received = args;
        return { success: true, id: 'email-1' };
      });

      await settingsApi.sendEmail(mockAdminUser.email, 'Test', '<h1>Test</h1>', 'Test');

      // It used to POST to a Supabase edge function with the ANON KEY as the
      // Authorization header and an arbitrary `to` — anyone who read the bundle
      // could send mail from the platform's address to anyone.
      expect(received.userId).toBe(mockAdminUser.id);
      expect(received).not.toHaveProperty('to');
      expect(received.subject).toBe('Test');
    });

    it('refuses to send to anyone but the caller', async () => {
      seedLocalStorage(mockAdminUser, 'tok');

      await expect(
        settingsApi.sendEmail('victim@elsewhere.test', 'Test', '<p>hi</p>'),
      ).rejects.toThrow(/your own address/i);
    });

    it('derives a plain-text body from the html when none is given', async () => {
      seedLocalStorage(mockAdminUser, 'tok');

      let received: Record<string, unknown> = {};
      convexMock.onMutation('emailQueue.adminEnqueue', (args) => {
        received = args;
        return { success: true, id: 'email-1' };
      });

      await settingsApi.sendEmail(mockAdminUser.email, 'Test', '<h1>Hello</h1><p>World</p>');

      // adminEnqueue requires a non-empty bodyText and would refuse otherwise.
      expect(received.bodyText).toBe('Hello  World');
    });
  });
});
