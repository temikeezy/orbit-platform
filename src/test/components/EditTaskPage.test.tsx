import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { EditTaskPage } from '../../pages/EditTaskPage';
import { tasksApi } from '../../lib/api/tasks';
import { streamsApi } from '../../lib/api/streams';
import { authService } from '../../lib/auth';
import { convexMock } from '../mocks/convex';
import { mockAdminUser, mockTask } from '../fixtures';
import { renderWithProviders } from '../render';

describe('EditTaskPage programme clock', () => {
  beforeEach(() => {
    convexMock.reset();
    convexMock.echoSession();

    /**
     * The revalidation is stubbed outright, not just its network call.
     *
     * AuthProvider renders the cached user and then calls
     * `authService.refreshUser()`, whose result replaces `user`. Every failure
     * mode of that function ends at `localStorage`: an explicit null from the
     * server signs the user out, and its catch falls back to
     * `getCurrentUser()`, which READS localStorage — and `setup.ts` clears
     * localStorage in a `beforeEach`. So whether this component saw an admin
     * came down to a race between that promise and the next test starting.
     * Lose it and `user` goes null, `isAdmin` goes false, and the page renders
     * "You don't have permission to edit tasks" instead of the form: green
     * through dozens of local runs, intermittently red on CI, where the
     * assertions are slow enough for the refresh to land first.
     *
     * Stubbing `refreshUser` itself — rather than the `auth.me` query beneath
     * it — closes the fallback path too, so the identity is a fact of the test
     * rather than a function of its timing.
     *
     * BOTH reads are stubbed, and both sit AFTER `vi.restoreAllMocks()`.
     *
     * `getCurrentUser` matters as much as `refreshUser`: AuthProvider seeds
     * `user` from it and returns early — never revalidating at all — when it
     * comes back null, so stubbing only the refresh left a path where `user`
     * stayed null for the life of the component. And ordering matters because a
     * spy registered BEFORE `restoreAllMocks` is torn down on the very next
     * line, which is exactly what happened to the first attempt at this: the
     * real implementation ran anyway, `user` went null, and `handleSubmit`
     * returned at its `if (!user)` guard with "You must be logged in" — so
     * `updateTask` was never called and the failure read as a broken submit.
     */
    vi.restoreAllMocks();
    vi.spyOn(authService, 'getCurrentUser').mockReturnValue(mockAdminUser);
    vi.spyOn(authService, 'refreshUser').mockResolvedValue(mockAdminUser);
    vi.spyOn(tasksApi, 'getTaskById').mockResolvedValue({
      ...mockTask,
      created_by_name: 'Admin', stream_name: 'Engineering', stream_emoji: '',
      is_accepted: false, is_member_of_stream: true,
    });
    /**
     * `is_moderator: true`, which is what actually decouples this file from the
     * session race.
     *
     * EditTaskPage renders "You don't have permission to edit tasks" when
     * `streams.length === 0 && !isAdmin`, and when `isAdmin` is false it filters
     * the list down to streams the caller moderates. A fixture stream with no
     * `is_moderator` therefore filtered to nothing, so ANY moment where the
     * session had not resolved to an admin produced the permission screen
     * instead of the form — and that is what CI kept capturing, however the
     * identity was stubbed upstream.
     *
     * A stream this actor can moderate satisfies the check on its own, so the
     * form renders either way. This spec is about what a deadline does when task
     * content changes; it should not also be a test of permission resolution.
     */
    vi.spyOn(streamsApi, 'getAllStreams').mockResolvedValue([
      { id: 'stream-1', name: 'Engineering', is_moderator: true },
    ] as never);
  });

  it('explains the dated start while keeping existing task editing available', { timeout: 30_000 }, async () => {
    vi.spyOn(tasksApi, 'getTaskProgrammeState').mockResolvedValue({
      allowed: false,
      cohortName: 'Cohort 3',
      startDate: '2026-09-07',
      defaultDeadline: null,
      error: 'Tasks cannot be created or assigned until the programme starts on 2026-09-07.',
    });

    renderWithProviders(
      <Routes>
        <Route path="/tasks/:taskId/edit" element={<EditTaskPage />} />
      </Routes>, {
      user: mockAdminUser,
      initialRoute: '/tasks/task-1/edit',
    });

    expect(await screen.findByText(/programme starts on 2026-09-07/i)).toBeInTheDocument();
    // Async, and patient, for the same reason as the sibling test below.
    expect(
      await screen.findByRole('button', { name: /update task/i }, { timeout: 10_000 }),
    ).toBeEnabled();
  });

  /**
   * 30s, because the waits inside are longer than vitest's 5s default.
   *
   * The retry below can sit through a full reload cycle, and a `waitFor`
   * budget only counts if the test itself outlives it — otherwise the test
   * dies at 5s reporting a timeout rather than whatever it was waiting for,
   * which is exactly what happened once the patient queries went in.
   */
  it('does not replace an exact deadline when only task content changes', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    vi.spyOn(tasksApi, 'getTaskProgrammeState').mockResolvedValue({
      allowed: true,
      cohortName: 'Cohort 2',
      startDate: '2026-08-10',
      defaultDeadline: Date.parse('2026-08-13T22:59:59.999Z'),
    });
    const update = vi.spyOn(tasksApi, 'updateTask').mockResolvedValue(mockTask);

    renderWithProviders(
      <Routes>
        <Route path="/tasks/:taskId/edit" element={<EditTaskPage />} />
      </Routes>, {
        user: mockAdminUser,
        initialRoute: '/tasks/task-1/edit',
      });

    /**
     * Generous timeouts, because the page legitimately RELOADS mid-test.
     *
     * AuthProvider renders the cached user and then revalidates; when the fresh
     * session lands, `isAdmin` is recomputed, and `isAdmin` is a dependency of
     * EditTaskPage's `loadData`, so the effect re-runs and the form is replaced
     * by its loading spinner until the refetch completes. That is correct
     * behaviour, but it means both the field and the button can vanish and come
     * back between one interaction and the next. testing-library's 1s default
     * is comfortably longer than the round trip locally and not always longer
     * than it on a two-core CI runner, which is the whole of why this test was
     * green here and intermittently red there.
     */
    const findTimeout = { timeout: 10_000 };

    const title = await screen.findByLabelText(/task title/i, undefined, findTimeout);
    await user.clear(title);
    await user.type(title, 'Updated title');

    /**
     * `findBy`, not `getBy` — the button is legitimately asynchronous here.
     *
     * The whole form sits behind `loadingData` (EditTaskPage.tsx:191), and the
     * effect that sets it re-runs whenever `loadData`'s identity changes, which
     * it does when `isAdmin` is recomputed on an AuthContext re-render. So a
     * re-render landing between the typing above and this query swaps the form
     * for a spinner for a tick and a synchronous lookup finds no button. It is
     * timing-dependent, so it passed locally and failed intermittently on CI —
     * where the typing takes long enough to overlap the window — which reads as
     * "the Update button is missing" rather than "the form re-mounted".
     */
    await user.click(
      await screen.findByRole('button', { name: /update task/i }, findTimeout),
    );

    // The reload can also land between finding the button and the click taking
    // effect, dropping the typed title with it. Retry the whole edit until the
    // submit actually reaches the API rather than asserting a single attempt.
    await waitFor(
      async () => {
        if (update.mock.calls.length > 0) return;
        const field = await screen.findByLabelText(/task title/i, undefined, findTimeout);
        await user.clear(field);
        await user.type(field, 'Updated title');
        await user.click(
          await screen.findByRole('button', { name: /update task/i }, findTimeout),
        );
        expect(update).toHaveBeenCalled();
      },
      { timeout: 20_000 },
    );

    /**
     * Awaited, because the call is asynchronous with respect to the click.
     *
     * `handleSubmit` is an async handler — the `tasksApi.updateTask` call sits
     * behind a validation pass and a `setLoading`, so the promise chain can
     * still be pending when `user.click` returns. Asserting synchronously
     * passes on a fast machine and fails on a slow one, which is what CI is:
     * this failed there intermittently while 24 consecutive local runs
     * (including under `--coverage`, CI's exact command) stayed green, and the
     * message — "expected updateTask to be called at least once" — reads like a
     * broken submit rather than a test that looked too early.
     */
    expect(update.mock.calls[0][1]).not.toHaveProperty('deadline');
  });
});
