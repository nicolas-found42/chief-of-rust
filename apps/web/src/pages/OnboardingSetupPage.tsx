import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { errorMessage } from "../client";
import { migrationApi, type MigrationStatus } from "../clients/workspace";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/**
 * Post-cutover onboarding (spec: Migration and Cutover, step 7): the steps the
 * workspace owner completes to make the clean Workspace usable, read live from
 * the status aggregator so a step finished in Settings — usually in another
 * tab — flips here without a manual reload.
 */
export function OnboardingSetupPage() {
  useTitle("Set up your workspace");
  const focusRef = usePageFocus<HTMLHeadingElement>();
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await migrationApi.status());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    /* Steps are completed in Settings, in this tab or another, so the list
       keeps polling while the page is open (WCAG 2.2.2 is not in play: the
       page is static, only its state text moves). */
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="page">
      <h1 ref={focusRef} tabIndex={-1}>
        Set up your workspace
      </h1>
      <p className="muted">
        The migration preserved your provider credentials and removed everything else. Work through
        these steps to make the workspace usable again.
      </p>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      {status === null ? (
        <p className="muted">Loading…</p>
      ) : status.onboarding.complete ? (
        <>
          <p className="banner banner-ok" role="status">
            Onboarding complete
          </p>
          <p>
            <Link to="/" className="action-button">
              Go to Home
            </Link>
          </p>
        </>
      ) : (
        <section className="card">
          <h2>Steps</h2>
          <ul className="setup-check-list">
            {status.onboarding.steps.map((step) => (
              <li key={step.id}>
                <Link to={step.href}>{step.label}</Link>{" "}
                <span className={step.done ? "ok" : "muted"}>{step.done ? "Done" : "To do"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
