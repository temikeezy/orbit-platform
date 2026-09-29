import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';

interface ReviewActionModalProps {
  title: string;
  actionLabel: string;
  requireComment?: boolean;
  onConfirm: (comment: string) => Promise<void>;
  onClose: () => void;
}

export function ReviewActionModal({
  title,
  actionLabel,
  requireComment = false,
  onConfirm,
  onClose,
}: ReviewActionModalProps) {
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const titleId = useId();
  const commentId = useId();

  const isConfirmDisabled = submitting || (requireComment && comment.trim() === '');

  async function handleConfirm() {
    if (isConfirmDisabled) return;
    setSubmitting(true);
    try {
      await onConfirm(comment.trim());
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="bg-white rounded-lg max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto">
        <h2 id={titleId} className="text-lg font-semibold text-slate-800 mb-4">{title}</h2>

        <div className="mb-6">
          <label htmlFor={commentId} className="block text-sm font-medium text-slate-700 mb-2">
            {requireComment ? 'Comment (required)' : 'Comment (optional)'}
          </label>
          <textarea
            id={commentId}
            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent resize-none"
            rows={4}
            placeholder={requireComment ? 'Explain what needs to be changed...' : 'Add a note for the intern...'}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            disabled={submitting}
          />
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isConfirmDisabled}
            className="bg-iih-green hover:bg-iih-green-dark text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
