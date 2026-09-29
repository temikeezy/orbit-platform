import { Database, Terminal, ShieldCheck, Clock } from 'lucide-react';

/**
 * Backups, after the move to Convex.
 *
 * The page this replaces drove a Supabase-specific mechanism end to end: it
 * listed rows from `orbit_backups`, uploaded and deleted pg_dump files in a
 * storage bucket from the BROWSER, and offered a "restore" button that
 * downloaded a dump and handed it back to a Postgres function. All of it backs
 * up the database being decommissioned, so porting it would have produced a
 * working UI that backs up nothing.
 *
 * It was also the worst-authorised surface in the app. `get_backup_list()` was
 * SECURITY DEFINER with EXECUTE granted to anon and took no arguments, so it
 * returned every backup's name and storage path to unauthenticated callers;
 * the delete path removed the storage object from the browser with a
 * caller-supplied path; and the restore path was a client-driven database
 * overwrite.
 *
 * Convex takes snapshots itself and exports them through the CLI, which needs
 * deploy credentials the browser does not and must not hold. There is no
 * honest in-app equivalent, so this page says what to run instead of offering
 * a button that cannot work.
 */

const STEPS = [
  {
    icon: Database,
    title: 'Continuous snapshots',
    body:
      'Convex snapshots the deployment on its own schedule. Nothing needs to be scheduled here, and there is no window in which the most recent write is unprotected.',
  },
  {
    icon: Terminal,
    title: 'Exporting a copy',
    body:
      'Run `npm run convex:export` from a machine with deploy credentials. It writes a ZIP of every table and every stored file, which is what you would hand to an auditor or restore from.',
  },
  {
    icon: ShieldCheck,
    title: 'Why it is not a button',
    body:
      'An export contains every row in the deployment — password hashes, session tokens, magic-link emails. A browser that could trigger one is a browser that could be tricked into triggering one.',
  },
  {
    icon: Clock,
    title: 'Restoring',
    body:
      '`npx convex import --replace` restores an export. It is deliberately a deliberate act: the previous page offered restore as a row action beside delete.',
  },
];

export function BackupManagementPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-3">
          <Database className="w-7 h-7 text-iih-green" />
          Backups
        </h2>
        <p className="text-slate-600 mt-1">
          Handled by the platform rather than by this page.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {STEPS.map(({ icon: Icon, title, body }) => (
          <div key={title} className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <Icon className="w-5 h-5 text-iih-green" />
              <h3 className="font-semibold text-slate-800">{title}</h3>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">{body}</p>
          </div>
        ))}
      </div>

      <div className="bg-slate-900 rounded-xl p-5 font-mono text-sm text-slate-100 overflow-x-auto">
        <div className="text-slate-400 mb-2"># export everything</div>
        <div>npm run convex:export</div>
        <div className="text-slate-400 mt-4 mb-2"># restore an export</div>
        <div>npx convex import --replace snapshot.zip</div>
      </div>
    </div>
  );
}
