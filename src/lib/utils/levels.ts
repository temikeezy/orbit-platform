import { levelsApi } from '../api/levels';
import { registerSessionCache } from '../sessionCaches';

export interface Level {
  id?: string;
  level_number: number;
  name: string;
  description: string;
  points_required: number;
  icon_emoji: string;
  color_hex: string;
}

export interface LevelInfo {
  current_level: Level;
  next_level?: {
    level_number: number;
    name: string;
    points_required: number;
    points_needed: number;
  };
  progress_percentage: number;
}

const LEVELS_CACHE_TTL_MS = 5 * 60_000; // 5 minutes
let cachedLevels: Level[] | null = null;
let cacheTimestamp = 0;

async function getLevelsCache(): Promise<Level[]> {
  const now = Date.now();
  if (!cachedLevels || now - cacheTimestamp > LEVELS_CACHE_TTL_MS) {
    cachedLevels = await levelsApi.getAllLevels();
    cacheTimestamp = now;
  }
  return cachedLevels;
}

export function clearLevelsCache(): void {
  cachedLevels = null;
  cacheTimestamp = 0;
}

export const levelUtils = {
  async getLevel(levelNumber: number): Promise<Level | undefined> {
    const levels = await getLevelsCache();
    return levels.find(l => l.level_number === levelNumber);
  },

  async getAllLevels(): Promise<Level[]> {
    return getLevelsCache();
  },

  async getLevelColor(levelNumber: number): Promise<string> {
    const level = await this.getLevel(levelNumber);
    return level?.color_hex || '#10B981';
  },

  async getLevelName(levelNumber: number): Promise<string> {
    const level = await this.getLevel(levelNumber);
    return level?.name || 'Unknown Level';
  },

  async getLevelEmoji(levelNumber: number): Promise<string> {
    const level = await this.getLevel(levelNumber);
    return level?.icon_emoji || '🚀';
  },

  async getPointsForLevel(levelNumber: number): Promise<number> {
    const level = await this.getLevel(levelNumber);
    return level?.points_required || 0;
  },

  async getLevelDescription(levelNumber: number): Promise<string> {
    const level = await this.getLevel(levelNumber);
    return level?.description || '';
  },

  async calculateProgress(currentPoints: number, currentLevel: number): Promise<{
    percentage: number;
    pointsInLevel: number;
    pointsToNext: number;
    nextLevelPoints: number;
  }> {
    const levels = await getLevelsCache();
    const currentLevelData = levels.find(l => l.level_number === currentLevel);
    const nextLevelData = levels.find(l => l.level_number === currentLevel + 1);

    const currentLevelPoints = currentLevelData?.points_required || 0;
    const nextLevelPoints = nextLevelData?.points_required || currentLevelPoints;

    // `Math.max()` of an empty list is -Infinity, which would make every member
    // "max level, 100%" if the ladder ever came back empty.
    const maxLevel = levels.length ? Math.max(...levels.map(l => l.level_number)) : currentLevel;

    if (currentLevel >= maxLevel) {
      return {
        percentage: 100,
        pointsInLevel: currentPoints - currentLevelPoints,
        pointsToNext: 0,
        nextLevelPoints: currentLevelPoints,
      };
    }

    const pointsInLevel = currentPoints - currentLevelPoints;
    const pointsToNext = nextLevelPoints - currentPoints;
    const levelRange = nextLevelPoints - currentLevelPoints;
    // Clamped at BOTH ends. Only the upper bound was here, so a member whose
    // denormalised level sits above their points — which happens for everyone
    // affected the moment an admin raises a threshold, until it recomputes —
    // produced a negative percentage that was fed straight to a progress bar's
    // width. A zero-width range divides to Infinity, so that is caught too.
    const percentage =
      levelRange > 0
        ? Math.max(0, Math.min(100, Math.round((pointsInLevel / levelRange) * 100)))
        : 0;

    return {
      percentage,
      pointsInLevel,
      pointsToNext,
      nextLevelPoints,
    };
  },

  async formatLevelDisplay(level: number): Promise<string> {
    const emoji = await this.getLevelEmoji(level);
    const name = await this.getLevelName(level);
    return `${emoji} Level ${level} - ${name}`;
  },
};

// Dropped on sign-out — see sessionCaches.ts.
registerSessionCache(clearLevelsCache);
