import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Circle, ArrowRight } from 'lucide-react';
import { onboardingApi, type OnboardingStatus } from '../../lib/api/onboarding';

/**
 * "Your first steps" — the new-member checklist on the home page.
 *
 * Renders NOTHING once every step is done, and nothing at all for staff. A
 * checklist that stays on screen after it is finished becomes furniture, and
 * this one has a natural end: three items, all reachable in a couple of
 * minutes. Week 1 has no real tasks in it, so for a new intern this is the
 * whole of what the platform is asking them to do.
 *
 * Failures are silent. This sits above the feed on the busiest page in the app,
 * and an error banner for a checklist would be louder than the checklist —
 * if the query fails the member simply sees the page they came for.
 */
export function OnboardingChecklist() {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    onboardingApi
      .status()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status || !status.applicable || status.complete) return null;

  const remaining = status.steps.filter((s) => !s.done).length;

  return (
    <section
      aria-labelledby="onboarding-heading"
      className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-orbit-sm"
    >
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <h2 id="onboarding-heading" className="text-lg font-semibold text-orbit-ink">
          Your first steps
        </h2>
        <span className="text-sm text-orbit-muted">
          {remaining} left
        </span>
      </div>

      <ul className="space-y-3">
        {status.steps.map((step) => {
          const body = (
            <div className="flex items-start gap-3">
              {step.done ? (
                <Check
                  className="h-5 w-5 shrink-0 mt-0.5 text-green-600"
                  strokeWidth={2.5}
                  aria-hidden
                />
              ) : (
                <Circle
                  className="h-5 w-5 shrink-0 mt-0.5 text-slate-300"
                  strokeWidth={2}
                  aria-hidden
                />
              )}
              <div className="min-w-0">
                <p
                  className={
                    step.done
                      ? 'font-medium text-orbit-muted line-through'
                      : 'font-medium text-orbit-ink'
                  }
                >
                  {step.title}
                </p>
                <p className="text-sm text-orbit-muted">{step.description}</p>
              </div>
              {!step.done && step.href && (
                <ArrowRight
                  className="h-4 w-4 shrink-0 mt-1 ml-auto text-orbit-muted"
                  aria-hidden
                />
              )}
            </div>
          );

          return (
            <li key={step.key}>
              {step.done || !step.href ? (
                <div className="p-2">{body}</div>
              ) : (
                <Link
                  to={step.href}
                  className="block rounded-lg p-2 hover:bg-slate-50 transition-colors"
                >
                  {body}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
