import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { TasksManagementPage } from '../../pages/admin/TasksManagementPage';
import { tasksApi } from '../../lib/api/tasks';
import { streamsApi } from '../../lib/api/streams';
import { convexMock } from '../mocks/convex';
import { mockAdminUser, mockTask } from '../fixtures';
import { renderWithProviders } from '../render';

vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

describe('TasksManagementPage task activation', () => {
  beforeEach(() => {
    convexMock.reset();
    convexMock.echoSession();
    vi.restoreAllMocks();
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.spyOn(streamsApi, 'getAllStreams').mockResolvedValue([{ id: 'stream-1', name: 'Engineering' }] as never);
    vi.spyOn(tasksApi, 'getAllTasks').mockResolvedValue([{
      ...mockTask,
      is_active: false,
      created_by_name: 'Admin', stream_name: 'Engineering', stream_emoji: '',
      is_accepted: false, is_member_of_stream: true,
    }]);
    vi.spyOn(tasksApi, 'getTaskProgrammeState').mockResolvedValue({
      allowed: false,
      cohortName: 'Cohort 3',
      startDate: '2026-09-07',
      defaultDeadline: null,
      error: 'Tasks cannot be created or assigned until the programme starts on 2026-09-07.',
    });
  });

  it('surfaces the server activation refusal instead of replacing it', async () => {
    const user = userEvent.setup();
    vi.spyOn(tasksApi, 'updateTask').mockRejectedValue(
      new Error('Tasks cannot be created or assigned until the programme starts on 2026-09-07.'),
    );

    renderWithProviders(<TasksManagementPage />, { user: mockAdminUser });
    await user.click(await screen.findByRole('button', { name: /inactive tasks/i }));
    await user.click(await screen.findByRole('button', { name: 'Activate' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Tasks cannot be created or assigned until the programme starts on 2026-09-07.',
    ));
  });

  it('surfaces the server creation refusal and keeps the form open', async () => {
    const user = userEvent.setup();
    vi.mocked(tasksApi.getTaskProgrammeState).mockResolvedValue({
      allowed: true,
      cohortName: 'Cohort 2',
      startDate: '2026-08-10',
      defaultDeadline: Date.parse('2026-08-13T22:59:59.999Z'),
    });
    vi.spyOn(tasksApi, 'createTask').mockRejectedValue(
      new Error('Tasks cannot be created or assigned until the programme starts on 2026-09-07.'),
    );

    renderWithProviders(<TasksManagementPage />, { user: mockAdminUser });
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Create Task' })).not.toHaveLength(0));
    await user.click(screen.getAllByRole('button', { name: 'Create Task' })[0]);
    await user.selectOptions(screen.getByRole('combobox', { name: /stream/i }), 'stream-1');
    await user.type(screen.getByPlaceholderText('e.g., Complete React Component Exercise'), 'Weekly task');
    await user.type(
      screen.getByPlaceholderText('Provide detailed instructions for this task...'),
      'Complete this week\'s exercise.',
    );
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create Task' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Tasks cannot be created or assigned until the programme starts on 2026-09-07.',
    ));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  /**
   * A refusal the page raises itself must keep the form open too.
   *
   * The two guards in `handleCreateTask` — no stream, no signed-in user — used
   * to toast and `return`. The modal awaits that function and closes whenever it
   * resolves, so the guard's own refusal closed the form over a fully typed
   * task: the admin saw "Please log in again" flash by with their work gone, and
   * nothing had been sent anywhere. This is the session-expired path, which is
   * exactly when someone has been sitting on a half-filled form for a while.
   *
   * It was also the second half of a CI flake: under load the auth context had
   * not populated by the time the test clicked Create, so the real run took this
   * branch perhaps one time in five. Asserting it directly makes it a test of
   * the behaviour rather than of the machine's timing.
   */
  it('keeps the form open when there is no signed-in user to create as', async () => {
    const user = userEvent.setup();
    vi.mocked(tasksApi.getTaskProgrammeState).mockResolvedValue({
      allowed: true,
      cohortName: 'Cohort 2',
      startDate: '2026-08-10',
      defaultDeadline: Date.parse('2026-08-13T22:59:59.999Z'),
    });
    const createTask = vi.spyOn(tasksApi, 'createTask');

    renderWithProviders(<TasksManagementPage />, { user: null });
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Create Task' })).not.toHaveLength(0));
    await user.click(screen.getAllByRole('button', { name: 'Create Task' })[0]);
    await user.selectOptions(screen.getByRole('combobox', { name: /stream/i }), 'stream-1');
    await user.type(screen.getByPlaceholderText('e.g., Complete React Component Exercise'), 'Weekly task');
    await user.type(
      screen.getByPlaceholderText('Provide detailed instructions for this task...'),
      'Complete this week\'s exercise.',
    );
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create Task' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Please log in again'));
    expect(createTask).not.toHaveBeenCalled();
    // The whole point: the typing survives the refusal.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g., Complete React Component Exercise')).toHaveValue('Weekly task');
  });
});
