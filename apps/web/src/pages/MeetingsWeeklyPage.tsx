import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  ActionItem,
  Task,
  WeeklyMeeting,
  WeeklyWorkspaceView,
} from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import { meetingsApi, type MeetingsClient } from "../clients/meetings";
import { MeetingWizardTabs } from "../components/MeetingWizardTabs";
import { formatMeetingTime } from "../display";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";
import "./meetingWizard.css";

/**
 * Meeting Wizard — This week (issues #194, #195, #196). Sunday through
 * Saturday in the Workspace timezone, grouped Completed, In progress and
 * Upcoming, with overdue Tasks, Tasks due through Saturday, and pending Action
 * Items as their own deterministic sections.
 *
 * The page is never model-dependent. Every group above is derived from the
 * Workspace's own records and stays on screen whatever the Weekly Summary is
 * doing — generating, stale, failed, or waiting on provider consent.
 */

const GROUPS = [
  { key: "completed", heading: "Completed", ordinal: "01" },
  { key: "in-progress", heading: "In progress", ordinal: "02" },
  { key: "upcoming", heading: "Upcoming", ordinal: "03" },
] as const;

/**
 * What a Meeting's expected Brief or Debrief is doing. A Meeting stays visible
 * in every one of these states: a missing artifact is a fact about the
 * artifact, never a reason to drop the Meeting from the week.
 */
const ARTIFACT: Record<WeeklyMeeting["artifactStatus"], { label: string; attention: boolean }> = {
  ready: { label: "Ready", attention: false },
  pending: { label: "Preparing", attention: false },
  failed: { label: "Failed", attention: true },
  missing: { label: "Not yet prepared", attention: false },
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function MeetingLine({ meeting }: { meeting: WeeklyMeeting }) {
  const artifact = ARTIFACT[meeting.artifactStatus];
  return (
    <li className="wizard-line">
      <Link to={`/meetings/${meeting.id}`}>{meeting.title}</Link>
      <span className="wizard-leader" aria-hidden="true" />
      {artifact.attention ? (
        <span className="status-badge status-attention">{artifact.label}</span>
      ) : (
        <span className="muted">{artifact.label}</span>
      )}
      <time className="wizard-time" dateTime={meeting.startAt}>
        {formatMeetingTime(meeting.startAt)}
      </time>
    </li>
  );
}

function TaskLine({ task, today }: { task: Task; today: string }) {
  return (
    <li className="wizard-line">
      <Link to={`/tasks#task-${task.id}`}>{task.title}</Link>
      <span className="wizard-leader" aria-hidden="true" />
      {task.dueDate !== null && task.dueDate < today ? (
        <span className="status-badge status-attention">Overdue</span>
      ) : (
        <span className="muted">Open</span>
      )}
      <span className="wizard-time">{task.dueDate ?? "No due date"}</span>
    </li>
  );
}

function ActionItemLine({ item }: { item: ActionItem }) {
  return (
    <li className="wizard-line">
      <Link to={`/tasks#action-item-${item.id}`}>{item.proposal.title}</Link>
      <span className="wizard-leader" aria-hidden="true" />
      <span className="muted">Awaiting review</span>
      <span className="wizard-time">{item.proposal.dueDate ?? "No proposed date"}</span>
    </li>
  );
}

function Section({
  ordinal,
  id,
  heading,
  count,
  empty,
  rows,
}: {
  ordinal: string;
  id: string;
  heading: string;
  count: string;
  empty: string;
  rows: React.ReactNode[];
}) {
  return (
    <section className="wizard-section" aria-labelledby={id}>
      <div className="wizard-section-head">
        <span className="wizard-num" aria-hidden="true">
          {ordinal}
        </span>
        <h2 id={id}>{heading}</h2>
        <span className="wizard-count">{count}</span>
      </div>
      {rows.length === 0 ? (
        <p className="wizard-empty">{empty}</p>
      ) : (
        <ul className="wizard-ledger">{rows}</ul>
      )}
    </section>
  );
}

/** What the Weekly Summary's state says, in words rather than a colour. */
function SummaryPanel({
  view,
  busy,
  onRegenerate,
  onConsent,
}: {
  view: WeeklyWorkspaceView;
  busy: boolean;
  onRegenerate: () => void;
  onConsent: () => void;
}) {
  const { summary } = view;
  return (
    <section className="wizard-section" aria-labelledby="weekly-summary-heading">
      <div className="wizard-section-head">
        <span className="wizard-num" aria-hidden="true">
          00
        </span>
        <h2 id="weekly-summary-heading">Weekly Summary</h2>
        <span className="wizard-count">
          {summary.generatedAt ? (
            <>
              Generated <time dateTime={summary.generatedAt}>{summary.generatedAt}</time>
            </>
          ) : (
            "Not generated"
          )}
        </span>
      </div>
      {summary.text ? <p>{summary.text}</p> : null}
      {summary.state === "empty" ? (
        <p className="wizard-empty">
          No Meeting Brief or Meeting Debrief has succeeded this week, so there is nothing to
          summarize yet.
        </p>
      ) : null}
      {summary.state === "stale" ? (
        <p className="wizard-note" role="status">
          The sources changed. This summary is the last good one; a replacement follows shortly.
        </p>
      ) : null}
      {summary.state === "failed" ? (
        <div className="banner banner-error" role="alert">
          {summary.error}
        </div>
      ) : null}
      {summary.state === "consent-required" ? (
        <div className="banner banner-warn" role="status">
          {summary.error} Provider <strong>{summary.provider}</strong>, model{" "}
          <strong>{summary.model}</strong>.{" "}
          <button
            type="button"
            className="action-button"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onConsent();
            }}
          >
            Send projections to this provider and model
          </button>
        </div>
      ) : null}
      <div className="wizard-actions">
        <button
          type="button"
          className="action-button"
          aria-disabled={busy}
          onClick={() => {
            if (!busy) onRegenerate();
          }}
        >
          {busy ? "Working…" : summary.state === "failed" ? "Retry summary" : "Regenerate summary"}
        </button>
      </div>
    </section>
  );
}

