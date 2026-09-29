import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from '../../components/common/ErrorBoundary';

/**
 * The last thing between a thrown render and a white screen.
 *
 * Tested in a GENUINE failure state — a child that really throws — rather than
 * by poking the boundary's state. A boundary that only works when its internals
 * are set by hand is not a boundary.
 *
 * This matters more than it looks: the browser smoke matrix asserts that no
 * page reaches this component, and that assertion is only meaningful if this
 * component would actually appear when something breaks.
 */

function Boom({ message = 'kaboom' }: { message?: string }): JSX.Element {
  throw new Error(message);
}

/**
 * Throws while `broken` is true.
 *
 * The flag lives outside the component deliberately: the boundary UNMOUNTS its
 * children when it catches, so there is no instance left to hold the state that
 * decides whether to throw. A useState-based version sets state on a component
 * that no longer exists.
 */
let broken = true;

function Flaky() {
  if (broken) throw new Error('still broken');
  return <p>recovered content</p>;
}

beforeEach(() => {
  // React logs the caught error itself. Silenced so a passing run is not full
  // of red that means nothing.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>ordinary content</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('ordinary content')).toBeInTheDocument();
  });

  it('catches a throwing child and shows the failure state', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it("shows the error's own message rather than a generic one", () => {
    render(
      <ErrorBoundary>
        <Boom message="Cannot read properties of undefined (reading 'charAt')" />
      </ErrorBoundary>,
    );

    // This exact message is what the browser matrix surfaced on every page when
    // a cached user arrived without full_name. A boundary that swallowed it in
    // favour of "An unexpected error occurred" would have made that a much
    // longer hunt.
    expect(
      screen.getByText("Cannot read properties of undefined (reading 'charAt')"),
    ).toBeInTheDocument();
  });

  it('falls back to a generic message when the error has none', () => {
    function Empty(): JSX.Element {
      throw new Error('');
    }

    render(
      <ErrorBoundary>
        <Empty />
      </ErrorBoundary>,
    );

    expect(screen.getByText('An unexpected error occurred.')).toBeInTheDocument();
  });

  it('renders a supplied fallback instead of the default panel', () => {
    render(
      <ErrorBoundary fallback={<p>custom fallback</p>}>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('custom fallback')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('re-renders the children when Try again is pressed', async () => {
    const user = userEvent.setup();
    broken = true;

    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    // The condition that caused the throw goes away, then the user retries.
    // Without clearing the condition first, "Try again" simply throws again —
    // which is correct, and is why this test fixes the child before retrying.
    broken = false;
    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByText('recovered content')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });
});
