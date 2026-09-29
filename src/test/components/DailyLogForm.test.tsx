import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { convexMock } from '../mocks/convex';
import { DailyLogForm } from '../../components/logbook/DailyLogForm';
import { mockInternUser, seedLocalStorage } from '../fixtures';
import { OrbitInternProfile } from '../../types/database';

/**
 * The daily log form.
 *
 * Three things are worth pinning here, all of them consequences of the port:
 *
 * `status` used to be a value the CLIENT chose, so an intern could save their
 * own log as 'approved'. It is a `submit` boolean the server acts on now, and
 * the form must never send a status.
 *
 * A submitted or approved log is LOCKED, and the lock has to be visible in the
 * form rather than only discovered on save.
 *
 * The form learns its own log id from its first save. Without that, pressing
 * Save draft and then Submit for review sent no id the second time, and the
 * server refused a duplicate for the date — a confusing error on an ordinary
 * sequence of clicks.
 */

const profile = {
  id: 'profile-1',
  user_id: mockInternUser.id,
  cohort_id: 'cohort-1',
  participation_mode: 'hybrid',
} as OrbitInternProfile;

beforeEach(() => {
  localStorage.clear();
  convexMock.reset();
  vi.clearAllMocks();
  seedLocalStorage(mockInternUser, 'intern-tok');
  convexMock.echoSession();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('DailyLogForm', () => {
  it('refuses to save with no work described', async () => {
    const user = userEvent.setup();
    let called = 0;
    convexMock.onMutation('logbook.saveDailyLog', () => {
      called++;
      return { success: true, id: 'log-1' };
    });
    convexMock.onQuery('logbook.listDailyLogs', () => []);

    render(<DailyLogForm profile={profile} defaultDate="2026-08-02" onSaved={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    // Work done is the log. Everything else on the form is context around it.
    await waitFor(() => expect(called).toBe(0));
  });

  it('sends submit: false for a draft, and no status at all', async () => {
    const user = userEvent.setup();
    const sent: Record<string, unknown>[] = [];
    convexMock.onMutation('logbook.saveDailyLog', (args) => {
      sent.push(args);
      return { success: true, id: 'log-1' };
    });
    convexMock.onQuery('logbook.listDailyLogs', () => [
      { id: 'log-1', logDate: '2026-08-02', workDone: 'Built the table', status: 'draft' },
    ]);

    render(<DailyLogForm profile={profile} defaultDate="2026-08-02" onSaved={vi.fn()} />);

    await user.type(
      screen.getByPlaceholderText('Describe what you worked on today...'),
      'Built the table',
    );
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].submit).toBe(false);
    // Not 'draft', not anything — a status the client can name is a status the
    // client can set to 'approved'.
    expect(sent[0]).not.toHaveProperty('status');
  });

  it('sends submit: true when submitting for review', async () => {
    const user = userEvent.setup();
    const sent: Record<string, unknown>[] = [];
    convexMock.onMutation('logbook.saveDailyLog', (args) => {
      sent.push(args);
      return { success: true, id: 'log-1' };
    });
    convexMock.onQuery('logbook.listDailyLogs', () => []);

    render(<DailyLogForm profile={profile} defaultDate="2026-08-02" onSaved={vi.fn()} />);

    await user.type(
      screen.getByPlaceholderText('Describe what you worked on today...'),
      'Built the table',
    );
    await user.click(screen.getByRole('button', { name: 'Submit for review' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].submit).toBe(true);
  });

  it('warns before submitting, because submitting locks the log', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    let called = 0;
    convexMock.onMutation('logbook.saveDailyLog', () => {
      called++;
      return { success: true, id: 'log-1' };
    });
    convexMock.onQuery('logbook.listDailyLogs', () => []);

    render(<DailyLogForm profile={profile} defaultDate="2026-08-02" onSaved={vi.fn()} />);

    await user.type(
      screen.getByPlaceholderText('Describe what you worked on today...'),
      'Built the table',
    );
    await user.click(screen.getByRole('button', { name: 'Submit for review' }));

    // Declining the confirmation must not submit. The lock is not undoable by
    // the intern — only a supervisor can reopen a submitted log.
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(called).toBe(0);
  });

  it('carries the id from its own first save into the second', async () => {
    const user = userEvent.setup();
    const sent: Record<string, unknown>[] = [];
    convexMock.onMutation('logbook.saveDailyLog', (args) => {
      sent.push(args);
      return { success: true, id: 'log-1' };
    });
    convexMock.onQuery('logbook.listDailyLogs', () => [
      { id: 'log-1', logDate: '2026-08-02', workDone: 'Built the table', status: 'draft' },
    ]);

    // onSaved deliberately does nothing, which is the worst case: the parent has
    // not re-read the log, so the only place the id can come from is the form's
    // own memory of what it just saved.
    render(<DailyLogForm profile={profile} defaultDate="2026-08-02" onSaved={vi.fn()} />);

    await user.type(
      screen.getByPlaceholderText('Describe what you worked on today...'),
      'Built the table',
    );
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(sent).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(sent).toHaveLength(2));

    expect(sent[0].logId).toBeUndefined();
    // Without this the server sees a second new log for the same date and
    // refuses with "A log already exists for that date".
    expect(sent[1].logId).toBe('log-1');
  });

  it('locks the form for a log that has already been submitted', () => {
    convexMock.onQuery('logbook.listDailyLogs', () => []);

    render(
      <DailyLogForm
        profile={profile}
        log={
          {
            id: 'log-1',
            log_date: '2026-08-02',
            work_done: 'Built the table',
            status: 'submitted',
          } as never
        }
        defaultDate="2026-08-02"
        onSaved={vi.fn()}
      />,
    );

    // Visibly locked, not merely rejected on save. The intern needs to know why
    // they cannot type before they retype the whole entry.
    expect(screen.getByPlaceholderText('Describe what you worked on today...')).toBeDisabled();
  });
});
