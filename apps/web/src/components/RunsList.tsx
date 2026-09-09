import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { RUNS_PAGE_SIZE, type RunSummary } from "@chief-of-staff-demo/shared";
import { IntakeBadge, StatusPill } from "./StatusPill";
import { formatTime, relativeTime, runTitle } from "../display";
import { runsApi } from "../clients/workspace";
import { errorMessage } from "../client";
import { useGoogleConnection } from "../useGoogleConnection";
import { useModuleLabel } from "../useModules";

const ACTIVE = new Set(["pending", "running"]);

export interface RunsListProps {
  /**
   * Only this Module's Runs, which also decides the columns. A Module's own
   * page implies whose Runs these are and shows the Intake that started each;
   * the cross-Module list names the Module instead and drops the Intake, whose
   * name is a Module's private vocabulary (ADR-0019).
   */
  module?: string;
  /** What to say when there is nothing to list. */
  empty: React.ReactNode;
  /** Refreshed on the same tick as the list, for a page with a line of its own. */
  onRefresh?: () => void;
}

/**
 * The Runs list: newest first, paged, filtered to one Module or across all of
 * them. `/runs` and each Module's page render this same component — what they
 * share is the list, not the page, so each keeps its own chrome and neither can
 * disagree with the other about what a Run's row says.
 */
