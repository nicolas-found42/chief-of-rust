import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  DailyBriefingBriefStatus,
  DailyBriefingState,
  MeetingIndex,
  TaskOverview,
  WeeklyWorkspaceView,
} from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import { meetingsApi, type MeetingsClient } from "../clients/meetings";
import { tasksApi, type TasksClient } from "../clients/tasks";
import { MeetingWizardTabs } from "../components/MeetingWizardTabs";
import { MetricStrip, WorkGroups } from "../components/WorkSummary";
import { formatMeetingDate, formatMeetingTime } from "../display";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";
import "./meetingWizard.css";

/**
 * Meeting Wizard — Today (issues #151, #193). The Workspace's Meetings for the
 * day, the week's rollup, and the canonical work beside them.
 *
 * The visual system is Editorial Ledger hierarchy over Day Spine metrics under
 * Quiet Rail restraint (spec: user story 99): numbered sections and ruled
 * ledger lines rather than a grid of cards, one strip of figures so the day's
 * shape reads before any list does, and no shadow, no dense card and no Run
 * concept anywhere on the page. Runs are diagnostics; this is preparation.
 *
 * Tasks and pending Action Items are two groups, never one queue: accepted
 * work and a proposal awaiting a decision are different commitments, and both
 * are read from the Tasks product rather than from Debrief Run receipts.
 */

/**
 * What a Brief's state means, and whether it is something to act on. `failed`
 * is its own state: a preparation that ran and failed reads as "No brief"
 * only if the page is willing to under-report its own failures.
 */
const BRIEF_STATUS: Record<DailyBriefingBriefStatus, { label: string; attention: boolean }> = {
  ready: { label: "Brief ready", attention: false },
  pending: { label: "Brief preparing", attention: false },
  failed: { label: "Brief failed", attention: true },
  missing: { label: "No brief", attention: false },
};

/** One ledger line. Both briefings render through it, so they cannot disagree. */
function MeetingLine({
  meetingId,
  title,
  startAt,
  briefStatus,
}: {
  meetingId: string;
  title: string;
  startAt: string;
  briefStatus: DailyBriefingBriefStatus;
}) {
  const status = BRIEF_STATUS[briefStatus];
  return (
    <li className="wizard-line">
      <Link to={`/meetings/${meetingId}`}>{title}</Link>
      <span className="wizard-leader" aria-hidden="true" />
      {status.attention ? (
        <span className="status-badge status-attention">{status.label}</span>
      ) : (
        <span className="muted">{status.label}</span>
      )}
      <time className="wizard-time" dateTime={startAt}>
        {formatMeetingTime(startAt)}
      </time>
    </li>
  );
}

