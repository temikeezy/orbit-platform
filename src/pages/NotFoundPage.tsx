import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';

/**
 * The 404.
 *
 * Without it an unmatched authenticated path rendered the full app chrome —
 * navigation, footer, tab bar — wrapped around an empty white area, which reads
 * as a page that failed to load rather than a URL that does not exist. A
 * mistyped link and a broken deploy looked identical.
 */
export function NotFoundPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-20 text-center">
      <Compass className="w-16 h-16 text-slate-300 mx-auto mb-6" />
      <h1 className="text-3xl font-bold text-slate-800 mb-2">Page not found</h1>
      <p className="text-slate-600 mb-8">
        That link does not lead anywhere in ORBIT. It may have moved, or the address may
        have a typo in it.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          to="/"
          className="bg-iih-green hover:bg-iih-green-dark text-white font-medium py-2 px-6 rounded-lg transition-colors"
        >
          Back to Home
        </Link>
        <Link
          to="/tasks"
          className="bg-white hover:bg-slate-50 border-2 border-slate-200 text-slate-700 font-medium py-2 px-6 rounded-lg transition-colors"
        >
          My Tasks
        </Link>
      </div>
    </div>
  );
}
