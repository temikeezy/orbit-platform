import { describe, it, expect, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { convexMock } from '../mocks/convex';
import { renderWithProviders } from '../render';
import { ProtectedRoute } from '../../components/auth/ProtectedRoute';
import { mockAdminUser } from '../fixtures';

beforeEach(() => {
  convexMock.reset();
  // AuthProvider revalidates on mount and signs out if the server rejects the
  // session, so without this every seeded user is gone before the assertion.
  convexMock.echoSession();
});

describe('ProtectedRoute', () => {
  it('renders LoginPage when user is not authenticated', () => {
    renderWithProviders(
      <ProtectedRoute>
        <div>Secret content</div>
      </ProtectedRoute>,
      { user: null }
    );
    // Should show the login form, not the protected content
    expect(screen.queryByText('Secret content')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
  });

  it('renders children when user is authenticated', () => {
    renderWithProviders(
      <ProtectedRoute>
        <div>Secret content</div>
      </ProtectedRoute>
    );
    expect(screen.getByText('Secret content')).toBeInTheDocument();
  });

  // Awaited, because refusal now waits for the session check to land. The
  // cached roles this renders from can be a snapshot taken before a promotion,
  // so denying on them told a freshly promoted admin they had no permission.
  // The wait is bounded: the flag is set in a `finally`, so a rejected refresh
  // releases it too.
  it('renders access denied when user lacks required role', async () => {
    renderWithProviders(
      <ProtectedRoute allowedRoles={['admin']}>
        <div>Admin only</div>
      </ProtectedRoute>
      // Default user is intern
    );
    expect(await screen.findByText(/access denied/i)).toBeInTheDocument();
    expect(screen.queryByText('Admin only')).not.toBeInTheDocument();
  });

  it('does not refuse an allowed role while the session is still settling', async () => {
    // The other half of the same rule: an ALLOWED user must not be made to wait
    // behind the revalidation, or every guarded route would flash a spinner on
    // each load. Only the deny branch pays.
    renderWithProviders(
      <ProtectedRoute allowedRoles={['admin']}>
        <div>Admin panel</div>
      </ProtectedRoute>,
      { user: mockAdminUser }
    );
    expect(screen.getByText('Admin panel')).toBeInTheDocument();
  });

  it('renders children when user has the required role', () => {
    renderWithProviders(
      <ProtectedRoute allowedRoles={['admin']}>
        <div>Admin panel</div>
      </ProtectedRoute>,
      { user: mockAdminUser }
    );
    expect(screen.getByText('Admin panel')).toBeInTheDocument();
  });
});
