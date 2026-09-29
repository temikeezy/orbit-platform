import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted — define mock data inside factory using literal values
vi.mock('../../lib/api/levels', () => ({
  levelsApi: {
    getAllLevels: vi.fn().mockResolvedValue([
      { id: '1', level_number: 1, name: 'Beginner', description: 'Start here', points_required: 0, icon_emoji: '🌱', color_hex: '#10B981' },
      { id: '2', level_number: 2, name: 'Explorer', description: 'Keep going', points_required: 100, icon_emoji: '🔭', color_hex: '#3B82F6' },
      { id: '3', level_number: 3, name: 'Expert', description: 'Almost there', points_required: 300, icon_emoji: '⭐', color_hex: '#F59E0B' },
    ]),
  },
}));

import { clearLevelsCache, levelUtils } from '../../lib/utils/levels';

beforeEach(() => {
  clearLevelsCache();
  vi.clearAllMocks();
});

describe('levelUtils', () => {

  describe('cache behavior', () => {
    it('fetches levels on first call', async () => {
      const { levelsApi } = await import('../../lib/api/levels');
      await levelUtils.getAllLevels();
      expect(levelsApi.getAllLevels).toHaveBeenCalledTimes(1);
    });

    it('uses cache on second call (same TTL window)', async () => {
      const { levelsApi } = await import('../../lib/api/levels');
      await levelUtils.getAllLevels();
      await levelUtils.getAllLevels();
      expect(levelsApi.getAllLevels).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after clearLevelsCache()', async () => {
      const { levelsApi } = await import('../../lib/api/levels');
      await levelUtils.getAllLevels();
      clearLevelsCache();
      await levelUtils.getAllLevels();
      expect(levelsApi.getAllLevels).toHaveBeenCalledTimes(2);
    });
  });

  describe('calculateProgress()', () => {
    it('returns 0% at start of level 1', async () => {
      const result = await levelUtils.calculateProgress(0, 1);
      expect(result.percentage).toBe(0);
      expect(result.pointsToNext).toBe(100);
    });

    it('returns 50% when halfway through level range', async () => {
      const result = await levelUtils.calculateProgress(50, 1);
      expect(result.percentage).toBe(50);
    });

    it('returns 100% at max level', async () => {
      const result = await levelUtils.calculateProgress(400, 3);
      expect(result.percentage).toBe(100);
      expect(result.pointsToNext).toBe(0);
    });

    it('returns correct pointsToNext at exact boundary', async () => {
      const result = await levelUtils.calculateProgress(100, 2);
      expect(result.pointsToNext).toBe(200);
      expect(result.percentage).toBe(0);
    });
  });

  describe('getLevel()', () => {
    it('returns the correct level by number', async () => {
      const level = await levelUtils.getLevel(2);
      expect(level?.name).toBe('Explorer');
    });

    it('returns undefined for non-existent level', async () => {
      const level = await levelUtils.getLevel(99);
      expect(level).toBeUndefined();
    });
  });
});
