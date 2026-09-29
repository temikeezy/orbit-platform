import { useState } from 'react';
import { Plus, X, Mail, User, MapPin, Loader2 } from 'lucide-react';
import { convexHttp as convex } from '../../lib/convex';
import { api } from '../../../convex/_generated/api';
import { authService } from '../../lib/auth';

interface UserFormData {
  email: string;
  full_name: string;
  first_name: string;
  last_name: string;
  location: string;
}

interface SingleUserImportProps {
  onImportComplete?: () => void;
}

export function SingleUserImport({ onImportComplete }: SingleUserImportProps) {
  const [users, setUsers] = useState<UserFormData[]>([
    { email: '', full_name: '', first_name: '', last_name: '', location: '' }
  ]);
  const [importing, setImporting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [successCount, setSuccessCount] = useState(0);
  /**
   * The created accounts' one-time passwords.
   *
   * `adminCreateUser` hashes a random temp password and never stores the
   * plaintext — it comes back on the response once and is then unrecoverable.
   * The comment above `handleImport` has always said so, but the value was
   * dropped rather than shown, which left every imported member with an account
   * whose password nobody knew and no indication anything was missing.
   */
  const [credentials, setCredentials] = useState<{ email: string; password: string }[]>([]);

  const addUserForm = () => {
    setUsers([...users, { email: '', full_name: '', first_name: '', last_name: '', location: '' }]);
  };

  const removeUserForm = (index: number) => {
    if (users.length === 1) return;
    const newUsers = users.filter((_, i) => i !== index);
    setUsers(newUsers);
  };

  const updateUser = (index: number, field: keyof UserFormData, value: string) => {
    const newUsers = [...users];
    newUsers[index][field] = value;

    if (field === 'first_name' || field === 'last_name') {
      const firstName = field === 'first_name' ? value : newUsers[index].first_name;
      const lastName = field === 'last_name' ? value : newUsers[index].last_name;
      newUsers[index].full_name = `${firstName} ${lastName}`.trim();
    }

    setUsers(newUsers);
  };

  const validateUsers = (): boolean => {
    const newErrors: string[] = [];

    users.forEach((user, index) => {
      if (!user.email) {
        newErrors.push(`User ${index + 1}: Email is required`);
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) {
        newErrors.push(`User ${index + 1}: Invalid email format`);
      }

      if (!user.first_name || !user.last_name) {
        newErrors.push(`User ${index + 1}: First name and last name are required`);
      }
    });

    const emails = users.map((u) => u.email.toLowerCase());
    const duplicates = emails.filter((email, index) => emails.indexOf(email) !== index);
    if (duplicates.length > 0) {
      newErrors.push(`Duplicate emails found: ${[...new Set(duplicates)].join(', ')}`);
    }

    setErrors(newErrors);
    return newErrors.length === 0;
  };

  /**
   * Creates the users through the admin mutation, one at a time.
   *
   * It used to POST the whole batch to a Supabase edge function
   * (`/functions/v1/create-users`) with the ANON KEY as its Authorization
   * header — an endpoint that minted user accounts, authenticated by a key
   * shipped in the client bundle. `users.adminCreateUser` is admin-gated
   * against the caller's session and returns the temporary password it
   * generated, so nothing invents one here.
   *
   * Sequential rather than parallel: each create is its own transaction and the
   * partial-success reporting below depends on knowing how far it got.
   */
  const handleImport = async () => {
    if (!validateUsers()) return;

    setImporting(true);
    setErrors([]);
    setSuccessCount(0);

    const failures: string[] = [];
    const issued: { email: string; password: string }[] = [];
    let created = 0;

    try {
      const token = authService.getToken();
      if (!token) throw new Error('Not authenticated');

      for (const u of users) {
        try {
          const result = await convex.mutation(api.users.adminCreateUser, {
            token,
            email: u.email.trim().toLowerCase(),
            fullName:
              u.full_name.trim() || [u.first_name, u.last_name].filter(Boolean).join(' ').trim(),
            roles: ['intern'],
            // Stated, not left to a fallback. An imported intern with no
            // programme carries no logbook, and the enrolment-data guess only
            // rescues them if a matric number happens to come across too.
            programmeType: 'siwes',
          });

          if (!result.success) throw new Error(result.error);
          if (result.tempPassword) {
            issued.push({ email: u.email.trim().toLowerCase(), password: result.tempPassword });
          }
          created++;
        } catch (err) {
          // Named, not counted: "3 of 5 failed" is not something an admin can
          // act on, and the usual cause is one address already existing.
          failures.push(`${u.email}: ${err instanceof Error ? err.message : 'failed'}`);
        }
      }

      setSuccessCount(created);
      setCredentials(issued);
      if (failures.length > 0) setErrors(failures);

      if (created > 0) {
        setUsers([{ email: '', full_name: '', first_name: '', last_name: '', location: '' }]);
        if (onImportComplete) setTimeout(onImportComplete, 1500);
      }
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Failed to import users']);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          Add one or more users by filling out their information. Click the + button to add more users at once.
        </p>
      </div>

      {errors.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <h4 className="font-medium text-red-800 mb-2">Validation Errors:</h4>
          <ul className="list-disc list-inside space-y-1">
            {errors.map((error, index) => (
              <li key={index} className="text-sm text-red-700">
                {error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {successCount > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <p className="text-sm text-green-800 font-medium">
            Successfully imported {successCount} user{successCount > 1 ? 's' : ''}!
          </p>
        </div>
      )}

      {credentials.length > 0 && (
        /**
         * Shown once and never again — see the state declaration. Handing these
         * over is the last step of the import, not an optional extra: without
         * them the member's only way in is a password reset or a magic link.
         */
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-3">
          <div>
            <p className="text-sm font-semibold text-amber-900">
              Copy these temporary passwords now
            </p>
            <p className="text-xs text-amber-700 mt-0.5">
              They are not stored anywhere and cannot be shown again once you leave this page.
            </p>
          </div>
          <ul className="space-y-1.5">
            {credentials.map((c) => (
              <li
                key={c.email}
                className="flex items-center justify-between gap-3 bg-white border border-amber-200 rounded px-3 py-2"
              >
                <span className="text-sm text-slate-700 truncate">{c.email}</span>
                <code className="text-sm font-mono text-slate-900 shrink-0">{c.password}</code>
              </li>
            ))}
          </ul>
          <button
            onClick={() =>
              void navigator.clipboard?.writeText(
                credentials.map((c) => `${c.email}\t${c.password}`).join('\n'),
              )
            }
            className="text-sm font-medium text-amber-800 hover:text-amber-900 underline"
          >
            Copy all
          </button>
        </div>
      )}

      <div className="space-y-4">
        {users.map((user, index) => (
          <div
            key={index}
            className="bg-white border-2 border-slate-200 rounded-lg p-6 relative"
          >
            {users.length > 1 && (
              <button
                onClick={() => removeUserForm(index)}
                className="absolute top-4 right-4 p-1 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                title="Remove this user"
              >
                <X className="w-5 h-5" />
              </button>
            )}

            <h3 className="font-bold text-slate-800 mb-4">User {index + 1}</h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor={`single-import-email-${index}`} className="block text-sm font-medium text-slate-700 mb-2">
                  <Mail className="w-4 h-4 inline mr-1" />
                  Email <span className="text-red-500">*</span>
                </label>
                <input
                  id={`single-import-email-${index}`}
                  type="email"
                  value={user.email}
                  onChange={(e) => updateUser(index, 'email', e.target.value)}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  placeholder="user@example.com"
                  required
                />
              </div>

              <div>
                <label htmlFor={`single-import-first-name-${index}`} className="block text-sm font-medium text-slate-700 mb-2">
                  <User className="w-4 h-4 inline mr-1" />
                  First Name <span className="text-red-500">*</span>
                </label>
                <input
                  id={`single-import-first-name-${index}`}
                  type="text"
                  value={user.first_name}
                  onChange={(e) => updateUser(index, 'first_name', e.target.value)}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  placeholder="John"
                  required
                />
              </div>

              <div>
                <label htmlFor={`single-import-last-name-${index}`} className="block text-sm font-medium text-slate-700 mb-2">
                  <User className="w-4 h-4 inline mr-1" />
                  Last Name <span className="text-red-500">*</span>
                </label>
                <input
                  id={`single-import-last-name-${index}`}
                  type="text"
                  value={user.last_name}
                  onChange={(e) => updateUser(index, 'last_name', e.target.value)}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  placeholder="Doe"
                  required
                />
              </div>

              <div>
                <label htmlFor={`single-import-location-${index}`} className="block text-sm font-medium text-slate-700 mb-2">
                  <MapPin className="w-4 h-4 inline mr-1" />
                  Location (Optional)
                </label>
                <input
                  id={`single-import-location-${index}`}
                  type="text"
                  value={user.location}
                  onChange={(e) => updateUser(index, 'location', e.target.value)}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  placeholder="Lagos, Nigeria"
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <button
          onClick={addUserForm}
          className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors font-medium"
        >
          <Plus className="w-5 h-5" />
          Add Another User
        </button>

        <button
          onClick={handleImport}
          disabled={importing}
          className="flex items-center gap-2 px-6 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {importing ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Importing...
            </>
          ) : (
            <>
              Import {users.length} User{users.length > 1 ? 's' : ''}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
