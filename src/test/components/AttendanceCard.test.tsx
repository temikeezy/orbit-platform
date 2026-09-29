import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { convexMock } from '../mocks/convex';
import { AttendanceCard } from '../../components/logbook/AttendanceCard';
import { mockInternUser, seedLocalStorage } from '../fixtures';
import { todayLocalISO } from '../../lib/utils/date';
import { OrbitInternProfile } from '../../types/database';

/**
 * Attendance, from the intern's side.
 *
 * The reason this component gets its own tests is the bug it sat on top of.
 * Check-in, check-out and a supervisor's verification all went through ONE RPC
 * distinguished by a string the caller chose, and the dispatcher decided which
 * was which by looking at a field no caller sent. Every supervisor action fell
 * through to the intern check-in branch and recorded attendance against the
 * SUPERVISOR, with a success toast.
 *
 * So what is asserted here is not "a request was made" but WHICH mutation each
 * press reaches, and with what.
 */

// The card windows "today" by the LOCAL calendar date, so the fixture must be
// dated the same way — dated with the UTC slice, these records fell outside
// the card's today-window between 00:00 and 00:59 WAT and the check-out tests
// flaked in exactly that hour.
const today = todayLocalISO();

const profile = {
  id: 'profile-1',
  user_id: mockInternUser.id,
  cohort_id: 'cohort-1',
  participation_mode: 'hybrid',
} as OrbitInternProfile;

const record = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  attendanceDate: today,
  expectedMode: 'physical',
  status: 'present',
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  convexMock.reset();
  vi.clearAllMocks();
  seedLocalStorage(mockInternUser, 'intern-tok');
  convexMock.echoSession();
});

describe('AttendanceCard', () => {
  it('offers check-in when there is no record for today', async () => {
    convexMock.onQuery('logbook.listAttendance', () => []);

    render(<AttendanceCard profile={profile} />);

    expect(await screen.findByRole('button', { name: /check in/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /check out/i })).not.toBeInTheDocument();
  });

  it('sends checkIn: true, and never a status the client chose', async () => {
    const user = userEvent.setup();
    const sent: Record<string, unknown>[] = [];

    convexMock.onQuery('logbook.listAttendance', () => []);
    convexMock.onMutation('logbook.recordAttendance', (args) => {
      sent.push(args);
      return { success: true, id: 'a1' };
    });

    render(<AttendanceCard profile={profile} />);
    await user.click(await screen.findByRole('button', { name: /check in/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].checkIn).toBe(true);
    // 'present' was a value the client used to write. An intern who can write
    // their own status can write 'verified'.
    expect(sent[0]).not.toHaveProperty('status');
  });

  it('offers check-out once checked in, and carries the activity summary', async () => {
    const user = userEvent.setup();
    const sent: Record<string, unknown>[] = [];

    convexMock.onQuery('logbook.listAttendance', () => [
      record({ checkInTime: Date.now() - 3_600_000 }),
    ]);
    convexMock.onMutation('logbook.recordAttendance', (args) => {
      sent.push(args);
      return { success: true, id: 'a1' };
    });

    render(<AttendanceCard profile={profile} />);

    await user.type(
      await screen.findByPlaceholderText('Brief summary of what you did today...'),
      'Worked with the media team',
    );
    await user.click(screen.getByRole('button', { name: /check out/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].checkOut).toBe(true);
    expect(sent[0].activitySummary).toBe('Worked with the media team');
    // Explicitly false rather than omitted. Check-out is an UPDATE to the
    // morning's row, and stating both flags on every call is what lets the
    // server tell the two apart without inferring it from which fields happen
    // to be present — the inference that sent supervisor verifications down the
    // intern's own check-in path.
    expect(sent[0].checkIn).toBe(false);
  });

  it('shows the day as done once both times are recorded', async () => {
    convexMock.onQuery('logbook.listAttendance', () => [
      record({ checkInTime: Date.now() - 7_200_000, checkOutTime: Date.now() }),
    ]);

    render(<AttendanceCard profile={profile} />);

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /check in/i })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /check out/i })).not.toBeInTheDocument();
  });

  it('surfaces a refusal rather than reporting success', async () => {
    const user = userEvent.setup();

    convexMock.onQuery('logbook.listAttendance', () => []);
    convexMock.onMutation('logbook.recordAttendance', () => ({
      success: false,
      error: 'Attendance can only be recorded for today',
    }));

    render(<AttendanceCard profile={profile} />);
    await user.click(await screen.findByRole('button', { name: /check in/i }));

    // The button must come back, not settle into a checked-in state the server
    // never agreed to. Optimism here is how someone believes they are marked
    // present when they are not.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /check in/i })).toBeInTheDocument(),
    );
  });
});
