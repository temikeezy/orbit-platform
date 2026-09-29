import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { convexMock } from '../mocks/convex';
import { renderWithProviders } from '../render';
import { LoginPage } from '../../components/auth/LoginPage';

beforeEach(() => {
  localStorage.clear();
  convexMock.reset();
  // Both sign-in paths are httpActions rather than mutations: rate limiting
  // keys on the caller's IP, and only a request carries one.
  convexMock.installFetch();
  vi.clearAllMocks();
  // AuthProvider revalidates a cached session on mount. LoginPage renders with
  // no user, but the provider is mounted either way.
  convexMock.onQuery('auth.me', () => null);
  convexMock.onMutation('auth.logout', () => ({ success: true }));
});

describe('LoginPage', () => {
  it('renders email and password fields', () => {
    renderWithProviders(<LoginPage />, { user: null });
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    // Primary submit button is of type="submit"
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
  });

  it('posts the entered credentials to the login route', async () => {
    let received: Record<string, unknown> = {};
    convexMock.onRoute('/auth/login', (body) => {
      received = body;
      return { success: false, error: 'Invalid credentials' };
    });
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />, { user: null });

    await user.type(screen.getByLabelText(/email/i), 'test@test.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');

    await act(async () => {
      // Use the form submit button specifically
      const submitBtn = screen.getByRole('button', { name: /^sign in$/i });
      await user.click(submitBtn);
    });

    expect(received.email).toBe('test@test.com');
    expect(received.password).toBe('password123');
  });

  it('displays error message on failed login', async () => {
    convexMock.onRoute('/auth/login', () => ({
      success: false,
      error: 'Invalid credentials',
    }));
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />, { user: null });

    await user.type(screen.getByLabelText(/email/i), 'bad@test.com');
    await user.type(screen.getByLabelText(/password/i), 'wrongpass');

    await act(async () => {
      await user.click(screen.getByRole('button', { name: /^sign in$/i }));
    });

    expect(screen.getByText(/invalid credentials/i)).toBeInTheDocument();
  });

  it('toggles to magic link form when "send me a magic link" is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />, { user: null });

    await user.click(screen.getByRole('button', { name: /magic link/i }));

    expect(screen.getByRole('button', { name: /send magic link/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it('calls the magic-link route and shows confirmation', async () => {
    convexMock.onRoute('/auth/magic-link', () => ({ success: true }));
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />, { user: null });

    await user.click(screen.getByRole('button', { name: /magic link/i }));
    await user.type(screen.getByLabelText(/email/i), 'user@test.com');

    await act(async () => {
      await user.click(screen.getByRole('button', { name: /send magic link/i }));
    });

    expect(screen.getByText(/check your email/i)).toBeInTheDocument();
  });

  it('shows the Zoho sign-in button for staff', () => {
    renderWithProviders(<LoginPage />, { user: null });
    expect(
      screen.getByRole('button', { name: /sign in with zoho/i }),
    ).toBeInTheDocument();
  });
});
