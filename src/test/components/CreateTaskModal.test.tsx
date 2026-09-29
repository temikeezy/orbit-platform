import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateTaskModal } from '../../components/tasks/CreateTaskModal';

/**
 * Task creation: the form that publishes work to a whole stream.
 *
 * Worth testing at this level because the validation is entirely local — the
 * Create button is disabled until every required field is filled, and a stream
 * is required whenever the caller supplies a list of them. A stream-less task
 * belongs to nobody and appears to no one.
 *
 * This modal also carried a hardcoded one-second setTimeout before saving. It
 * is gone, and the last test here is what keeps it gone: the spinner now tracks
 * real work, so a save that resolves immediately closes immediately.
 */

const streams = [
  { id: 'stream-1', name: 'Engineering' },
  { id: 'stream-2', name: 'Design' },
];

const programmeState = {
  allowed: true as const,
  cohortName: 'Cohort 2',
  startDate: '2026-08-10',
  defaultDeadline: Date.parse('2026-08-13T22:59:59.999Z'),
};

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('e.g., Complete React Component Exercise'), 'Ship it');
  await user.type(
    screen.getByPlaceholderText('Provide detailed instructions for this task...'),
    'Full instructions here.',
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('CreateTaskModal', () => {
  it('keeps Create disabled until every required field is filled', async () => {
    const user = userEvent.setup();
    render(<CreateTaskModal onClose={vi.fn()} onSave={vi.fn()} programmeState={programmeState} />);

    const create = screen.getByRole('button', { name: 'Create Task' });
    expect(create).toBeDisabled();

    await fillRequired(user);
    expect(create).toBeEnabled();
  });

  it('requires a stream when streams are offered', async () => {
    const user = userEvent.setup();
    render(<CreateTaskModal onClose={vi.fn()} onSave={vi.fn()} streams={streams} programmeState={programmeState} />);

    await fillRequired(user);

    // Everything else is filled, so this is the stream and nothing but.
    // A task created against no stream is published to nobody.
    expect(screen.getByRole('button', { name: 'Create Task' })).toBeDisabled();

    await user.selectOptions(screen.getByRole('combobox', { name: /stream/i }), 'stream-1');
    expect(screen.getByRole('button', { name: 'Create Task' })).toBeEnabled();
  });

  it('passes the values it collected, not defaults', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(<CreateTaskModal onClose={vi.fn()} onSave={onSave} streams={streams} programmeState={programmeState} />);

    await fillRequired(user);
    await user.selectOptions(screen.getByRole('combobox', { name: /stream/i }), 'stream-2');
    await user.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      title: 'Ship it',
      description: 'Full instructions here.',
      streamId: 'stream-2',
    });
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('deadline');
  });

  it('shows the exact cadence deadline in WAT and sends an edited value', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(<CreateTaskModal onClose={vi.fn()} onSave={onSave} programmeState={programmeState} />);

    const deadline = screen.getByLabelText(/deadline/i) as HTMLInputElement;
    expect(deadline).toHaveValue('2026-08-13T23:59');
    expect(screen.getByText(/weekly deliverables use the programme's configured cadence/i)).toBeInTheDocument();

    await fillRequired(user);
    await user.clear(deadline);
    await user.type(deadline, '2026-08-20T18:30');
    await user.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].deadline).toBe('2026-08-20T18:30');
  });

  it('explains and disables creation before the programme start date', () => {
    render(
      <CreateTaskModal
        onClose={vi.fn()}
        onSave={vi.fn()}
        programmeState={{
          allowed: false,
          cohortName: 'Cohort 3',
          startDate: '2026-09-07',
          defaultDeadline: null,
          error: 'Tasks cannot be created or assigned until the programme starts on 2026-09-07.',
        }}
      />,
    );

    expect(screen.getByText(/programme starts on 2026-09-07/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Task' })).toBeDisabled();
  });

  it('closes once the save resolves, and not before', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const onSave = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const onClose = vi.fn();

    render(<CreateTaskModal onClose={onClose} onSave={onSave} programmeState={programmeState} />);

    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Create Task' }));

    // In flight: the button says so and the modal is still up. This is the
    // assertion that the spinner reflects real work — with the old hardcoded
    // setTimeout it said "Creating…" for a second regardless.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Creating...' })).toBeDisabled());
    expect(onClose).not.toHaveBeenCalled();

    release();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  /**
   * A re-render of the PARENT must not pull focus out of the form.
   *
   * The focus-on-open effect used to share the Escape effect's `[onClose]`
   * dependency, and `onClose` is an inline arrow at every call site — so every
   * parent render re-ran it and moved focus to the close button. The parent
   * re-renders on its own schedule (TasksManagementPage polls the programme
   * state once a minute), so this landed mid-sentence: the next space typed
   * activated the now-focused button and closed the modal over a half-written
   * task. Re-rendering with a fresh `onClose` here is exactly what the parent
   * does, so this fails against the old effect and passes against the split one.
   */
  it('keeps focus in the form when the parent re-renders', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    const { rerender } = render(
      <CreateTaskModal onClose={() => {}} onSave={onSave} programmeState={programmeState} />,
    );

    const title = screen.getByPlaceholderText('e.g., Complete React Component Exercise');
    await user.click(title);
    await user.type(title, 'Weekly');

    // A new inline arrow, as the parent supplies on every one of its renders.
    rerender(<CreateTaskModal onClose={() => {}} onSave={onSave} programmeState={programmeState} />);

    expect(title).toHaveFocus();

    // The space is the character that used to close the modal.
    await user.type(title, ' task');
    expect(title).toHaveValue('Weekly task');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes on Escape without saving', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSave = vi.fn();

    render(<CreateTaskModal onClose={onClose} onSave={onSave} programmeState={programmeState} />);

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
