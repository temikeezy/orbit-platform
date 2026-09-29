import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { convexMock } from '../mocks/convex';
import { renderWithProviders } from '../render';
import { mockInternUser } from '../fixtures';
import { UserProfilePage } from '../../pages/UserProfilePage';

beforeEach(() => {
  localStorage.clear();
  convexMock.reset();
  vi.clearAllMocks();
  convexMock.echoSession();
  convexMock.onQuery('levels.list', () => []);
});

describe('UserProfilePage information', () => {
  it('omits unavailable contact rows without hiding joined information', async () => {
    convexMock.onQuery('users.getById', () => ({
      id: mockInternUser.id,
      fullName: mockInternUser.full_name,
      profileSlug: 'hidden-contact-details',
      roles: ['intern'],
      totalPoints: 0,
      currentLevel: 1,
      isActive: true,
      createdAt: Date.UTC(2025, 0, 15),
    }));

    const { container } = renderWithProviders(<UserProfilePage />);

    expect(await screen.findByText('Information')).toBeInTheDocument();
    expect(container.querySelector('.lucide-mail')).not.toBeInTheDocument();
    expect(container.querySelector('.lucide-map-pin')).not.toBeInTheDocument();
    expect(screen.getByText(/Joined/)).toBeInTheDocument();
  });
});
