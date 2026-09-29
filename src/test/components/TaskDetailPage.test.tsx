import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { TaskDetailPage } from '../../pages/TaskDetailPage';
import { tasksApi } from '../../lib/api/tasks';
import { streamsApi } from '../../lib/api/streams';
import { authService } from '../../lib/auth';
import { convexMock } from '../mocks/convex';
import { mockInternUser, mockTask } from '../fixtures';
import { renderWithProviders } from '../render';

/**
 * Editing work that is submitted but not yet marked.
 *
 * The server always allowed it; the page did not, so an intern told by the
 * agent that their link could not be opened had no way to fix it (two interns
 * reported exactly this through the bug button). Identity is stubbed the same
 * way, and for the same reasons, as EditTaskPage.test.tsx.
 */
describe('TaskDetailPage — editing a pending submission', () => {
  beforeEach(() => {
    convexMock.reset();
    convexMock.echoSession();
    vi.restoreAllMocks();
    vi.spyOn(authService, 'getCurrentUser').mockReturnValue(mockInternUser);
    vi.spyOn(authService, 'refreshUser').mockResolvedValue(mockInternUser);
    vi.spyOn(streamsApi, 'getAllStreams').mockResolvedValue([] as never);
  });

  const pendingLinkTask = (status: string) => ({
    ...mockTask,
    submission_type: 'link',
    deadline: new Date(Date.now() - 86_400_000).toISOString(), // already passed
    stream_name: 'Engineering', stream_emoji: '', created_by_name: 'ORBIT Agent',
    is_accepted: true, is_member_of_stream: true,
    user_submission: {
      id: 'sub-1', status, submission_url: 'https://docs.google.com/document/d/abc/edit',
      submitted_at: new Date().toISOString(),
    },
  });

  it('reopens the form, prefilled, even after the deadline, and resubmits', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    vi.spyOn(tasksApi, 'getTaskById').mockResolvedValue(pendingLinkTask('submitted') as never);
    const submit = vi.spyOn(tasksApi, 'submitTask').mockResolvedValue(undefined as never);

    renderWithProviders(
      <Routes>
        <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
      </Routes>,
      { user: mockInternUser, initialRoute: '/tasks/task-1' },
    );

    await user.click(await screen.findByRole('button', { name: /edit submission/i }, { timeout: 10_000 }));
    const input = await screen.findByDisplayValue('https://docs.google.com/document/d/abc/edit');
    await user.clear(input);
    await user.type(input, 'https://example.com/my-work');
    await user.click(screen.getByRole('button', { name: /update submission/i }));

    expect(submit).toHaveBeenCalledWith('task-1', { text: undefined, url: 'https://example.com/my-work' });
  });

  it('offers no edit once the work has been marked', { timeout: 30_000 }, async () => {
    vi.spyOn(tasksApi, 'getTaskById').mockResolvedValue(pendingLinkTask('approved') as never);

    renderWithProviders(
      <Routes>
        <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
      </Routes>,
      { user: mockInternUser, initialRoute: '/tasks/task-1' },
    );

    expect(await screen.findByText(/your submission/i, {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit submission/i })).not.toBeInTheDocument();
  });

  it('lets returned work be resubmitted after the deadline', { timeout: 30_000 }, async () => {
    // Markers return work (tasks.returnForChanges) often after the deadline.
    vi.spyOn(tasksApi, 'getTaskById').mockResolvedValue(pendingLinkTask('changes_requested') as never);

    renderWithProviders(
      <Routes>
        <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
      </Routes>,
      { user: mockInternUser, initialRoute: '/tasks/task-1' },
    );

    expect(
      await screen.findByRole('button', { name: /submit task/i }, { timeout: 10_000 }),
    ).toBeInTheDocument();
  });
});
