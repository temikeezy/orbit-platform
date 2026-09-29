import { ReactNode } from 'react';

interface EmptyStateProps {
  illustration: ReactNode;
  title: string;
  description: string;
  cta?: {
    label: string;
    onClick: () => void;
  };
  secondaryCta?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
  children?: ReactNode;
}

export function EmptyState({
  illustration,
  title,
  description,
  cta,
  secondaryCta,
  className = '',
  children,
}: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center py-16 px-6 text-center ${className}`}>
      <div
        className="mb-4 flex h-14 w-14 select-none items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-500"
        aria-hidden="true"
      >
        {illustration}
      </div>
      <h3 className="text-xl font-bold text-slate-800 mb-2">{title}</h3>
      <p className="text-slate-500 max-w-sm mb-6">{description}</p>
      {(cta || secondaryCta || children) && (
        <div className="flex flex-wrap items-center justify-center gap-3">
          {cta && (
            <button
              onClick={cta.onClick}
              className="bg-iih-green hover:bg-iih-green-dark text-white px-5 py-2.5 rounded-lg font-medium transition-colors"
            >
              {cta.label}
            </button>
          )}
          {secondaryCta && (
            <button
              onClick={secondaryCta.onClick}
              className="border border-slate-300 hover:border-slate-400 text-slate-700 px-5 py-2.5 rounded-lg font-medium transition-colors"
            >
              {secondaryCta.label}
            </button>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
