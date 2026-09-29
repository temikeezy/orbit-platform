import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { convexMock } from '../mocks/convex';
import { renderWithProviders } from '../render';
import { useAuth } from '../../contexts/AuthContext';
import { mockInternUser, mockAdminUser } from '../fixtures';

// A test component that displays auth state
function AuthDisplay() {
  const { user, isAdmin, isMember, isStreamLead, isAuthenticated, logout } = useAuth();
  return (
    <div>
      <span data-testid="user-name">{user?.full_name || 'none'}</span>
      <span data-testid="is-admin">{String(isAdmin)}</span>
      <span data-testid="is-member">{String(isMember)}</span>
      <span data-testid="is-stream-lead">{String(isStreamLead)}</span>
      <span data-testid="is-authenticated">{String(isAuthenticated)}</span>
      <button onClick={logout}>Logout</button>
    </div>
  );
}


beforeEach(() => {
  localStorage.clear();
  convexMock.reset();
  // Sign-in is an httpAction, so the route is what needs mocking — the limiter
  // keys on the caller's IP, which only a request carries.
  convexMock.installFetch();
  vi.clearAllMocks();
  convexMock.echoSession();
});

describe('AuthContext', () => {
  it('sets isAuthenticated=false when no user in localStorage', () => {
    renderWithProviders(<AuthDisplay />, { user: null });
    expect(screen.getByTestId('is-authenticated')).toHaveTextContent('false');
    expect(screen.getByTestId('user-name')).toHaveTextContent('none');
  });

  it('populates user and role flags for intern user', () => {
    renderWithProviders(<AuthDisplay />);
    expect(screen.getByTestId('user-name')).toHaveTextContent(mockInternUser.full_name);
    expect(screen.getByTestId('is-member')).toHaveTextContent('true');
    expect(screen.getByTestId('is-admin')).toHaveTextContent('false');
    expect(screen.getByTestId('is-stream-lead')).toHaveTextContent('false');
  });

  it('shows isAdmin=true for admin user', () => {
    renderWithProviders(<AuthDisplay />, { user: mockAdminUser });
    expect(screen.getByTestId('is-admin')).toHaveTextContent('true');
    expect(screen.getByTestId('is-member')).toHaveTextContent('false');
  });

  it('clears state after logout()', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AuthDisplay />);

    expect(screen.getByTestId('user-name')).toHaveTextContent(mockInternUser.full_name);

    await act(async () => {
      await user.click(screen.getByRole('button', { name: /logout/i }));
    });

    expect(screen.getByTestId('user-name')).toHaveTextContent('none');
    expect(screen.getByTestId('is-authenticated')).toHaveTextContent('false');
  });

  it('role flags update reactively after login()', async () => {
    // Start with no user
    const LoginTrigger = () => {
      const { login, isAdmin, user } = useAuth();
      return (
        <div>
          <span data-testid="is-admin">{String(isAdmin)}</span>
          <span data-testid="user">{user?.full_name || 'none'}</span>
          <button onClick={() => login('admin@test.com', 'pass')}>Login as admin</button>
        </div>
      );
    };

    convexMock.onRoute('/auth/login', () => ({
      success: true,
      token: 'tok',
      user: {
        id: mockAdminUser.id,
        email: mockAdminUser.email,
        fullName: mockAdminUser.full_name,
        profileSlug: 'admin',
        roles: mockAdminUser.roles,
        totalPoints: mockAdminUser.total_points,
        currentLevel: mockAdminUser.current_level,
        isActive: true,
        createdAt: 1_700_000_000_000,
      },
    }));

    renderWithProviders(<LoginTrigger />, { user: null });
    expect(screen.getByTestId('is-admin')).toHaveTextContent('false');

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: /login as admin/i }));
    });

    expect(screen.getByTestId('is-admin')).toHaveTextContent('true');
    expect(screen.getByTestId('user')).toHaveTextContent(mockAdminUser.full_name);
  });
});
