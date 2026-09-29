import { ORG_COPYRIGHT_NAME, ORG_SHORT_NAME, ORG_URL } from '../../config/org';

export function Footer() {
  return (
    <footer className="bg-white border-t border-slate-200 mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="text-slate-600 text-sm">
            &copy; {new Date().getFullYear()} Orbit by {ORG_COPYRIGHT_NAME}. All rights reserved.
          </div>
          <div className="flex items-center gap-6">
            <a
              href={ORG_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-slate-600 hover:text-iih-green transition-colors"
            >
              Visit {ORG_SHORT_NAME} Website
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