export function MeetingsWeeklyPage({ client = meetingsApi }: { client?: MeetingsClient }) {
  useTitle("This week");
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [view, setView] = useState<WeeklyWorkspaceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (action: "read" | "regenerate") => {
      setBusy(true);
      try {
        setView(
          await (action === "regenerate"
            ? client.regenerateWeeklySummary()
            : client.weeklyWorkspace()),
        );
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void load("read");
    const timer = window.setInterval(() => void load("read"), 3_000);
    const refresh = () => void load("read");
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  const consent = useCallback(async () => {
    if (!view) return;
    setBusy(true);
    try {
      await client.consentWeeklySummary(view.summary.provider, view.summary.model);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    await load("regenerate");
  }, [client, view, load]);

  return (
    <div className="page">
      <header className="wizard-head">
        <h1 ref={headingRef} tabIndex={-1}>
          This week
        </h1>
        <MeetingWizardTabs />
        {view ? (
          <p className="wizard-standfirst">
            <time dateTime={view.weekStart}>{view.weekStart}</time> through{" "}
            <time dateTime={view.weekEnd}>{view.weekEnd}</time>, in the Workspace timezone.
            Cancelled meetings are left out.
          </p>
        ) : null}
        <div className="wizard-actions">
          <button
            type="button"
            className="action-button"
            onClick={() => void load("read")}
            aria-disabled={busy}
          >
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {error ? (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      ) : null}

      {view === null ? (
        <p className="wizard-empty" role="status">
          Loading this week…
        </p>
      ) : (
        <>
          <SummaryPanel
            view={view}
            busy={busy}
            onRegenerate={() => void load("regenerate")}
            onConsent={() => void consent()}
          />

          {GROUPS.map((group) => {
            const meetings = view.meetings.filter((meeting) => meeting.group === group.key);
            return (
              <Section
                key={group.key}
                ordinal={group.ordinal}
                id={`weekly-${group.key}-heading`}
                heading={group.heading}
                count={plural(meetings.length, "meeting")}
                empty={`No ${group.heading.toLowerCase()} meetings this week.`}
                rows={meetings.map((meeting) => (
                  <MeetingLine key={meeting.id} meeting={meeting} />
                ))}
              />
            );
          })}

          <Section
            ordinal="04"
            id="weekly-overdue-heading"
            heading="Overdue Tasks"
            count={plural(view.overdue.length, "Task")}
            empty="Nothing is overdue."
            rows={view.overdue.map((task) => (
              <TaskLine key={task.id} task={task} today={view.today} />
            ))}
          />

          <Section
            ordinal="05"
            id="weekly-due-heading"
            heading="Due this week"
            count={plural(view.dueThisWeek.length, "Task")}
            empty="No open Task is due before Sunday."
            rows={view.dueThisWeek.map((task) => (
              <TaskLine key={task.id} task={task} today={view.today} />
            ))}
          />

          <Section
            ordinal="06"
            id="weekly-pending-heading"
            heading="Action Items awaiting review"
            count={plural(view.pending.length, "Action Item")}
            empty="Nothing is waiting on a decision."
            rows={view.pending.map((item) => (
              <ActionItemLine key={item.id} item={item} />
            ))}
          />
        </>
      )}
    </div>
  );
}
