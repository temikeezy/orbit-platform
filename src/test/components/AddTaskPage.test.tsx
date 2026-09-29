import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { AddTaskPage } from '../../pages/AddTaskPage';
import { tasksApi } from '../../lib/api/tasks';
import { streamsApi } from '../../lib/api/streams';
import { convexMock } from '../mocks/convex';
import { mockAdminUser } from '../fixtures';
import { renderWithProviders } from '../render';

describe('AddTaskPage programme clock', () => {
  beforeEach(() => {
    vi.useRealTimers();
    convexMock.reset();
    convexMock.echoSession();
    vi.restoreAllMocks();
    vi.spyOn(streamsApi, 'getAllStreams').mockResolvedValue([
      { id: 'stream-1', name: 'Engineering', is_moderator: true },
    ] as never);
  });

  it('shows the cadence default and blocks creation before a dated start', async () => {
    vi.spyOn(tasksApi, 'getTaskProgrammeState').mockResolvedValue({
      allowed: false,
      cohortName: 'Cohort 3',
      startDate: '2026-09-07',
      defaultDeadline: null,
      error: 'Tasks cannot be created or assigned until the programme starts on 2026-09-07.',
    });

    renderWithProviders(<AddTaskPage />, { user: mockAdminUser });

    expect(await screen.findByText(/programme starts on 2026-09-07/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /create task/i })).toBeDisabled());
  });

  it('refreshes the authoritative default while the form remains open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = {
      allowed: true as const,
      cohortName: 'Cohort 2',
      startDate: '2026-08-10',
      defaultDeadline: Date.parse('2026-08-13T22:59:59.999Z'),
    };
    const state = vi.spyOn(tasksApi, 'getTaskProgrammeState')
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({
        ...first,
      })
      .mockResolvedValue({
        allowed: true,
        cohortName: 'Cohort 2',
        startDate: '2026-08-10',
        defaultDeadline: Date.parse('2026-08-20T22:59:59.999Z'),
      });

    renderWithProviders(<AddTaskPage />, { user: mockAdminUser });
    expect(await screen.findByLabelText(/deadline/i)).toHaveValue('2026-08-13T23:59');

    await vi.advanceTimersByTimeAsync(60_000);

    await waitFor(() => expect(state).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText(/deadline/i)).toHaveValue('2026-08-20T23:59');
  });
});
