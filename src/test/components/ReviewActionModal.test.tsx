import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewActionModal } from '../../components/review/ReviewActionModal';

/**
 * The modal every supervisor decision goes through.
 *
 * Its one rule is that a decision which needs a reason cannot be submitted
 * without one — "changes requested" with no explanation is useless to the person
 * receiving it, and by the time they ask, the reviewer has moved on. The server
 * enforces it too; this is about not letting the button be pressed at all.
 */

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('ReviewActionModal', () => {
  it('disables the action until a required comment is typed', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);

    render(
      <ReviewActionModal
        title="Request changes"
        actionLabel="Request changes"
        requireComment
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    const confirm = screen.getByRole('button', { name: 'Request changes' });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByRole('textbox'), 'Please add the tools you used.');
    expect(confirm).toBeEnabled();
  });

  it('treats whitespace as no comment at all', async () => {
    const user = userEvent.setup();

    render(
      <ReviewActionModal
        title="Request changes"
        actionLabel="Request changes"
        requireComment
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByRole('textbox'), '   ');
    // A space bar is not feedback. Trimming here is what stops the required
    // field from being satisfied by the easiest possible keypress.
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeDisabled();
  });

  it('allows an empty comment when one is optional', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <ReviewActionModal
        title="Approve"
        actionLabel="Approve"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(''));
    // Closing only after the confirm RESOLVES. Closing first would hide a
    // failure behind a modal that already went away.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('trims the comment it passes on', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);

    render(
      <ReviewActionModal
        title="Approve"
        actionLabel="Approve"
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByRole('textbox'), '  Good work.  ');
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Good work.'));
  });

  it('stays open when the action fails', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockRejectedValue(new Error('You are not a reviewer for this intern'));
    const onClose = vi.fn();

    render(
      <ReviewActionModal
        title="Approve"
        actionLabel="Approve"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    // The refusal has to remain visible and the decision recoverable. Closing
    // on failure loses what the reviewer typed and tells them nothing.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('cancels without acting', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();

    render(
      <ReviewActionModal
        title="Approve"
        actionLabel="Approve"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