export function RunsList({ module, empty, onRefresh }: RunsListProps) {
  const showModule = module === undefined;
  const navigate = useNavigate();
  /* Where the row's press started, so the click can tell a tap from a drag
     that was selecting text. */
  const press = useRef<{ x: number; y: number } | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [liveReady, setLiveReady] = useState(false);
  const moduleLabel = useModuleLabel();
  /* The connection is the Shell's, and its banner renders above this page
     (ADR-0011). All this list owes it is a refresh on the tick below, since the
     poll here is live in the one window where a Run can reject a grant. */
  const { refresh: refreshConnection } = useGoogleConnection();

  /* Re-reads the first page only: a refresh must not silently discard the
     older pages the reader asked for, nor claim to have re-checked them. */
  const refresh = useCallback(async () => {
    try {
      const page = await runsApi.listRuns({ ...(module ? { module } : {}), limit: RUNS_PAGE_SIZE });
      setRuns((current) => {
        if (current === null || current.length <= page.runs.length) {
          return page.runs;
        }
        /* Keep everything already loaded below the first page, replacing the
           rows the fresh page covers. */
        const fresh = new Set(page.runs.map((run) => run.id));
        return [...page.runs, ...current.filter((run) => !fresh.has(run.id))];
      });
      setCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
    onRefresh?.();
  }, [module, onRefresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeCount = runs === null ? 0 : runs.filter((run) => ACTIVE.has(run.status)).length;

  // The list used to auto-update every 3s for as long as it was open, with no
  // way to pause or stop it and nothing to show for it once every run was
  // terminal (WCAG 2.2.2). The interval now exists only while a run can still
  // change, which is what RunDetailPage already does.
  //
  // activeCount is a number, not the array, so a poll that changes nothing does
  // not tear down and rebuild its own interval.
  useEffect(() => {
    if (activeCount === 0) return;
    const id = setInterval(() => {
      void refresh();
      void refreshConnection();
    }, 3000);
    return () => clearInterval(id);
  }, [activeCount, refresh, refreshConnection]);

  // A live region only announces what arrives after it is mounted; text already
  // present on the first paint is skipped (WCAG 4.1.3). This effect runs after
  // that paint, so the status below is filled in as a change rather than as
  // initial content.
  useEffect(() => {
    setLiveReady(true);
  }, []);

  // Runs arrive from a Module's Intake, not from this tab. Stopping the poll
  // without this would mean an idle list could never show them; it is also the
  // recovery path when the request that would have restarted the poll is the one
  // that failed.
  const check = async () => {
    if (checking) {
      return;
    }
    setChecking(true);
    try {
      await refresh();
    } finally {
      setChecking(false);
    }
  };

  const showMore = async () => {
    if (loadingMore || cursor === null) {
      return;
    }
    setLoadingMore(true);
    try {
      const page = await runsApi.listRuns({
        ...(module ? { module } : {}),
        limit: RUNS_PAGE_SIZE,
        cursor,
      });
      setRuns((current) => [...(current ?? []), ...page.runs]);
      setCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  // Recomputed on every poll, but the string only changes when the counts do,
  // so the live region stays quiet while nothing is happening. When the poll
  // stops, it says so: an auto-updating region that goes still without a word
  // is indistinguishable from one that is broken.
  const listStatus =
    runs === null
      ? "Loading runs…"
      : `${runs.length} run${runs.length === 1 ? "" : "s"}, ${activeCount} in progress.` +
        (activeCount === 0 ? " Updates paused — use Refresh." : "");

  return (
    <>
      <div className="field-row runs-toolbar">
        {/* aria-disabled rather than disabled, like every other busy control
            here: the pressed button has to survive its own request. */}
        <button
          type="button"
          className="action-button"
          onClick={() => void check()}
          aria-disabled={checking}
        >
          {checking ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      <p className="visually-hidden" role="status">
        {liveReady ? (checking ? "Checking for new runs…" : listStatus) : ""}
      </p>

      {runs === null ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : runs.length === 0 ? (
        <div className="card">{empty}</div>
      ) : (
        <>
          <div className="table-scroll" tabIndex={0}>
            {/* Stacks below 640px (.stacked-sm); the roles are stated because
                that rule changes `display`, and each cell names its column. */}
            <table className="runs-table stacked-sm" role="table" data-testid="runs-table">
              <thead role="rowgroup">
                <tr role="row">
                  <th scope="col">Run</th>
                  {showModule ? <th scope="col">Module</th> : <th scope="col">Source</th>}
                  <th scope="col">Outcome</th>
                  <th scope="col">What it did</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {runs.map((run) => (
                  <tr
                    role="row"
                    key={run.id}
                    className="run-row"
                    onMouseDown={(event) => {
                      press.current = { x: event.clientX, y: event.clientY };
                    }}
                    onClick={(event) => {
                      /* The link is the keyboard and screen-reader route; the
                         row click is the pointer's convenience (the contract
                         .run-link's styling has always promised). A press that
                         moved was a drag-selection and must keep the page —
                         the move-away-to-abort escape (WCAG 2.5.2) — and a
                         modified or on-link press is the link's own business. */
                      const target = event.target as HTMLElement;
                      if (target.closest("a")) return;
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                      const down = press.current;
                      if (!down) return;
                      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
                      void navigate(`/runs/${run.id}`);
                    }}
                  >
                    {/* What happened leads: the title is derived at render so
                        legacy runs read the same way, and the raw filename is
                        demoted to metadata (D4). The link stays the keyboard and
                        screen-reader route into the run. */}
                    <td role="cell" data-label="Run" className="run-file-name">
                      <Link
                        to={`/runs/${run.id}`}
                        className="run-link"
                        title={run.fileName ?? run.id}
                      >
                        {runTitle(run.fileName ?? run.id)}
                      </Link>
                      {run.fileName ? (
                        <span className="muted run-file-meta">{run.fileName}</span>
                      ) : null}
                    </td>
                    {showModule ? (
                      /* The tab bar's own words, not an identifier from disk —
                         except for a Run whose Module is gone, which keeps its
                         raw id rather than disappearing. */
                      <td role="cell" data-label="Module" className="muted">
                        {moduleLabel(run.module)}
                      </td>
                    ) : (
                      <td role="cell" data-label="Source">
                        <IntakeBadge intake={run.intake} />
                      </td>
                    )}
                    <td role="cell" data-label="Outcome">
                      <StatusPill status={run.status} connectionState={run.connectionState} />
                    </td>
                    <td role="cell" data-label="What it did" className="muted run-summary-cell">
                      {run.status === "skipped" && run.skipReason
                        ? run.skipReason
                        : run.status === "blocked" && run.wait?.reason
                          ? run.wait.reason
                          : (run.summary ?? "")}
                    </td>
                    <td role="cell" data-label="When">
                      <time dateTime={run.createdAt} title={formatTime(run.createdAt)}>
                        {relativeTime(run.createdAt)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cursor !== null && (
            <div className="field-row">
              <button
                type="button"
                className="action-button"
                onClick={() => void showMore()}
                aria-disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Show older runs"}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
