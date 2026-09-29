import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Circle, ArrowRight, Sparkles } from 'lucide-react';
import { onboardingApi, type OnboardingStatus } from '../../lib/api/onboarding';

/**
 * "First steps" — the two things a new intern does, shown as tasks.
 *
 * WHY THESE ARE NOT `tasks` ROWS. They look like tasks and behave like tasks
 * from the member's side, but nothing is written when one completes: a step is
 * done because `passwordHash` exists or `orientationReadAt` is set. Deriving
 * rather than recording is what makes them mark themselves complete the instant
 * the member acts, and correct for anyone who acted before this shipped.
 *
 * Real rows would have cost more than they returned:
 *
 *  - `reviewSubmission` runs `badges.checkAndAward` on EVERY approval, scored or
 *    not, and the badge measures count approved submissions directly. Two
 *    auto-approved zero-point rows would still advance three measures, and badge
 *    bonuses write real points — so the leaderboard is distorted even at nil
 *    points.
 *  - `tasks.deadline` is required, and the task list paints anything past it
 *    "Overdue" in red. There is no deadline by which someone must have chosen a
 *    password, and inventing one manufactures a failure.
 *  - `tasks.streamId` is required too, while onboarding belongs to no stream —
 *    and an intern whose placement was skipped has no stream at all.
 *
 * Deliberately excluded from the filter counts below them: those enumerate real
 * submission states, and a virtual card claiming to be "Completed" would not
 * reconcile against the review dashboard.
 *
 * The sign-in step is not shown. It is already done by definition — you cannot
 * read this without a session — so listing it is noise.
 */
export function FirstStepsTasks() {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    onboardingApi
      .status()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        // Silent: this sits above the member's real task list, and an error
        // banner for a two-item helper would be louder than the helper.
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Nothing for staff, and nothing once it is finished — a permanently-present
  // "you have done everything" panel is furniture.
  if (!status || !status.applicable || status.complete) return null;

  const steps = status.steps.filter((s) => s.key !== 'signIn');
  if (steps.length === 0) return null;

  const remaining = steps.filter((s) => !s.done).length;

  return (
    <section aria-labelledby="first-steps-heading" className="mb-8">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2
          id="first-steps-heading"
          className="text-lg font-semibold text-orbit-ink flex items-center gap-2"
        >
          <Sparkles className="w-4 h-4 text-iih-green" aria-hidden />
          First steps
        </h2>
        <span className="text-sm text-orbit-muted">
          {remaining} to go
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {steps.map((step) => {
          const card = (
            <div
              className={`h-full rounded-xl border p-4 transition-colors ${
                step.done
                  ? 'border-green-200 bg-green-50'
                  : 'border-slate-200 bg-white hover:border-iih-green'
              }`}
            >
              <div className="flex items-start gap-3">
                {step.done ? (
                  <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5 text-green-600" aria-hidden />
                ) : (
                  <Circle className="w-5 h-5 shrink-0 mt-0.5 text-slate-300" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <p
                    className={
                      step.done
                        ? 'font-medium text-orbit-muted line-through'
                        : 'font-medium text-orbit-ink'
                    }
                  >
                    {step.title}
                  </p>
                  <p className="text-sm text-orbit-muted mt-0.5">{step.description}</p>

                  {/*
                    Where a real task card shows a deadline. Saying so removes
                    the obvious question — there is nothing to submit and nobody
                    reviews it, so a member could reasonably wonder how it ever
                    gets ticked off.
                  */}
                  <p className="text-xs text-orbit-muted mt-2">
                    {step.done ? 'Done' : 'Completes on its own — nothing to submit'}
                  </p>
                </div>
                {!step.done && step.href && (
                  <ArrowRight className="w-4 h-4 shrink-0 mt-1 text-orbit-muted" aria-hidden />
                )}
              </div>
            </div>
          );

          return step.done || !step.href ? (
            <div key={step.key}>{card}</div>
          ) : (
            <Link key={step.key} to={step.href} className="block">
              {card}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
