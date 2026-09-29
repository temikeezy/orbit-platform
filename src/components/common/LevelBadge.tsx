import { useState, useEffect } from 'react';
import { levelUtils, Level } from '../../lib/utils/levels';

interface LevelBadgeProps {
  level: number;
  points?: number;
  showProgress?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function LevelBadge({
  level,
  points,
  showProgress = false,
  size = 'md',
  className = ''
}: LevelBadgeProps) {
  const [levelData, setLevelData] = useState<Level | null>(null);
  const [progress, setProgress] = useState<{
    percentage: number;
    pointsInLevel: number;
    pointsToNext: number;
    nextLevelPoints: number;
  } | null>(null);
  const [nextLevelName, setNextLevelName] = useState<string>('');

  useEffect(() => {
    const loadLevelData = async () => {
      const data = await levelUtils.getLevel(level);
      setLevelData(data || null);

      if (showProgress && points !== undefined) {
        const prog = await levelUtils.calculateProgress(points, level);
        setProgress(prog);

        const levels = await levelUtils.getAllLevels();
        const maxLevel = Math.max(...levels.map(l => l.level_number));
        if (level < maxLevel) {
          const nextName = await levelUtils.getLevelName(level + 1);
          setNextLevelName(nextName);
        }
      }
    };
    loadLevelData();
  }, [level, points, showProgress]);

  if (!levelData) {
    return (
      <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-200 text-slate-600 ${className}`}>
        <span>Loading...</span>
      </div>
    );
  }

  const emoji = levelData.icon_emoji;
  const name = levelData.name;
  const color = levelData.color_hex;
  const description = levelData.description;

  const sizeClasses = {
    sm: 'text-xs px-2 py-1',
    md: 'text-sm px-3 py-1.5',
    lg: 'text-base px-4 py-2',
  };

  const emojiSizes = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-xl',
  };

  if (showProgress && points !== undefined && progress) {
    return (
      <div className={`${className}`}>
        <div
          className={`inline-flex items-center gap-2 ${sizeClasses[size]} rounded-full font-bold shadow-sm border-2`}
          style={{
            backgroundColor: `${color}20`,
            borderColor: color,
            color: color
          }}
        >
          <span className={emojiSizes[size]}>{emoji}</span>
          <span>{name}</span>
        </div>
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-slate-600 mb-1">
            <span className="font-medium">{description}</span>
            <span className="font-bold">{progress.percentage}%</span>
          </div>
          <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${progress.percentage}%`,
                backgroundColor: color
              }}
            />
          </div>
          {nextLevelName && (
            <div className="text-xs text-slate-500 mt-2">
              {progress.pointsToNext} points to {nextLevelName}
            </div>
          )}
          {!nextLevelName && (
            <div className="text-xs font-medium mt-2" style={{ color: color }}>
              Maximum level reached!
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`inline-flex items-center gap-2 ${sizeClasses[size]} rounded-full font-bold shadow-sm border-2 ${className}`}
      style={{
        backgroundColor: `${color}20`,
        borderColor: color,
        color: color
      }}
      title={description}
    >
      <span className={emojiSizes[size]}>{emoji}</span>
      <span>{name}</span>
    </div>
  );
}