/** A numbered section head with the count it covers. The ordinal is decorative. */
function SectionHead({
  ordinal,
  id,
  heading,
  count,
}: {
  ordinal: string;
  id: string;
  heading: string;
  count: string;
}) {
  return (
    <div className="wizard-section-head">
      <span className="wizard-num" aria-hidden="true">
        {ordinal}
      </span>
      <h2 id={id}>{heading}</h2>
      <span className="wizard-count">{count}</span>
    </div>
  );
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function MeetingsOverviewPage({
  client = meetingsApi,
  tasksClient = tasksApi,
}: {
  client?: MeetingsClient;
  tasksClient?: TasksClient;
}) {
  useTitle("Meeting Wizard");
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [index, setIndex] = useState<MeetingIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [briefing, setBriefing] = useState<DailyBriefingState | null>(null);
  const [briefingBusy, setBriefingBusy] = useState(false);
  const [weekly, setWeekly] = useState<WeeklyWorkspaceView | null>(null);
  const [work, setWork] = useState<TaskOverview | null>(null);
  const [workError, setWorkError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setIndex(await client.meetings());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [client]);

  const loadBriefing = useCallback(
    async (retry: boolean) => {
      setBriefingBusy(true);
      try {
        setBriefing(await (retry ? client.retryDailyBriefing() : client.dailyBriefing()));
      } catch (err) {
        setBriefing({ briefing: null, error: errorMessage(err), stale: false });
      } finally {
        setBriefingBusy(false);
      }
    },
    [client],
  );

  /* The week's own count, for the metric strip only. The deterministic read:
     a figure on this tab must never spend a Weekly Summary generation, which
     belongs to the tab that shows one (issue #196). */
  const loadWeekly = useCallback(async () => {
    try {
      setWeekly(await client.weeklyWorkspaceDeterministic());
    } catch {
      /* Silent: This week has its own tab, with its own error state. */
    }
  }, [client]);

  /* Canonical work (issue #192). Read from the Tasks product, which owns the
     records; this page shows them and edits none of them. */
  const loadWork = useCallback(async () => {
    try {
      setWork(await tasksClient.overview());
      setWorkError(null);
    } catch (err) {
      setWorkError(errorMessage(err));
    }
  }, [tasksClient]);

  const reload = useCallback(() => {
    void refresh();
    void loadBriefing(false);
    void loadWeekly();
    void loadWork();
  }, [refresh, loadBriefing, loadWeekly, loadWork]);

  useEffect(() => {
    reload();
  }, [reload]);

  const todayCount = briefing?.briefing?.meetings.length ?? 0;
  const weekCount = weekly?.meetings.length ?? 0;

  return (
    <div className="page">
      <header className="wizard-head">
        <h1 ref={headingRef} tabIndex={-1}>
          Meeting Wizard
        </h1>
        <MeetingWizardTabs />
        <p className="wizard-standfirst">
          Every meeting the workspace knows about — from your calendar, and from transcripts of
          meetings that were never on it. Each carries its brief beforehand and its debrief
          afterwards.
          {index?.historyBeginsAt ? (
            <>
              {" "}
              Meeting history begins{" "}
              <time dateTime={index.historyBeginsAt}>
                {formatMeetingDate(index.historyBeginsAt)}
              </time>
              .
            </>
          ) : null}
        </p>

        {/* The day's shape in five figures, before any list is read. Each is a
            link to the surface that owns it, so the strip is navigation as
            well as a read-out. */}
        <MetricStrip
          metrics={[
            { label: "Today", value: todayCount, to: "/meetings" },
            { label: "This week", value: weekCount, to: "/meetings/weekly" },
            {
              label: "Pending",
              value: work?.counts.pendingActionItems ?? 0,
              to: "/tasks#action-items",
            },
            { label: "Open", value: work?.counts.open ?? 0, to: "/tasks" },
            { label: "Overdue", value: work?.counts.overdue ?? 0, to: "/tasks" },
          ]}
        />

        <div className="wizard-actions">
          <Link to="/meetings/brief" className="action-button">
            Open the Brief journey
          </Link>
          <Link to="/meeting-debrief" className="action-button">
            Open the Debrief journey
          </Link>
          <button type="button" className="action-button" onClick={reload} aria-disabled={busy}>
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {error ? (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      ) : null}

      <section className="wizard-section" aria-labelledby="wizard-today-heading">
        <SectionHead
          ordinal="01"
          id="wizard-today-heading"
          heading="Today"
          count={plural(todayCount, "meeting")}
        />
        {!briefing ? (
          <p className="wizard-empty" role="status">
            Loading briefing…
          </p>
        ) : briefing.error ? (
          <div>
            <div className="banner banner-error" role="alert">
              {briefing.error}
            </div>
            <div className="wizard-actions">
              <button
                type="button"
                className="action-button"
                onClick={() => void loadBriefing(true)}
                aria-disabled={briefingBusy}
              >
                {briefingBusy ? "Retrying…" : "Retry briefing"}
              </button>
            </div>
          </div>
        ) : briefing.briefing && briefing.briefing.meetings.length > 0 ? (
          <>
            <p className="wizard-note">{briefing.briefing.summary}</p>
            {briefing.stale ? (
              <p className="wizard-note" role="status">
                Being updated — showing the previous briefing.
              </p>
            ) : null}
            <ul className="wizard-ledger">
              {briefing.briefing.meetings.map((entry) => (
                <MeetingLine key={entry.meetingId} {...entry} />
              ))}
            </ul>
          </>
        ) : (
          <p className="wizard-empty">No meetings today.</p>
        )}
      </section>

      {/* Accepted work and the proposals still awaiting a decision, as two
          groups under one head. Both are capped at eight with their totals
          beside them, and both link back to the Tasks product (issue #192). */}
      <section className="wizard-section" aria-labelledby="wizard-work-heading">
        <SectionHead
          ordinal="02"
          id="wizard-work-heading"
          heading="Your work"
          count={
            work
              ? `${plural(work.counts.open, "open Task")} · ${plural(
                  work.counts.pendingActionItems,
                  "awaiting review",
                )}`
              : "—"
          }
        />
        {workError ? (
          <div className="banner banner-error" role="alert">
            {workError}
          </div>
        ) : work === null ? (
          <p className="wizard-empty" role="status">
            Loading work…
          </p>
        ) : (
          <WorkGroups overview={work} />
        )}
      </section>
    </div>
  );
}
