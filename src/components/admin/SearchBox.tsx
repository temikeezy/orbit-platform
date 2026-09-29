import { Search, X } from 'lucide-react';

interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Shown beside the box once something is typed: "12 of 209". */
  resultCount?: number;
  totalCount?: number;
  className?: string;
}

/**
 * One search box, used by every admin list.
 *
 * Written as a shared component rather than copied per screen because the small
 * things are what make a list usable and they are exactly what gets dropped
 * when each screen rolls its own: something to clear it with, a count that says
 * whether you are looking at everything or a slice, and a placeholder that
 * names the fields it actually matches so nobody has to guess whether a matric
 * number will work.
 */
export function SearchBox({
  value,
  onChange,
  placeholder,
  resultCount,
  totalCount,
  className = '',
}: SearchBoxProps) {
  const showCount =
    value.trim() !== '' && resultCount !== undefined && totalCount !== undefined;

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="w-full rounded-lg border border-slate-300 py-2 pl-10 pr-9 text-sm focus:border-transparent focus:ring-2 focus:ring-iih-green"
        />
        {value && (
          // `type="text"`, not `type="search"`, precisely so this is the only
          // clear control. Chrome draws its own × for a search input, which sat
          // beside this one — two buttons a pixel apart doing the same thing.
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {showCount && (
        <span className="whitespace-nowrap text-sm text-slate-500">
          {resultCount} of {totalCount}
        </span>
      )}
    </div>
  );
}
