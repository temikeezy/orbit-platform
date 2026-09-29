import { OrbitDailyLog } from '../../types/database';
import { formatDate } from '../../lib/utils/date';
import { ExternalLink, Paperclip, MessageSquare } from 'lucide-react';
import { SafeLink } from '../common/SafeLink';

interface DailyLogDetailProps {
  log: OrbitDailyLog;
}

interface FieldRowProps {
  label: string;
  value?: string | number | null;
}

function FieldRow({ label, value }: FieldRowProps) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="grid grid-cols-3 gap-2 py-2 border-b border-slate-100 last:border-0">
      <dt className="text-sm font-medium text-slate-500 col-span-1">{label}</dt>
      <dd className="text-sm text-slate-800 col-span-2 whitespace-pre-wrap">{value}</dd>
    </div>
  );
}

function modePill(mode: string) {
  return mode === 'physical'
    ? 'bg-green-100 text-green-800'
    : 'bg-blue-100 text-blue-800';
}

export function DailyLogDetail({ log }: DailyLogDetailProps) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <span className="text-base font-semibold text-slate-800">
          {formatDate(log.log_date)}
        </span>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${modePill(log.participation_mode)}`}
        >
          {log.participation_mode}
        </span>
        {log.hours_spent != null && (
          <span className="text-xs text-slate-500">{log.hours_spent}h logged</span>
        )}
        {log.stream_name && (
          <span className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">
            {log.stream_name}
          </span>
        )}
        {log.department_name && (
          <span className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">
            {log.department_name}
          </span>
        )}
      </div>

      <dl className="bg-slate-50 rounded-lg p-4">
        <FieldRow label="Title" value={log.title} />
        <FieldRow label="Work done" value={log.work_done} />
        <FieldRow label="What I learned" value={log.learned} />
        <FieldRow label="Tools used" value={log.tools_used} />
        <FieldRow label="Challenges" value={log.challenges} />
        <FieldRow label="Next steps" value={log.next_steps} />
      </dl>

      {log.evidence_links && log.evidence_links.length > 0 && (
        <div>
          <p className="text-sm font-medium text-slate-700 mb-2 flex items-center gap-1">
            <ExternalLink className="w-4 h-4" />
            Evidence links
          </p>
          <ul className="space-y-1">
            {log.evidence_links.map((link, idx) => (
              <li key={idx}>
                <SafeLink href={link} className="text-sm text-iih-green hover:underline break-all">
                  {link}
                </SafeLink>
              </li>
            ))}
          </ul>
        </div>
      )}

      {log.attachment_url && (
        <div>
          <p className="text-sm font-medium text-slate-700 mb-1 flex items-center gap-1">
            <Paperclip className="w-4 h-4" />
            Attachment
          </p>
          <SafeLink href={log.attachment_url} className="text-sm text-iih-green hover:underline break-all">
            {log.attachment_url}
          </SafeLink>
        </div>
      )}

      {log.supervisor_comment && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex gap-3">
          <MessageSquare className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-semibold text-amber-800 mb-1">Supervisor comment</p>
            <p className="text-sm text-amber-900 whitespace-pre-wrap">{log.supervisor_comment}</p>
          </div>
        </div>
      )}
    </div>
  );
}
