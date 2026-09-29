import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { convexMock } from '../mocks/convex';
import { renderWithProviders } from '../render';
import { Navigation } from '../../components/layout/Navigation';
import { mockAdminUser, mockModeratorUser } from '../fixtures';

beforeEach(() => {
  convexMock.reset();
  // The unread badge is a live query. Unregistered it would simply read as
  // "not loaded yet", which is a state the nav has to render anyway — but
  // pinning it keeps these tests about which links appear for which role.
  convexMock.onQuery('notifications.unreadCount', () => 0);
  convexMock.echoSession();
  vi.clearAllMocks();
});

describe('Navigation', () => {
  it('does not show Admin link for intern users', () => {
    renderWithProviders(<Navigation />);
    expect(screen.queryByRole('link', { name: /admin/i })).not.toBeInTheDocument();
  });

  it('shows Admin link for admin users', () => {
    renderWithProviders(<Navigation />, { user: mockAdminUser });
    expect(screen.getByRole('link', { name: /admin/i })).toBeInTheDocument();
  });

  it('shows Review Submissions link in profile menu for moderators', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Navigation />, { user: mockModeratorUser });

    // Open the profile dropdown
    await act(async () => {
      await user.click(screen.getByRole('button', { name: /user profile menu/i }));
    });

    expect(screen.getByRole('link', { name: /review submissions/i })).toBeInTheDocument();
  });

  it('shows common nav items for all authenticated users', () => {
    renderWithProviders(<Navigation />);
    expect(screen.getByRole('link', { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /tasks/i })).toBeInTheDocument();
  });
});
