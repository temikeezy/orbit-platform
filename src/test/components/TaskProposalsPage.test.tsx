import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskProposalsPage } from '../../pages/TaskProposalsPage';
import { tasksApi } from '../../lib/api/tasks';
import { streamsApi } from '../../lib/api/streams';
import { convexMock } from '../mocks/convex';
import { mockAdminUser, mockInternUser } from '../fixtures';
import { renderWithProviders } from '../render';

/**
 * The "request another task" control.
 *
 * This is the level that matters for this feature: the integration suite skips
 * without ORBIT_TEST_MCP_SECRET, which CI has historically lacked, so these are
 * the tests that actually run on every change.
 *
 * The behaviour worth pinning is the distinction the control exists to make. A
 * request can fail for three ordinary reasons — the programme has not started,
 * the stream is not running, or the stream's bank of prepared tasks is used up.
 * None is a fault, and the last becomes the COMMON outcome once a stream has
 * worked through its five. Only an authorisation or network failure is an
 * error. The server signals which is which structurally: ordinary outcomes come
 * back as `{ success: false }`, real failures throw.
 */
describe('TaskProposalsPage — requesting another task', () => {
  beforeEach(() => {
    vi.useRealTimers();
    convexMock.reset();
    convexMock.echoSession();
    vi.restoreAllMocks();

    vi.spyOn(tasksApi, 'getPendingProposals').mockResolvedValue([]);
    vi.spyOn(tasksApi, 'getApprovalWindow').mockResolvedValue(48);
    vi.spyOn(streamsApi, 'getAllStreams').mockResolvedValue([
      { id: 'stream-1', name: 'Engineering', is_moderator: true },
    ] as never);
  });

  it('offers the control even with an empty queue', async () => {
    // The whole point of placing it above the empty state: declining deletes a
    // proposal, so a supervisor who rejects everything lands here — which is
    // exactly when they need to ask for another.
    renderWithProviders(<TaskProposalsPage />, { user: mockAdminUser });

    expect(await screen.findByText(/nothing waiting/i)).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /request another task/i }),
    ).toBeEnabled();
  });

  it('hides the control from someone who moderates no streams', async () => {
    vi.spyOn(streamsApi, 'getAllStreams').mockResolvedValue([
      { id: 'stream-9', name: 'Someone else', is_moderator: false },
    ] as never);

    renderWithProviders(<TaskProposalsPage />, { user: mockAdminUser });

    await screen.findByText(/nothing waiting/i);
    expect(screen.queryByRole('button', { name: /request another task/i })).toBeNull();
  });

  it('refetches the queue after a successful request', async () => {
    const request = vi
      .spyOn(tasksApi, 'requestNewTask')
      .mockResolvedValue({ success: true, taskId: 't1', title: 'Write a test plan' });

    renderWithProviders(<TaskProposalsPage />, { user: mockAdminUser });
    const button = await screen.findByRole('button', { name: /request another task/i });

    await userEvent.click(button);

    await waitFor(() => expect(request).toHaveBeenCalledWith('stream-1'));
    // Refetched rather than optimistically inserted — the server decides the
    // order, and the new row is a proposal like any other.
    await waitFor(() => expect(tasksApi.getPendingProposals).toHaveBeenCalledTimes(2));
  });

  it('shows an exhausted bank as information, not an error', async () => {
    vi.spyOn(tasksApi, 'requestNewTask').mockResolvedValue({
      success: false,
      error: 'No further tasks are prepared for Engineering. Write one directly, or edit an existing proposal.',
    });

    renderWithProviders(<TaskProposalsPage />, { user: mockAdminUser });
    await userEvent.click(await screen.findByRole('button', { name: /request another task/i }));

    // Rendered inline and kept on screen, because it carries instructions worth
    // reading twice. A toast would vanish; a red one would call it a fault.
    expect(await screen.findByText(/no further tasks are prepared/i)).toBeInTheDocument();
  });

  it('offers a way to write one directly alongside the exhausted message', async () => {
    /**
     * NAMED FOR WHAT IT PROVES. This was "always offers…", which was literally
     * false — the link is conditional on a stream being selected, so with
     * several streams and none chosen there is no link. It also never rendered
     * the state its comment described. Now it asserts the pairing that matters:
     * when the bank is exhausted, the advice to write one has somewhere to go.
     */
    vi.spyOn(tasksApi, 'requestNewTask').mockResolvedValue({
      success: false,
      error: 'No further tasks are prepared for Engineering. Write one directly, or edit an existing proposal.',
    });

    renderWithProviders(<TaskProposalsPage />, { user: mockAdminUser });
    await userEvent.click(await screen.findByRole('button', { name: /request another task/i }));

    expect(await screen.findByText(/no further tasks are prepared/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /or write one yourself/i })).toBeInTheDocument();
  });

  it('never shows the control to someone who is not staff', async () => {
    // The interns-only rule rested on an early return with nothing pinning it.
    renderWithProviders(<TaskProposalsPage />, { user: mockInternUser });

    expect(await screen.findByText(/access denied/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request another task/i })).toBeNull();
  });

  it('disables the button while a request is in flight', async () => {
    let release: (v: { success: true; taskId: string; title: string }) => void = () => {};
    vi.spyOn(tasksApi, 'requestNewTask').mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    renderWithProviders(<TaskProposalsPage />, { user: mockAdminUser });
    const button = await screen.findByRole('button', { name: /request another task/i });

    await userEvent.click(button);

    // Load-bearing: the mutation is NOT idempotent — every success inserts a
    // row — so an unguarded double-click drafts a second task nobody asked for.
    await waitFor(() => expect(screen.getByRole('button', { name: /requesting/i })).toBeDisabled());

    // Actually click it again. Asserting `disabled` proves the attribute; this
    // proves the consequence — one user action, one insert.
    await userEvent.click(screen.getByRole('button', { name: /requesting/i }));
    expect(tasksApi.requestNewTask).toHaveBeenCalledTimes(1);

    release({ success: true, taskId: 't1', title: 'Done' });
  });
});
