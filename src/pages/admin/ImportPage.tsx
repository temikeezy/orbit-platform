import { useState } from 'react';
import { Upload, UserPlus, ShieldAlert } from 'lucide-react';
import { SingleUserImport } from '../../components/admin/SingleUserImport';
import { BulkImportModal } from '../../components/admin/BulkImportModal';
import { authService } from '../../lib/auth';

type ImportMode = 'single' | 'bulk';

export function ImportPage() {
  const [importMode, setImportMode] = useState<ImportMode>('single');
  const [showBulkImport, setShowBulkImport] = useState(false);

  /**
   * Both import paths end at `users.adminCreateUser`, which is SUPER ADMIN
   * ONLY — an admin who could create users could manufacture peer admins.
   *
   * The screen did not know that. A plain admin could open it, pick a file,
   * map the columns, review the preview and press Import, and every single row
   * came back "Only a super admin can create users." Four steps of work to
   * reach a refusal that was knowable at step zero, and on a 500-row file that
   * is a long wait for nothing.
   */
  const canCreateUsers = authService.isSuperAdmin();

  const handleImportComplete = () => {};

  if (!canCreateUsers) {
    return (
      <div className="min-h-screen bg-orbit-canvas">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-8 text-center">
            <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-amber-500" />
            <h1 className="text-xl font-bold text-slate-800">Super admin access required</h1>
            <p className="mx-auto mt-2 max-w-md text-slate-600">
              Creating accounts — one at a time or in bulk — is restricted to super admins.
              Ask one to run the import, or to grant you the role.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
            <Upload className="w-8 h-8 text-iih-green" />
            Import Users
          </h1>
          <p className="text-slate-600 mt-1">
            Add users individually or import multiple users at once
          </p>
        </div>

        <div className="bg-white rounded-xl shadow-sm mb-6">
          <div className="border-b border-slate-200">
            <div className="flex">
              <button
                onClick={() => setImportMode('single')}
                className={`flex-1 px-6 py-4 font-medium transition-colors border-b-2 ${
                  importMode === 'single'
                    ? 'border-green-600 text-green-600'
                    : 'border-transparent text-slate-600 hover:text-slate-800'
                }`}
              >
                <div className="flex items-center justify-center gap-2">
                  <UserPlus className="w-5 h-5" />
                  <span>Single / Multiple Users</span>
                </div>
              </button>
              <button
                onClick={() => setImportMode('bulk')}
                className={`flex-1 px-6 py-4 font-medium transition-colors border-b-2 ${
                  importMode === 'bulk'
                    ? 'border-green-600 text-green-600'
                    : 'border-transparent text-slate-600 hover:text-slate-800'
                }`}
              >
                <div className="flex items-center justify-center gap-2">
                  <Upload className="w-5 h-5" />
                  <span>Bulk Import (CSV/Excel)</span>
                </div>
              </button>
            </div>
          </div>

          <div className="p-6">
            {importMode === 'single' && (
              <SingleUserImport onImportComplete={handleImportComplete} />
            )}

            {importMode === 'bulk' && (
              <div className="text-center py-12">
                <Upload className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <h3 className="text-lg font-bold text-slate-800 mb-2">
                  Bulk Import Users
                </h3>
                <p className="text-slate-600 mb-6 max-w-md mx-auto">
                  Import multiple users at once using a CSV or Excel file. Perfect for
                  adding entire cohorts or teams.
                </p>
                <button
                  onClick={() => setShowBulkImport(true)}
                  className="px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors inline-flex items-center gap-2"
                >
                  <Upload className="w-5 h-5" />
                  Start Bulk Import
                </button>

                <div className="mt-8 bg-slate-50 border border-slate-200 rounded-lg p-6 text-left max-w-2xl mx-auto">
                  <h4 className="font-bold text-slate-800 mb-3">File Requirements:</h4>
                  <ul className="space-y-2 text-sm text-slate-600">
                    <li className="flex items-start gap-2">
                      <span className="text-green-600 mt-0.5">•</span>
                      <span>
                        <strong>Required columns:</strong> email, first_name, last_name
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-green-600 mt-0.5">•</span>
                      <span>
                        <strong>Optional columns:</strong> location, phone
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-green-600 mt-0.5">•</span>
                      <span>
                        <strong>Supported formats:</strong> CSV (.csv) or Excel (.xlsx)
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-green-600 mt-0.5">•</span>
                      <span>
                        <strong>Maximum file size:</strong> 5MB
                      </span>
                    </li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {showBulkImport && (
        <BulkImportModal
          onClose={() => setShowBulkImport(false)}
          onComplete={handleImportComplete}
        />
      )}
    </div>
  );
}
