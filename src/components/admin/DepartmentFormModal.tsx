import { useState, FormEvent } from 'react';
import { Loader2, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { departmentsApi } from '../../lib/api/departments';
import { OrbitDepartment, OrbitUser } from '../../types/database';

interface DepartmentFormModalProps {
  department?: OrbitDepartment | null;
  users: OrbitUser[];
  onClose: () => void;
  onSaved: () => void;
}

const INPUT_CLS =
  'w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent';

export function DepartmentFormModal({
  department,
  users,
  onClose,
  onSaved,
}: DepartmentFormModalProps) {
  const isEditing = Boolean(department?.id);

  const [name, setName] = useState(department?.name ?? '');
  const [description, setDescription] = useState(department?.description ?? '');
  const [leadUserId, setLeadUserId] = useState<string>(department?.lead_user_id ?? '');
  const [isActive, setIsActive] = useState(department?.is_active ?? true);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Department name is required');
      return;
    }
    setSaving(true);
    try {
      await departmentsApi.saveDepartment({
        id: department?.id,
        name: name.trim(),
        description: description.trim() || undefined,
        lead_user_id: leadUserId || null,
        is_active: isActive,
      });
      toast.success(isEditing ? 'Department updated' : 'Department created');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="department-modal-title"
    >
      <div className="bg-white rounded-lg max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 id="department-modal-title" className="text-xl font-bold text-slate-800">
            {isEditing ? 'Edit Department' : 'New Department'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="department-form-name" className="block text-sm font-medium text-slate-700 mb-1">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              id="department-form-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g., Engineering"
              className={INPUT_CLS}
            />
          </div>

          <div>
            <label htmlFor="department-form-description" className="block text-sm font-medium text-slate-700 mb-1">Description</label>
            <textarea
              id="department-form-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Optional department description"
              className={INPUT_CLS}
            />
          </div>

          <div>
            <label htmlFor="department-form-lead" className="block text-sm font-medium text-slate-700 mb-1">Department Lead</label>
            <select
              id="department-form-lead"
              value={leadUserId}
              onChange={(e) => setLeadUserId(e.target.value)}
              className={INPUT_CLS}
            >
              <option value="">None</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="w-4 h-4 text-iih-green rounded focus:ring-2 focus:ring-iih-green"
            />
            <span className="text-sm text-slate-700">Department is active</span>
          </label>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-lg font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {isEditing ? 'Save Changes' : 'Create Department'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
