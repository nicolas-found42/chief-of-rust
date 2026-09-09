import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { RunDetail } from "@chief-of-staff-demo/shared";
import { IntakeBadge, StatusPill } from "../components/StatusPill";
import {
  buildTimeline,
  failurePresentation,
  formatDuration,
  formatTime,
  stageLabel,
} from "../display";
import { runsApi } from "../clients/workspace";
import { errorMessage } from "../client";
import { useIsLoadedEntry } from "../usePageFocus";
import { useGoogleConnection } from "../useGoogleConnection";
import { useModule, useModuleLabel } from "../useModules";
import { useTitle } from "../useTitle";

const ACTIVE = new Set(["pending", "running"]);

/**
 * One Run, in two halves. The Shell renders status, Stages, attempts, the event
 * timeline, the Run's own files and the line the Module wrote — identically for
 * every Module, so the shape of a Run is something learned once. The Module
 * contributes a result view, looked up by its identity beside the Shell's
 * Module list; a Module that contributes none still gets everything above,
 * which is what a first phase needs.
 */
export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const loadedEntry = useIsLoadedEntry();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const moduleLabel = useModuleLabel();
  const { status: googleStatus } = useGoogleConnection();
  const owner = useModule(detail?.module);

  useTitle(detail?.fileName ?? "Run");
  const load = useCallback(async () => {
    if (!id) {
      return;
    }
    try {
      const next = await runsApi.getRun(id);
      setDetail(next);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!detail || !ACTIVE.has(detail.status)) {
      return;
    }
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [detail, load]);

  // Arriving at a run moves focus to its heading, so keyboard users continue
  // from the new page instead of the top of the document (2.4.3). The ref
  // guard keeps the 3s poll from stealing focus back on every refresh.
  //
  // The entry the browser loaded is exempt, for the reason usePageFocus gives:
  // focus already sits above the skip link there, and moving it down to the
  // heading puts the skip link, both nav links and "All runs" permanently
  // behind the user. This is the app's most bookmarked and most shared route,
  // so that is the load path it matters most on.
  const focusedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!detail || !id || focusedFor.current === id) {
      return;
    }
    focusedFor.current = id;
    if (!loadedEntry) {
      headingRef.current?.focus();
    }
  }, [detail, id, loadedEntry]);

  const retry = async () => {
    if (!id || retrying) {
      return;
    }
    setRetrying(true);
    try {
      await runsApi.retry(id);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRetrying(false);
      setRetryCount((count) => count + 1);
    }
  };

  // The Retry button lives inside the failure banner, which unmounts as soon as
  // the run leaves `failed` — and the whole view is replaced if the retry threw.
  // Either way focus would be left on <body>. This runs after the commit, when
  // the ref reflects whether the button actually survived (WCAG 2.4.3).
  useEffect(() => {
    if (retryCount === 0) {
      return;
    }
    if (!retryRef.current?.isConnected) {
      headingRef.current?.focus();
    }
  }, [retryCount]);

  // Every branch carries headingRef so focus always has somewhere to land, no
  // matter which view a failed action leaves behind. Only one renders at a time.
  if (error) {
    return (
      <div className="page">
        <h1 ref={headingRef} tabIndex={-1}>
          Run
        </h1>
        <div className="banner banner-error" role="alert">
          {error}
        </div>
        <p>
          <Link to="/runs" className="back-link">
            <span aria-hidden="true">←</span> All runs
          </Link>
        </p>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="page">
        <h1 ref={headingRef} tabIndex={-1}>
          Run
        </h1>
        <p className="muted" role="status">
          Loading…
        </p>
      </div>
    );
  }

  const timeline = buildTimeline(detail.events);
  const completedStages = timeline.filter((entry) => entry.state === "done");
  const failedEntry = timeline.find((entry) => entry.state === "failed");
  /* Which Stages a Module has and in what order is the Module's own (ADR-0003),
     so the Shell says what the timeline saw and never which Stage is missing. */
  const retryable =
    detail.status === "failed" && detail.failedStage !== null && detail.failedStage !== "convert";
  const failure = failurePresentation(detail, googleStatus?.state);
  const ResultView = owner?.resultView ?? null;

  return (
    <div className="page">
      <p>
        <Link to="/runs" className="back-link">
          {/* Decorative: exposed, it is read as "left arrow" before the link
              text, the same reason the ↗ below is hidden (WCAG 1.3.1). */}
          <span aria-hidden="true">←</span> All runs
        </Link>
      </p>
      <h1 className="run-title" ref={headingRef} tabIndex={-1}>
        {detail.fileName ?? detail.id}
      </h1>
      {/* The gap between these items is flex `gap`, which carries no text, and
          JSX strips the newline-only nodes between the elements — so the row
          flattened to "Status: failedupload8/18/2026, 10:20:14 PMattempts: 1".
          Each item now names itself and opens with a comma: a real character
          that cannot be collapsed away like a bare space between flex children
          can, and one that reads as a pause rather than a word (WCAG 1.3.1). */}
      <div className="run-meta">
        <span role="status">
          <span className="visually-hidden">Status: </span>
          <StatusPill status={detail.status} connectionState={detail.connectionState} />
        </span>
        <span className="muted">
          <span className="visually-hidden">, Module: </span>
          {moduleLabel(detail.module)}
        </span>
        <span>
          <span className="visually-hidden">, Source: </span>
          <IntakeBadge intake={detail.intake} />
        </span>
        <span className="muted">
          <span className="visually-hidden">, Created: </span>
          {formatTime(detail.createdAt)}
        </span>
        {detail.sourceUrl && (
          <a href={detail.sourceUrl} target="_blank" rel="noreferrer">
            <span className="visually-hidden">, </span>
            source <span aria-hidden="true">↗</span>
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        )}
        {detail.attempts > 0 && (
          <span className="muted">
            <span className="visually-hidden">, </span>Attempts: {detail.attempts}
          </span>
        )}
        {detail.failedStage && (
          <span className={failure.expectedInterruption ? "muted" : "bad"}>
            <span className="visually-hidden">, </span>
            {failure.stageOutcome} during {stageLabel(detail.failedStage)}
          </span>
        )}
      </div>

      {/* The line the Module wrote when the Run ended. Rendered as given: the
          Shell interprets it nowhere. */}
      {detail.summary && <p className="run-summary">{detail.summary}</p>}

      {detail.status === "failed" && (
        <div className={`banner ${failure.bannerClass}`} role={failure.bannerRole}>
          {/* Impact first (D10): the plain-language cause, then what landed in
              the world versus what did not, then the way out. Retry resumes
              from the failed stage — that semantics already exist; this is
              presentation only. */}
          <div className="failure-impact">
            <p className="failure-cause">{detail.failureHint ?? "This run failed."}</p>
            {completedStages.length > 0 && (
              <p>Already completed: {completedStages.map((entry) => entry.label).join(", ")}.</p>
            )}
            {failedEntry && <p>Not completed: {failedEntry.label} did not finish.</p>}
          </div>
          <div className="field-row">
            {/* aria-disabled, not disabled: a disabled button is blurred and
                dropped from the tab order the moment it is pressed. */}
            {retryable && failure.showRetry && (
              <button
                type="button"
                className="action-button"
                ref={retryRef}
                onClick={() => void retry()}
                aria-disabled={retrying}
              >
                {retrying ? "Retrying…" : "Retry"}
              </button>
            )}
            {failure.showReconnect && (
              <Link to="/settings" className="action-button step-link">
                Reconnect
              </Link>
            )}
          </div>
        </div>
      )}
      {detail.status === "blocked" && detail.wait && (
        <div className="banner banner-warn" role="status">
          <p className="failure-cause">{detail.wait.reason}</p>
          <p>
            {detail.wait.timeout.kind === "none"
              ? "This Run will wait until you act."
              : `This Run will resume after ${formatTime(detail.wait.timeout.at)}.`}
          </p>
        </div>
      )}
      {detail.status === "skipped" && detail.skipReason && (
        <div className="banner banner-warn" role="status">
          {detail.skipReason}
        </div>
      )}

      {/* The default view answers "what did my chief of staff do?" before
          "what did the engine do?" (D8): one entry per Stage, derived at
          render from the append-only log. */}
      {timeline.length > 0 && (
        <>
          <h2>What happened</h2>
          <ol className="timeline" aria-label="Stage timeline">
            {timeline.map((entry) => (
              <li key={entry.stage} className="timeline-row">
                <div className="timeline-head">
                  <span className="timeline-name">{entry.label}</span>
                  <span
                    className={`status-badge ${
                      entry.state === "failed"
                        ? failure.timelineClass
                        : entry.state === "running"
                          ? "status-active"
                          : "status-done"
                    }`}
                  >
                    {entry.state === "failed"
                      ? failure.stageOutcome
                      : entry.state === "running"
                        ? "Running"
                        : "Done"}
                  </span>
                  {entry.durationMs !== null && (
                    <span className="muted">{formatDuration(entry.durationMs)}</span>
                  )}
                </div>
                {entry.failureDetail && (
                  <div className="timeline-diagnostic">
                    <strong>Diagnostic</strong>
                    <pre>{JSON.stringify(entry.failureDetail, null, 2)}</pre>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </>
      )}

      {/* The Module's own half. A Module without one is not shown raw data
          instead: the Shell's half above and the file links below are what a
          first phase needs. */}
      {ResultView ? <ResultView detail={detail} /> : null}

      {/* Everything engine-facing sits one disclosure level down (D8). The
          events log and the Run's files are the record, not a summary of it. */}
      <details className="disclosure">
        <summary>Technical details</summary>
        <div className="disclosure-body">
          <h2 id="events-heading">Events</h2>
          {/* The log prints stage names and raw JSON details. That is what it
              is for, but a region users can navigate into should say so before
              they arrive rather than leave them to work it out from the
              contents. */}
          <p className="muted" id="events-note">
            Diagnostic record of the run, oldest first. Technical detail is shown as raw JSON.
          </p>
          {/* Focusable so the capped-height scroller can be reached and
              scrolled with the keyboard (2.1.1). */}
          <div
            className="events-log"
            tabIndex={0}
            role="region"
            aria-labelledby="events-heading"
            aria-describedby="events-note"
          >
            {detail.events.map((event, index) => (
              <div key={index} className="event-row">
                <span className="muted">{formatTime(event.at)}</span> <strong>{event.type}</strong>
                {event.detail ? (
                  <span className="muted"> {JSON.stringify(event.detail)}</span>
                ) : null}
              </div>
            ))}
          </div>

          {detail.files.length > 0 && (
            <>
              <h2>Files</h2>
              <ul className="run-files">
                {detail.files.map((name) => (
                  <li key={name}>
                    <a
                      href={`/api/runs/${encodeURIComponent(detail.id)}/artifacts/${encodeURIComponent(name)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {name}
                      <span className="visually-hidden"> (opens in a new tab)</span>
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </details>
    </div>
  );
}
