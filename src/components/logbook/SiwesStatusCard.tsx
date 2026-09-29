import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Calendar, User, Building2, Clock } from 'lucide-react';
import { logbookApi } from '../../lib/api/logbook';
import { SiwesMyStatus } from '../../types/database';
import { SkeletonCard } from '../common/SkeletonLoader';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function statusPillClass(status: string): string {
  switch (status) {
    case 'draft':
      return 'bg-slate-100 text-slate-700';
    case 'submitted':
      return 'bg-amber-100 text-amber-700';
    case 'changes_requested':
      return 'bg-red-100 text-red-700';
    case 'approved':
    case 'signed_off':
    case 'active':
      return 'bg-green-100 text-green-700';
    case 'completed':
      return 'bg-blue-100 text-blue-700';
    case 'paused':
      return 'bg-orange-100 text-orange-700';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

export function SiwesStatusCard() {
  const [status, setStatus] = useState<SiwesMyStatus | null | undefined>(undefined);

  useEffect(() => {
    logbookApi
      .getMyStatus()
      .then((data) => setStatus(data))
      .catch(() => setStatus(null));
  }, []);

  if (status === undefined) {
    return <SkeletonCard />;
  }

  if (status === null) {
    return null;
  }

  /**
   * Nothing on this card means anything without a logbook.
   *
   * It is headed "SIWES Internship" and counts logs this week and signed-off
   * weeks. It used to render for every intern, so a volunteer was told they
   * were on SIWES and shown a compliance scoreboard for duties they do not
   * have. Hidden rather than relabelled — an "Internship" card reporting zero
   * logs forever would be a different way of saying the same wrong thing.
   */
  if (!status.carries_logbook) {
    return null;
  }

  const physicalDayLabel =
    status.physical_day != null ? DAY_NAMES[status.physical_day] : null;

  return (
    <div className="bg-white rounded-lg shadow-sm p-6 border border-slate-200">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-iih-green" />
          <h3 className="font-semibold text-slate-800">SIWES Internship</h3>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${statusPillClass(status.cohort_status)}`}
        >
          {status.cohort_status}
        </span>
      </div>

      <p className="text-sm font-medium text-slate-700 mb-1">{status.cohort_name}</p>

      <div className="space-y-1 mb-4 text-sm text-slate-600">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-slate-400 flex-shrink-0" />
          <span className="capitalize">{status.participation_mode} mode</span>
        </div>
        {status.supervisor_name && (
          <div className="flex items-center gap-2">
            <User className="w-4 h-4 text-slate-400 flex-shrink-0" />
            <span>{status.supervisor_name}</span>
          </div>
        )}
        {status.department_name && (
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-slate-400 flex-shrink-0" />
            <span>{status.department_name}</span>
          </div>
        )}
        {physicalDayLabel && (
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-slate-400 flex-shrink-0" />
            <span>Physical day: {physicalDayLabel}</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-4 gap-2 mb-4">
        <div className="text-center">
          <div className="text-lg font-bold text-slate-800">{status.logs_this_week}</div>
          <div className="text-xs text-slate-500 leading-tight">This week</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold text-green-600">{status.approved_logs}</div>
          <div className="text-xs text-slate-500 leading-tight">Approved</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold text-amber-600">{status.pending_changes}</div>
          <div className="text-xs text-slate-500 leading-tight">Pending</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold text-blue-600">{status.signed_off_weeks}</div>
          <div className="text-xs text-slate-500 leading-tight">Signed off</div>
        </div>
      </div>

      <Link
        to="/logbook"
        className="block text-center bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors text-sm"
      >
        Open Logbook
      </Link>
    </div>
  );
}
