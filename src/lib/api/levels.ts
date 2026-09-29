import { convexHttp as convex } from '../convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../auth';
import { Level, LevelInfo, clearLevelsCache } from '../utils/levels';
import { toLevel, toLevelInfo, ConvexLevel, ConvexLevelInfo } from '../convexAdapters';

/**
 * Levels, on Convex.
 *
 * The public signatures are unchanged, so no call site moves. Two things behind
 * them did:
 *
 *  - the ladder's ORDERING is now enforced by the server. It used to be checked
 *    here, in this module, before calling — so anything that was not this exact
 *    form could write a level requiring fewer points than the one below it, and
 *    `levelForPoints` would then skip a level for some totals and not others.
 *  - `updateLevel` and `deleteLevel` take a level NUMBER, which is what the admin
 *    UI has; Convex takes a document id. The lookup happens here rather than
 *    changing the callers.
 */

function requireToken(): string {
  const token = authService.getToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}

async function idForLevelNumber(levelNumber: number): Promise<string> {
  const levels = (await convex.query(api.levels.list, {})) as ConvexLevel[];
  const match = levels.find((l) => l.levelNumber === levelNumber);
  if (!match) throw new Error(`No level ${levelNumber}`);
  return match.id;
}

export const levelsApi = {
  async getAllLevels(): Promise<Level[]> {
    const levels = (await convex.query(api.levels.list, {})) as ConvexLevel[];
    return levels.map(toLevel);
  },

  async getLevelInfo(points: number): Promise<LevelInfo | null> {
    const info = (await convex.query(api.levels.infoForPoints, { points })) as ConvexLevelInfo | null;
    return info ? toLevelInfo(info) : null;
  },

  async getLevelByNumber(levelNumber: number): Promise<Level | null> {
    const levels = await this.getAllLevels();
    return levels.find((l) => l.level_number === levelNumber) ?? null;
  },

  async getAllLevelsForAdmin(): Promise<Level[]> {
    const levels = (await convex.query(api.levels.listForAdmin, {
      token: requireToken(),
    })) as ConvexLevel[];
    return levels.map(toLevel);
  },

  async updateLevel(
    levelNumber: number,
    name: string,
    description: string,
    pointsRequired: number,
    iconEmoji: string,
    colorHex: string,
  ): Promise<void> {
    const result = await convex.mutation(api.levels.update, {
      token: requireToken(),
      id: (await idForLevelNumber(levelNumber)) as never,
      name,
      description,
      pointsRequired,
      iconEmoji,
      colorHex,
    });

    if (!result.success) throw new Error(result.error);
    clearLevelsCache();
  },

  async createLevel(
    levelNumber: number,
    name: string,
    description: string,
    pointsRequired: number,
    iconEmoji: string,
    colorHex: string,
  ): Promise<void> {
    const result = await convex.mutation(api.levels.create, {
      token: requireToken(),
      levelNumber,
      name,
      description,
      pointsRequired,
      iconEmoji,
      colorHex,
    });

    if (!result.success) throw new Error(result.error);
    clearLevelsCache();
  },

  async deleteLevel(levelNumber: number): Promise<void> {
    const result = await convex.mutation(api.levels.remove, {
      token: requireToken(),
      id: (await idForLevelNumber(levelNumber)) as never,
    });

    if (!result.success) throw new Error(result.error);
    clearLevelsCache();
  },
};
