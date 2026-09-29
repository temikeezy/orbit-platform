import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { convexMock } from '../mocks/convex';
import { ErrorReportsPage } from '../../pages/admin/ErrorReportsPage';
import { mockAdminUser, seedLocalStorage } from '../fixtures';

vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

/**
 * The admin error-reports screen.
 *
 * What is pinned here, and why:
 *
 * 1. Server order is never re-sorted client-side. "Newest first" is the
 *    backend's `by_time` / `by_status_and_time` index; a client-side sort
 *    (e.g. by occurrence count) would silently undo that the next time
 *    someone "improves" this file.
 * 2. A caught exception and a human report do not render as the same row —
 *    a stack trace and a person's sentence are different kinds of evidence.
 * 3. Status changes go through `errorReports.setStatus` with the reportId and
 *    status the admin actually chose in the UI, and a server refusal is
 *    reported rather than swallowed as a success.
 */

const caughtReport = {
  id: 'err-caught-1',
  source: 'caught',
  message: 'TypeError: cannot read properties of undefined',
  stack:
    'TypeError: cannot read properties of undefined\n    at loadTask (TaskDetailPage.tsx:42)\n    at commitRender (react-dom.js:100)',
  path: '/tasks/123',
  context: 'TaskDetailPage.load',
  note: undefined as string | undefined,
  userEmail: undefined as string | undefined,
  status: 'open' as const,
  occurrences: 55,
  lastSeenAt: Date.parse('2026-08-20T10:00:00.000Z'),
  createdAt: Date.parse('2026-08-01T10:00:00.000Z'),
};

const reportedReport = {
  id: 'err-reported-1',
  source: 'reported',
  message: 'Submit button does nothing',
  stack: undefined as string | undefined,
  path: '/tasks/456',
  context: undefined as string | undefined,
  note: 'I tried to submit my task and the page did nothing.',
  userEmail: 'intern@test.com',
  status: 'open' as const,
  occurrences: 1,
  lastSeenAt: Date.parse('2026-08-21T09:00:00.000Z'),
  createdAt: Date.parse('2026-08-21T09:00:00.000Z'),
};

beforeEach(() => {
  localStorage.clear();
  convexMock.reset();
  vi.clearAllMocks();
  seedLocalStorage(mockAdminUser, 'admin-tok');
  convexMock.echoSession();
});

describe('ErrorReportsPage', () => {
  it('lists reports in server order with the occurrence count shown prominently', async () => {
    convexMock.onQuery('errorReports.list', () => [caughtReport, reportedReport]);

    render(<ErrorReportsPage />);

    expect(await screen.findByText(caughtReport.message)).toBeInTheDocument();
    expect(screen.getByText(reportedReport.message)).toBeInTheDocument();
    expect(screen.getByText('55')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();

    // Rendered in the order the server returned them, not re-sorted by count.
    const bodyText = document.body.textContent ?? '';
    expect(bodyText.indexOf(caughtReport.message)).toBeLessThan(bodyText.indexOf(reportedReport.message));
  });

  it('distinguishes an automatic capture from a human report on the card itself', async () => {
    convexMock.onQuery('errorReports.list', () => [caughtReport, reportedReport]);

    render(<ErrorReportsPage />);
    await screen.findByText(caughtReport.message);

    expect(screen.getByText('Automatic')).toBeInTheDocument();
    expect(screen.getByText('Reported')).toBeInTheDocument();
    // The person's own words preview for the reported one...
    expect(screen.getByText(/I tried to submit my task/)).toBeInTheDocument();
    // ...and a stack frame previews for the automatic capture — not the
    // headline repeated, which would be the trace's first line.
    expect(screen.getByText(/at loadTask/)).toBeInTheDocument();
  });

  it('re-fetches from the server when the status filter changes', async () => {
    const calls: Record<string, unknown>[] = [];
    convexMock.onQuery('errorReports.list', (args) => {
      calls.push(args);
      return [];
    });

    render(<ErrorReportsPage />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].status).toBeUndefined();

    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'resolved');

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].status).toBe('resolved');
  });

  it('filters by source on the client, with no extra fetch', async () => {
    const calls: Record<string, unknown>[] = [];
    convexMock.onQuery('errorReports.list', (args) => {
      calls.push(args);
      return [caughtReport, reportedReport];
    });

    render(<ErrorReportsPage />);
    await screen.findByText(caughtReport.message);

    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by source' }), 'reported');

    expect(screen.queryByText(caughtReport.message)).not.toBeInTheDocument();
    expect(screen.getByText(reportedReport.message)).toBeInTheDocument();
    // Source has no server-side filter on `errorReports.list` — this must not
    // trigger a second request.
    expect(calls).toHaveLength(1);
  });

  it("shows the reporter's note in the detail view, and no stack trace section when there is none", async () => {
    convexMock.onQuery('errorReports.list', () => [reportedReport]);

    render(<ErrorReportsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /view details/i }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(reportedReport.note)).toBeInTheDocument();
    expect(within(dialog).getByText(reportedReport.userEmail)).toBeInTheDocument();
    expect(within(dialog).queryByText('Stack trace')).not.toBeInTheDocument();
  });

  it('shows the stack trace for a caught error, and no reporter-note section', async () => {
    convexMock.onQuery('errorReports.list', () => [caughtReport]);

    render(<ErrorReportsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /view details/i }));

    const dialog = screen.getByRole('dialog');
    // `getByText`'s default normalizer collapses the trace's newlines, so the
    // <pre> is checked directly rather than matched as a single text string.
    expect(dialog.querySelector('pre')?.textContent).toBe(caughtReport.stack);
    expect(within(dialog).queryByText(/reporter.s note/i)).not.toBeInTheDocument();
    // No signed-in reporter on a caught, pre-login capture.
    expect(within(dialog).getByText('Signed out')).toBeInTheDocument();
  });

  it('changes status through setStatus with the report id and the chosen status, and reflects it immediately', async () => {
    const sent: Record<string, unknown>[] = [];
    let listCalls = 0;
    convexMock.onQuery('errorReports.list', () => {
      listCalls++;
      return [caughtReport];
    });
    convexMock.onMutation('errorReports.setStatus', (args) => {
      sent.push(args);
      return { success: true };
    });

    render(<ErrorReportsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /view details/i }));
    await user.click(screen.getByRole('button', { name: 'Resolve' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ reportId: caughtReport.id, status: 'resolved' });
    expect(toast.success).toHaveBeenCalled();

    // The open modal reflects the new status without waiting on the reload.
    await waitFor(() =>
      expect(within(screen.getByRole('dialog')).getByText('Resolved')).toBeInTheDocument(),
    );
    // The list is asked again, so a status-filtered view stays correct once closed.
    await waitFor(() => expect(listCalls).toBe(2));
  });

  it('surfaces a server refusal instead of reporting success', async () => {
    convexMock.onQuery('errorReports.list', () => [caughtReport]);
    convexMock.onMutation('errorReports.setStatus', () => ({
      success: false,
      error: 'Report not found',
    }));

    render(<ErrorReportsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /view details/i }));
    await user.click(screen.getByRole('button', { name: 'Resolve' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Report not found'));
  });
});
