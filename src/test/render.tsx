import { ReactElement } from 'react';
import { render, RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../contexts/AuthContext';
import { mockInternUser, seedLocalStorage } from './fixtures';
import { OrbitUser } from '../types/database';

interface RenderWithProvidersOptions extends RenderOptions {
  user?: OrbitUser | null;
  token?: string;
  initialRoute?: string;
}

export function renderWithProviders(
  ui: ReactElement,
  {
    user = mockInternUser,
    token = 'test-token',
    initialRoute = '/',
    ...renderOptions
  }: RenderWithProvidersOptions = {}
) {
  if (user) {
    seedLocalStorage(user, token);
  }

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initialRoute]}>
        <AuthProvider>{children}</AuthProvider>
      </MemoryRouter>
    );
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions });
}
