import { useState, useEffect } from 'react';
import { Award, Save, AlertCircle, CheckCircle2, Loader2, TrendingUp, Eye, RefreshCw, Plus, Trash2 } from 'lucide-react';
import { levelsApi } from '../../lib/api/levels';
import { Level, clearLevelsCache } from '../../lib/utils/levels';
import { LevelBadge } from '../../components/common/LevelBadge';

interface LevelFormData extends Level {
  editing?: boolean;
}

export function LevelsManagementPage() {
  const [levels, setLevels] = useState<LevelFormData[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newLevel, setNewLevel] = useState({
    level_number: 0,
    name: '',
    description: '',
    points_required: 0,
    icon_emoji: '⭐',
    color_hex: '#3B82F6',
  });

  useEffect(() => {
    loadLevels();
  }, []);

  const loadLevels = async () => {
    try {
      setLoading(true);
      clearLevelsCache();
      const data = await levelsApi.getAllLevelsForAdmin();
      setLevels(data.map(level => ({ ...level, editing: false })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load levels');
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (levelNumber: number) => {
    setLevels(levels.map(level => ({
      ...level,
      editing: level.level_number === levelNumber ? true : level.editing
    })));
    setError(null);
    setSuccess(null);
  };

  const handleCancel = (_levelNumber: number) => {
    loadLevels();
  };

  const handleSave = async (level: LevelFormData) => {
    try {
      setSaving(level.level_number);
      setError(null);
      setSuccess(null);

      await levelsApi.updateLevel(
        level.level_number,
        level.name,
        level.description,
        level.points_required,
        level.icon_emoji,
        level.color_hex
      );

      setSuccess(`Level ${level.level_number} updated successfully`);
      await loadLevels();

      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update level');
    } finally {
      setSaving(null);
    }
  };

  const handleChange = (levelNumber: number, field: keyof Level, value: string | number) => {
    setLevels(levels.map(level => {
      if (level.level_number === levelNumber) {
        return { ...level, [field]: value };
      }
      return level;
    }));
  };

  const handleCreateLevel = async () => {
    try {
      setSaving(-1);
      setError(null);
      setSuccess(null);

      await levelsApi.createLevel(
        newLevel.level_number,
        newLevel.name,
        newLevel.description,
        newLevel.points_required,
        newLevel.icon_emoji,
        newLevel.color_hex
      );

      setSuccess(`Level ${newLevel.level_number} created successfully`);
      setShowCreateModal(false);
      setNewLevel({
        level_number: 0,
        name: '',
        description: '',
        points_required: 0,
        icon_emoji: '⭐',
        color_hex: '#3B82F6',
      });
      await loadLevels();

      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create level');
    } finally {
      setSaving(null);
    }
  };

  const handleDeleteLevel = async (levelNumber: number) => {
    if (!confirm(`Are you sure you want to delete Level ${levelNumber}? This cannot be undone.`)) {
      return;
    }

    try {
      setDeleting(levelNumber);
      setError(null);
      setSuccess(null);

      await levelsApi.deleteLevel(levelNumber);

      setSuccess(`Level ${levelNumber} deleted successfully`);
      await loadLevels();

      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete level');
    } finally {
      setDeleting(null);
    }
  };

  const getNextLevelNumber = () => {
    if (levels.length === 0) return 1;
    return Math.max(...levels.map(l => l.level_number)) + 1;
  };

  const openCreateModal = () => {
    setNewLevel({
      ...newLevel,
      level_number: getNextLevelNumber(),
    });
    setShowCreateModal(true);
    setError(null);
    setSuccess(null);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-orbit-canvas flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-iih-green" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3 mb-2">
                <TrendingUp className="w-8 h-8 text-iih-green" />
                Level Management
              </h1>
              <p className="text-slate-600">Configure the levels system and point requirements</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={openCreateModal}
                className="flex items-center gap-2 px-4 py-2 bg-iih-green hover:bg-iih-green-dark text-white font-medium rounded-lg transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add Level
              </button>
              <button
                onClick={() => setShowPreview(!showPreview)}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors"
              >
                <Eye className="w-4 h-4" />
                {showPreview ? 'Hide' : 'Preview'}
              </button>
              <button
                onClick={loadLevels}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                Refresh
              </button>
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-red-800 font-medium">Error</p>
              <p className="text-red-700 text-sm mt-1">{error}</p>
            </div>
          </div>
        )}

        {success && (
          <div className="mb-6 bg-emerald-50 border border-emerald-200 rounded-lg p-4 flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-emerald-800 font-medium">Success</p>
              <p className="text-emerald-700 text-sm mt-1">{success}</p>
            </div>
          </div>
        )}

        <div className="bg-sky-50 border border-sky-200 rounded-lg p-4 mb-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-sky-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1 text-sm text-sky-800">
              <p className="font-medium mb-1">Important Notes:</p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>Points required must increase with each level</li>
                <li>Level 1 should always start at 0 points</li>
                <li>Updating levels will recalculate all user levels automatically</li>
                <li>Level 3 (Event Orbit) is only available to members of the designated Event Stream</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {levels.map((level) => (
            <div
              key={level.id}
              className="bg-white rounded-xl shadow-sm p-6 border-2 border-transparent hover:border-slate-200 transition-all"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div
                    className="w-12 h-12 rounded-full flex items-center justify-center text-2xl"
                    style={{ backgroundColor: `${level.color_hex}20` }}
                  >
                    {level.editing ? (
                      <input
                        type="text"
                        value={level.icon_emoji}
                        onChange={(e) => handleChange(level.level_number, 'icon_emoji', e.target.value)}
                        aria-label={`Level ${level.level_number} icon emoji`}
                        className="w-10 h-10 text-center text-2xl bg-transparent border-0 focus:outline-none"
                        maxLength={2}
                      />
                    ) : (
                      level.icon_emoji
                    )}
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-slate-800">
                      Level {level.level_number}
                    </h3>
                    <p className="text-sm text-slate-500">ID: {level.id}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {!level.editing && (
                    <button
                      onClick={() => handleDeleteLevel(level.level_number)}
                      disabled={deleting === level.level_number}
                      className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                      title="Delete level"
                      aria-label={`Delete level ${level.level_number}`}
                    >
                      {deleting === level.level_number ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  )}
                  {level.editing ? (
                    <>
                      <button
                        onClick={() => handleCancel(level.level_number)}
                        disabled={saving === level.level_number}
                        className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleSave(level)}
                        disabled={saving === level.level_number}
                        className="bg-iih-green hover:bg-iih-green-dark text-white font-medium px-4 py-2 rounded-lg flex items-center gap-2 transition-colors disabled:opacity-50"
                      >
                        {saving === level.level_number ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Saving...
                          </>
                        ) : (
                          <>
                            <Save className="w-4 h-4" />
                            Save
                          </>
                        )}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => handleEdit(level.level_number)}
                      className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium px-4 py-2 rounded-lg transition-colors"
                    >
                      Edit
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor={level.editing ? `level-${level.level_number}-name` : undefined}
                    className="block text-sm font-medium text-slate-700 mb-1"
                  >
                    Level Name
                  </label>
                  {level.editing ? (
                    <input
                      id={`level-${level.level_number}-name`}
                      type="text"
                      value={level.name}
                      onChange={(e) => handleChange(level.level_number, 'name', e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-iih-green"
                    />
                  ) : (
                    <p className="text-slate-900 font-medium">{level.name}</p>
                  )}
                </div>

                <div>
                  <label
                    htmlFor={level.editing ? `level-${level.level_number}-points` : undefined}
                    className="block text-sm font-medium text-slate-700 mb-1"
                  >
                    Points Required
                  </label>
                  {level.editing ? (
                    <input
                      id={`level-${level.level_number}-points`}
                      type="number"
                      value={level.points_required}
                      onChange={(e) => handleChange(level.level_number, 'points_required', parseInt(e.target.value) || 0)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-iih-green"
                      min="0"
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <Award className="w-5 h-5 text-emerald-600" />
                      <p className="text-slate-900 font-bold text-lg">{level.points_required}</p>
                    </div>
                  )}
                </div>

                <div className="md:col-span-2">
                  <label
                    htmlFor={level.editing ? `level-${level.level_number}-description` : undefined}
                    className="block text-sm font-medium text-slate-700 mb-1"
                  >
                    Description
                  </label>
                  {level.editing ? (
                    <textarea
                      id={`level-${level.level_number}-description`}
                      value={level.description}
                      onChange={(e) => handleChange(level.level_number, 'description', e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-iih-green"
                      rows={2}
                    />
                  ) : (
                    <p className="text-slate-700">{level.description}</p>
                  )}
                </div>

                <div>
                  <label
                    htmlFor={level.editing ? `level-${level.level_number}-color-hex` : undefined}
                    className="block text-sm font-medium text-slate-700 mb-1"
                  >
                    Color Hex Code
                  </label>
                  {level.editing ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={level.color_hex}
                        onChange={(e) => handleChange(level.level_number, 'color_hex', e.target.value)}
                        aria-label={`Level ${level.level_number} color picker`}
                        className="w-12 h-10 rounded border border-slate-300 cursor-pointer"
                      />
                      <input
                        id={`level-${level.level_number}-color-hex`}
                        type="text"
                        value={level.color_hex}
                        onChange={(e) => handleChange(level.level_number, 'color_hex', e.target.value)}
                        className="flex-1 px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-iih-green"
                        placeholder="#000000"
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div
                        className="w-8 h-8 rounded border border-slate-300"
                        style={{ backgroundColor: level.color_hex }}
                      />
                      <p className="text-slate-700 font-mono">{level.color_hex}</p>
                    </div>
                  )}
                </div>
              </div>

              {level.level_number === 3 && (
                <div className="mt-4 bg-purple-50 border border-purple-200 rounded-lg p-3">
                  <p className="text-sm text-purple-800">
                    <span className="font-semibold">Special Level:</span> This level is only available to members of the designated Event Stream. Configure the Event Stream in Settings.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>

        {showPreview && (
          <div className="mt-8 bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
              <Eye className="w-5 h-5 text-iih-green" />
              Level Badge Preview
            </h2>
            <p className="text-slate-600 text-sm mb-6">
              Preview how the levels will appear throughout the app
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {levels.map((level) => (
                <div key={level.level_number} className="border border-slate-200 rounded-lg p-4 bg-slate-50">
                  <h3 className="text-sm font-medium text-slate-700 mb-3">Level {level.level_number}</h3>
                  <div className="space-y-4">
                    <div>
                      <p className="text-xs text-slate-500 mb-2">Small Badge:</p>
                      <LevelBadge level={level.level_number} size="sm" />
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 mb-2">Medium Badge:</p>
                      <LevelBadge level={level.level_number} size="md" />
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 mb-2">Large Badge:</p>
                      <LevelBadge level={level.level_number} size="lg" />
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 mb-2">With Progress (example: {level.points_required + 50} points):</p>
                      <LevelBadge
                        level={level.level_number}
                        points={level.points_required + 50}
                        showProgress={true}
                        size="md"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-8 bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-bold text-slate-800 mb-3">Current Level Distribution</h2>
          <p className="text-slate-600 text-sm">
            View how users are distributed across levels from the Dashboard page.
          </p>
        </div>
      </div>

      {showCreateModal && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-level-modal-title"
        >
          <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-slate-200">
              <h2 id="create-level-modal-title" className="text-2xl font-bold text-slate-800">Create New Level</h2>
              <p className="text-slate-600 text-sm mt-1">Add a new level to the progression system</p>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="create-level-number" className="block text-sm font-medium text-slate-700 mb-1">
                    Level Number <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="create-level-number"
                    type="number"
                    value={newLevel.level_number}
                    onChange={(e) => setNewLevel({ ...newLevel, level_number: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-iih-green"
                    min="1"
                  />
                </div>

                <div>
                  <label htmlFor="create-level-points" className="block text-sm font-medium text-slate-700 mb-1">
                    Points Required <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="create-level-points"
                    type="number"
                    value={newLevel.points_required}
                    onChange={(e) => setNewLevel({ ...newLevel, points_required: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-iih-green"
                    min="0"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="create-level-name" className="block text-sm font-medium text-slate-700 mb-1">
                  Level Name <span className="text-red-500">*</span>
                </label>
                <input
                  id="create-level-name"
                  type="text"
                  value={newLevel.name}
                  onChange={(e) => setNewLevel({ ...newLevel, name: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-iih-green"
                  placeholder="e.g., Orbit Master"
                />
              </div>

              <div>
                <label htmlFor="create-level-description" className="block text-sm font-medium text-slate-700 mb-1">
                  Description <span className="text-red-500">*</span>
                </label>
                <textarea
                  id="create-level-description"
                  value={newLevel.description}
                  onChange={(e) => setNewLevel({ ...newLevel, description: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-iih-green"
                  rows={3}
                  placeholder="Describe what this level represents..."
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="create-level-emoji" className="block text-sm font-medium text-slate-700 mb-1">
                    Icon Emoji <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="create-level-emoji"
                    type="text"
                    value={newLevel.icon_emoji}
                    onChange={(e) => setNewLevel({ ...newLevel, icon_emoji: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-iih-green text-2xl text-center"
                    maxLength={2}
                  />
                </div>

                <div>
                  <label htmlFor="create-level-color-hex" className="block text-sm font-medium text-slate-700 mb-1">
                    Color <span className="text-red-500">*</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={newLevel.color_hex}
                      onChange={(e) => setNewLevel({ ...newLevel, color_hex: e.target.value })}
                      aria-label="New level color picker"
                      className="w-12 h-10 rounded border border-slate-300 cursor-pointer"
                    />
                    <input
                      id="create-level-color-hex"
                      type="text"
                      value={newLevel.color_hex}
                      onChange={(e) => setNewLevel({ ...newLevel, color_hex: e.target.value })}
                      className="flex-1 px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-iih-green"
                      placeholder="#000000"
                    />
                  </div>
                </div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                <h3 className="text-sm font-medium text-slate-700 mb-2">Preview:</h3>
                <div className="flex items-center gap-3">
                  <div
                    className="w-12 h-12 rounded-full flex items-center justify-center text-2xl"
                    style={{ backgroundColor: `${newLevel.color_hex}20` }}
                  >
                    {newLevel.icon_emoji}
                  </div>
                  <div>
                    <p className="font-bold text-slate-800">Level {newLevel.level_number} - {newLevel.name}</p>
                    <p className="text-sm text-slate-600">{newLevel.points_required} points required</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-6 border-t border-slate-200 flex items-center justify-end gap-3">
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  setNewLevel({
                    level_number: 0,
                    name: '',
                    description: '',
                    points_required: 0,
                    icon_emoji: '⭐',
                    color_hex: '#3B82F6',
                  });
                }}
                disabled={saving === -1}
                className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateLevel}
                disabled={
                  saving === -1 ||
                  !newLevel.name ||
                  !newLevel.description ||
                  newLevel.level_number <= 0
                }
                className="bg-iih-green hover:bg-iih-green-dark text-white font-medium px-4 py-2 rounded-lg flex items-center gap-2 transition-colors disabled:opacity-50"
              >
                {saving === -1 ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4" />
                    Create Level
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
