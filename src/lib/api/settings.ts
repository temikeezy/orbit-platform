import { convexHttp as convex } from '../convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../auth';
import { OrbitAdminSetting, SettingCategory } from '../../types/database';
import { registerSessionCache } from '../sessionCaches';

/**
 * Admin settings, on Convex.
 *
 * Eight of this module's twelve functions had no callers — `createSetting`,
 * `getSettingByKey`, `getSettingsByCategory`, `getSiteName`, `getSiteTitle`,
 * `getSiteLogo`, `updateSiteBranding` and `getMaxStreamsPerIntern` were dead.
 * They are deleted rather than ported: `createSetting` in particular wrapped an
 * RPC that inserted arbitrary keys, and `adminSettings.set` deliberately refuses
 * to upsert, so porting it would have meant writing a server function that
 * exists only to serve code nothing calls.
 *
 * The one-minute cache stays. SettingsPage reloads the whole list after every
 * save, and the tabs re-read it as the admin moves between them.
 */

export interface UpdateSettingData {
  setting_value: Record<string, unknown> | string | null;
}

const SETTINGS_CACHE_TTL_MS = 60_000;
let _settingsCache: OrbitAdminSetting[] | null = null;
let _settingsCacheAt = 0;

interface ConvexSetting {
  key: string;
  value: unknown;
  category: string;
  description?: string;
  updatedAt: number;
}

function requireToken(): string {
  const token = authService.getToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}

function toSetting(s: ConvexSetting): OrbitAdminSetting {
  return {
    // The key IS the identity — `adminSettings` is keyed on settingKey and the
    // page addresses every setting by name. The row id was never used.
    id: s.key,
    setting_key: s.key,
    setting_value: (s.value ?? {}) as Record<string, unknown>,
    category: s.category as SettingCategory,
    description: s.description,
    created_at: new Date(s.updatedAt).toISOString(),
    updated_at: new Date(s.updatedAt).toISOString(),
  };
}

export const settingsApi = {
  clearCache() {
    _settingsCache = null;
    _settingsCacheAt = 0;
  },

  async getAllSettings(): Promise<OrbitAdminSetting[]> {
    const now = Date.now();
    if (_settingsCache && now - _settingsCacheAt < SETTINGS_CACHE_TTL_MS) {
      return _settingsCache;
    }

    const rows = (await convex.query(api.adminSettings.list, {
      token: requireToken(),
    })) as ConvexSetting[];

    _settingsCache = rows.map(toSetting);
    _settingsCacheAt = now;
    return _settingsCache;
  },

  /**
   * Updates one setting.
   *
   * Updating an unknown key is now an ERROR. The RPC ran
   * `.update().eq('setting_key', k)`, which matched zero rows and returned no
   * error — so a typo reported "Settings saved successfully" and did nothing.
   */
  async updateSetting(
    key: string,
    settingData: UpdateSettingData,
    _updatedBy?: string,
  ): Promise<OrbitAdminSetting> {
    const result = await convex.mutation(api.adminSettings.set, {
      token: requireToken(),
      key,
      value: settingData.setting_value,
    });

    if (!result.success) throw new Error(result.error);

    this.clearCache();

    const updated = (await this.getAllSettings()).find((s) => s.setting_key === key);
    if (!updated) throw new Error(`Setting "${key}" not found after update`);
    return updated;
  },

  /**
   * Sends one email, for the settings page's "send test email" button.
   *
   * It used to POST to a Supabase edge function with the ANON KEY as the
   * Authorization header and an arbitrary `to`, `subject` and `html` in the
   * body — so anyone who read the bundle could send mail from the platform's
   * address to anyone, with any content. `emailQueue.adminEnqueue` is
   * admin-gated and can only address a USER OF THE PLATFORM, resolved from an
   * id, so it cannot be aimed at an arbitrary address at all.
   */
  async sendEmail(to: string, subject: string, html: string, text?: string) {
    const token = requireToken();

    const me = authService.getCurrentUser();
    if (!me) throw new Error('Not authenticated');

    if (to !== me.email) {
      throw new Error('A test email can only be sent to your own address.');
    }

    const result = await convex.mutation(api.emailQueue.adminEnqueue, {
      token,
      userId: me.id as never,
      subject,
      bodyText: text ?? html.replace(/<[^>]+>/g, ' ').trim(),
      bodyHtml: html,
      emailType: 'general',
    });

    if (!result.success) throw new Error(result.error);
    return result;
  },
};

// Dropped on sign-out — see sessionCaches.ts.
registerSessionCache(() => settingsApi.clearCache());
