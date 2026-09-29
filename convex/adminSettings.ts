import { query, mutation, internalMutation } from './_generated/server';
import { v } from 'convex/values';
import { requireAdmin } from './lib/auth';
import { SECRET_UNCHANGED } from './lib/sentinels';
import { SECRET_FIELDS, maskSecrets, stripSecrets } from './lib/settingSecrets';
import { APPROVAL_WINDOW_SETTING } from './lib/taskApproval';

// Re-exported for the server modules that already import it from here. The
// definition lives in lib/sentinels.ts so the browser can share it without
// importing a module full of queries and mutations.
export { SECRET_UNCHANGED };

/**
 * Admin settings.
 *
 * Replaces the MCP server's `get_admin_settings` / `update_setting`, which read
 * and wrote `orbit_admin_settings` with the service key and no authorization
 * check of any kind — the tools were reachable by anything holding the process's
 * stdio, and `update_setting` accepted an arbitrary key with an arbitrary value.
 *
 * Two behaviour changes, both deliberate:
 *
 *  - Writes are admin-gated and audited.
 *  - Updating an unknown key is an ERROR. `.update().eq('setting_key', k)`
 *    matched zero rows and returned no error, so the tool reported
 *    `Setting "x" updated` for keys that do not exist. An agent tuning a
 *    misremembered key name got a success message and no effect.
 */

export const list = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireAdmin(ctx, token);

    const rows = await ctx.db.query('adminSettings').collect();

    return rows
      .map((s) => ({
        key: s.settingKey,
        value: maskSecrets(s.settingKey, s.settingValue),
        category: s.category,
        description: s.description,
        updatedAt: s.updatedAt,
      }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key));
  },
});

export const get = query({
  args: { token: v.string(), key: v.string() },
  handler: async (ctx, { token, key }) => {
    await requireAdmin(ctx, token);

    const row = await ctx.db
      .query('adminSettings')
      .withIndex('by_key', (q) => q.eq('settingKey', key))
      .unique();

    if (!row) return null;
    return {
      key: row.settingKey,
      value: maskSecrets(row.settingKey, row.settingValue),
      category: row.category,
      description: row.description,
      updatedAt: row.updatedAt,
    };
  },
});

export const set = mutation({
  args: { token: v.string(), key: v.string(), value: v.any() },
  handler: async (ctx, { token, key, value }) => {
    const admin = await requireAdmin(ctx, token);

    const row = await ctx.db
      .query('adminSettings')
      .withIndex('by_key', (q) => q.eq('settingKey', key))
      .unique();

    // No upsert. Every setting the app reads has a category and a description
    // that only a migration supplies; inventing a bare row here produces a
    // setting the UI cannot render and nothing consumes.
    if (!row) {
      return { success: false as const, error: `No such setting: ${key}` };
    }

    const now = Date.now();
    const merged = stripSecrets(key, value);

    await ctx.db.patch(row._id, { settingValue: merged, updatedBy: admin._id, updatedAt: now });

    // The audit row records the MASKED values, not the real ones. A log that
    // stores the credential it is auditing is a credential store — the same
    // reasoning `adminSetPassword` already applies.
    await ctx.db.insert('auditLogs', {
      userId: admin._id,
      userEmail: admin.email,
      userRoles: admin.roles,
      action: 'admin.setting_changed',
      tableName: 'adminSettings',
      recordId: row._id,
      oldValues: { settingValue: maskSecrets(key, row.settingValue) },
      newValues: { settingValue: maskSecrets(key, merged) },
      success: true,
      createdAt: now,
    });

    return { success: true as const, previous: maskSecrets(key, row.settingValue) };
  },
});

/**
 * Seeds the task-approval window row.
 *
 * `set` above deliberately refuses keys it does not already know — a settings
 * row needs a category and a description that only a migration supplies. That
 * is correct, and it also means `task_approval_window_hours` could not be
 * created from the app at all: the row was simply absent on production, so the
 * 48-hour default in lib/taskApproval.ts governed silently and no deliberate
 * choice could be recorded.
 *
 * This is that migration. Idempotent — it will not overwrite a value someone
 * has already chosen. Once the row exists, `set` can change it normally.
 */
export const seedTaskApprovalWindow = internalMutation({
  args: { hours: v.optional(v.number()) },
  handler: async (ctx, { hours }) => {
    const existing = await ctx.db
      .query('adminSettings')
      .withIndex('by_key', (q) => q.eq('settingKey', APPROVAL_WINDOW_SETTING))
      .unique();

    if (existing) {
      return { created: false as const, value: existing.settingValue };
    }

    const now = Date.now();
    await ctx.db.insert('adminSettings', {
      settingKey: APPROVAL_WINDOW_SETTING,
      // Matches the shape every other row here uses, so the settings screen can
      // render it rather than showing a bare value it cannot type.
      settingValue: { enabled: true, value: hours ?? 48 },
      category: 'general',
      description:
        'Hours an agent-drafted task proposal waits before publishing itself. 0 disables auto-publish, so every proposal waits for a human decision.',
      createdAt: now,
      updatedAt: now,
    });

    return { created: true as const, value: { enabled: true, value: hours ?? 48 } };
  },
});

/**
 * Removes stored credential copies from the settings rows.
 *
 * The counterpart to `stripSecrets`: that stops new ones arriving, this clears
 * what is already there. Internal, so it needs deployment credentials rather
 * than an admin session — the same bar as reading the value it deletes.
 *
 * REPORTS FINGERPRINTS, NEVER VALUES. A migration that echoed the secret it
 * was removing into a function log would put it somewhere strictly worse than
 * the row it came from: Convex logs the result of every invocation, and a log
 * drain would carry it off the deployment entirely. The first eight characters
 * of a SHA-256 are enough to confirm afterwards that the thing removed was the
 * thing expected, and are not enough to reconstruct it.
 *
 * Idempotent. A second run reports `removed: 0` because there is nothing left
 * to take.
 */
export const purgeStoredCredentials = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun }) => {
    const cleared: { key: string; field: string; fingerprint: string; length: number }[] = [];

    for (const [key, fields] of Object.entries(SECRET_FIELDS)) {
      const row = await ctx.db
        .query('adminSettings')
        .withIndex('by_key', (q) => q.eq('settingKey', key))
        .unique();
      if (!row) continue;

      const value = row.settingValue;
      if (typeof value !== 'object' || value === null) continue;

      const next = { ...(value as Record<string, unknown>) };
      let touched = false;

      for (const field of fields) {
        const held = next[field];
        if (typeof held !== 'string' || held === '' || held === SECRET_UNCHANGED) continue;

        // Web Crypto, because Convex has no node:crypto in the default runtime.
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(held));
        const fingerprint = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
          .slice(0, 8);

        cleared.push({ key, field, fingerprint, length: held.length });
        delete next[field];
        touched = true;
      }

      if (touched && !dryRun) {
        await ctx.db.patch(row._id, { settingValue: next, updatedAt: Date.now() });
      }
    }

    return { dryRun: Boolean(dryRun), removed: cleared.length, cleared };
  },
});
