import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { FirstStepsTasks } from '../../components/tasks/FirstStepsTasks';
import { onboardingApi } from '../../lib/api/onboarding';
import { convexMock } from '../mocks/convex';
import { mockInternUser, mockAdminUser } from '../fixtures';
import { renderWithProviders } from '../render';

/**
 * The first-steps cards on the tasks page.
 *
 * The behaviour worth pinning is what keeps these OUT of the platform's
 * accounting: they are derived from the member's own record, never written, and
 * never counted as real tasks. A regression here would not be a broken card —
 * it would be onboarding leaking into badges, points and review totals.
 */
describe('FirstStepsTasks', () => {
  const steps = (password: boolean, manual: boolean) => ({
    applicable: true,
    complete: password && manual,
    steps: [
      { key: 'signIn' as const, title: 'Sign in to ORBIT', description: 'done', done: true, href: null },
      {
        key: 'password' as const,
        title: 'Set your password',
        description: 'Your sign-in link expires.',
        done: password,
        href: '/settings?tab=security',
      },
      {
        key: 'manual' as const,
        title: 'Read the orientation manual',
        description: 'How streams and tasks work.',
        done: manual,
        href: '/orientation',
      },
    ],
  });

  beforeEach(() => {
    convexMock.reset();
    convexMock.echoSession();
    vi.restoreAllMocks();
  });

  it('shows the two actionable steps and hides sign-in', async () => {
    vi.spyOn(onboardingApi, 'status').mockResolvedValue(steps(false, false));
    renderWithProviders(<FirstStepsTasks />, { user: mockInternUser });

    expect(await screen.findByText(/set your password/i)).toBeInTheDocument();
    expect(screen.getByText(/read the orientation manual/i)).toBeInTheDocument();
    // Already true by definition — you cannot read this without a session.
    expect(screen.queryByText(/sign in to orbit/i)).toBeNull();
  });

  it('says a step completes on its own, because nothing is submitted', async () => {
    vi.spyOn(onboardingApi, 'status').mockResolvedValue(steps(false, false));
    renderWithProviders(<FirstStepsTasks />, { user: mockInternUser });

    // Where a real task shows a deadline. Without this a member would
    // reasonably wonder how a task with no submit button ever gets ticked off.
    expect((await screen.findAllByText(/completes on its own/i)).length).toBe(2);
  });

  it('marks a step done from state alone, with nothing submitted', async () => {
    vi.spyOn(onboardingApi, 'status').mockResolvedValue(steps(true, false));
    renderWithProviders(<FirstStepsTasks />, { user: mockInternUser });

    expect(await screen.findByText(/^Done$/)).toBeInTheDocument();
    expect(screen.getByText(/1 to go/i)).toBeInTheDocument();
  });

  it('disappears once everything is finished', async () => {
    vi.spyOn(onboardingApi, 'status').mockResolvedValue(steps(true, true));
    const { container } = renderWithProviders(<FirstStepsTasks />, { user: mockInternUser });

    // A permanent "you have done everything" panel is furniture.
    await vi.waitFor(() => expect(container.querySelector('section')).toBeNull());
  });

  it('renders nothing for staff', async () => {
    // Tasks, points and levels are interns-only, and so is this.
    vi.spyOn(onboardingApi, 'status').mockResolvedValue({
      applicable: false,
      steps: [],
      complete: true,
    });
    const { container } = renderWithProviders(<FirstStepsTasks />, { user: mockAdminUser });

    await vi.waitFor(() => expect(container.querySelector('section')).toBeNull());
  });

  it('stays silent when the query fails', async () => {
    // It sits above the member's real task list; an error banner for a
    // two-item helper would be louder than the helper.
    vi.spyOn(onboardingApi, 'status').mockRejectedValue(new Error('offline'));
    const { container } = renderWithProviders(<FirstStepsTasks />, { user: mockInternUser });

    await vi.waitFor(() => expect(container.querySelector('section')).toBeNull());
  });

  it('links the password step to the tab holding the form', async () => {
    vi.spyOn(onboardingApi, 'status').mockResolvedValue(steps(false, true));
    renderWithProviders(<FirstStepsTasks />, { user: mockInternUser });

    const link = (await screen.findByText(/set your password/i)).closest('a');
    expect(link).toHaveAttribute('href', '/settings?tab=security');
  });
});
