import toast from 'react-hot-toast';
import { useState, useEffect } from 'react';
import { badgesApi, Badge } from '../../lib/api/badges';
import { Plus, Edit2, Trash2, Award, Check, X } from 'lucide-react';
import { logError } from '../../lib/monitoring';

export function BadgesManagementPage() {
  const [badges, setBadges] = useState<Badge[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingBadge, setEditingBadge] = useState<Badge | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    criteria_type: 'tasks' as Badge['criteria_type'],
    criteria_value: 0,
    points_bonus: 0,
    icon_url: '',
    is_active: true
  });

  useEffect(() => {
    loadBadges();
  }, []);

  const loadBadges = async () => {
    try {
      const data = await badgesApi.getAllBadgesAdmin();
      setBadges(data);
    } catch (error) {
      logError(error, { context: 'BadgesManagementPage.loadBadges' });
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await badgesApi.createBadge(formData);
      setShowCreateModal(false);
      resetForm();
      loadBadges();
    } catch (error) {
      logError(error, { context: 'BadgesManagementPage.handleCreate' });
      toast.error('Failed to create badge');
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingBadge) return;

    try {
      await badgesApi.updateBadge(editingBadge.id, formData);
      setEditingBadge(null);
      resetForm();
      loadBadges();
    } catch (error) {
      logError(error, { context: 'BadgesManagementPage.handleUpdate' });
      toast.error('Failed to update badge');
    }
  };

  const handleToggleActive = async (badge: Badge) => {
    try {
      await badgesApi.updateBadge(badge.id, { is_active: !badge.is_active });
      loadBadges();
    } catch (error) {
      logError(error, { context: 'BadgesManagementPage.handleToggleActive' });
      toast.error('Failed to update badge status');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this badge? This will also remove it from all users who earned it.')) {
      return;
    }

    try {
      await badgesApi.deleteBadge(id);
      loadBadges();
    } catch (error) {
      logError(error, { context: 'BadgesManagementPage.handleDelete' });
      toast.error('Failed to delete badge');
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      criteria_type: 'tasks',
      criteria_value: 0,
      points_bonus: 0,
      icon_url: '',
      is_active: true
    });
  };

  const openEditModal = (badge: Badge) => {
    setEditingBadge(badge);
    setFormData({
      name: badge.name,
      description: badge.description,
      criteria_type: badge.criteria_type,
      criteria_value: badge.criteria_value,
      points_bonus: badge.points_bonus,
      icon_url: badge.icon_url || '',
      is_active: badge.is_active
    });
  };

  const getBadgeTypeColor = (type: string) => {
    const colors: Record<string, string> = {
      tasks: 'bg-blue-100 text-blue-800',
      streak: 'bg-orange-100 text-orange-800',
      quality: 'bg-yellow-100 text-yellow-800',
      consistency: 'bg-green-100 text-green-800',
      points: 'bg-purple-100 text-purple-800'
    };
    return colors[type] || 'bg-slate-100 text-slate-800';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-slate-600">Loading badges...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
              <Award className="w-8 h-8 text-iih-green" />
              Badges Management
            </h1>
            <p className="text-slate-600 mt-1">Create and manage achievement badges</p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
          >
            <Plus className="w-5 h-5" />
            Create Badge
          </button>
        </div>

        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Badge
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Criteria
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Points
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {badges.map((badge) => (
                  <tr key={badge.id} className="hover:bg-slate-50">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-xl">
                          {badgesApi.getCriteriaIcon(badge.criteria_type)}
                        </div>
                        <div>
                          <div className="font-medium text-slate-900">{badge.name}</div>
                          <div className="text-sm text-slate-500">{badge.description}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getBadgeTypeColor(badge.criteria_type)}`}>
                        {badge.criteria_type}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-900">
                      {badge.criteria_value} {badgesApi.getCriteriaLabel(badge.criteria_type)}
                    </td>
                    <td className="px-6 py-4 text-sm font-medium text-slate-900">
                      +{badge.points_bonus} pts
                    </td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => handleToggleActive(badge)}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                          badge.is_active
                            ? 'bg-green-100 text-green-800 hover:bg-green-200'
                            : 'bg-slate-100 text-slate-800 hover:bg-slate-200'
                        }`}
                      >
                        {badge.is_active ? (
                          <>
                            <Check className="w-3 h-3" />
                            Active
                          </>
                        ) : (
                          <>
                            <X className="w-3 h-3" />
                            Inactive
                          </>
                        )}
                      </button>
                    </td>
                    <td className="px-6 py-4 text-right text-sm font-medium">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => openEditModal(badge)}
                          className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                          title="Edit"
                          aria-label={`Edit badge ${badge.name}`}
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(badge.id)}
                          className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                          title="Delete"
                          aria-label={`Delete badge ${badge.name}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {(showCreateModal || editingBadge) && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50"
          role="dialog"
          aria-modal="true"
          aria-labelledby="badge-modal-title"
        >
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-slate-200">
              <h2 id="badge-modal-title" className="text-2xl font-bold text-slate-800">
                {editingBadge ? 'Edit Badge' : 'Create New Badge'}
              </h2>
            </div>

            <form onSubmit={editingBadge ? handleUpdate : handleCreate} className="p-6 space-y-4">
              <div>
                <label htmlFor="badge-form-name" className="block text-sm font-medium text-slate-700 mb-2">
                  Badge Name
                </label>
                <input
                  id="badge-form-name"
                  type="text"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  placeholder="e.g., Ajebutter Starter"
                />
              </div>

              <div>
                <label htmlFor="badge-form-description" className="block text-sm font-medium text-slate-700 mb-2">
                  Description
                </label>
                <textarea
                  id="badge-form-description"
                  required
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows={3}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  placeholder="e.g., Complete your first 3 tasks - welcome to the hustle!"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="badge-form-criteria-type" className="block text-sm font-medium text-slate-700 mb-2">
                    Criteria Type
                  </label>
                  <select
                    id="badge-form-criteria-type"
                    value={formData.criteria_type}
                    onChange={(e) => setFormData({ ...formData, criteria_type: e.target.value as Badge['criteria_type'] })}
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  >
                    <option value="tasks">Tasks Completed</option>
                    <option value="streak">Consecutive Weeks</option>
                    <option value="quality">High-Quality Submissions</option>
                    <option value="consistency">Helpful Comments</option>
                    <option value="points">Total Points</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="badge-form-criteria-value" className="block text-sm font-medium text-slate-700 mb-2">
                    Criteria Value
                  </label>
                  <input
                    id="badge-form-criteria-value"
                    type="number"
                    required
                    min="1"
                    value={formData.criteria_value}
                    onChange={(e) => setFormData({ ...formData, criteria_value: parseInt(e.target.value) })}
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                    placeholder="e.g., 3"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="badge-form-points-bonus" className="block text-sm font-medium text-slate-700 mb-2">
                  Points Bonus
                </label>
                <input
                  id="badge-form-points-bonus"
                  type="number"
                  required
                  min="0"
                  value={formData.points_bonus}
                  onChange={(e) => setFormData({ ...formData, points_bonus: parseInt(e.target.value) })}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  placeholder="e.g., 25"
                />
              </div>

              <div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={formData.is_active}
                    onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                    className="w-4 h-4 text-green-600 rounded focus:ring-green-500"
                  />
                  <span className="text-sm font-medium text-slate-700">
                    Badge is active (users can earn it)
                  </span>
                </label>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    setEditingBadge(null);
                    resetForm();
                  }}
                  className="px-4 py-2 text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                >
                  {editingBadge ? 'Update Badge' : 'Create Badge'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
