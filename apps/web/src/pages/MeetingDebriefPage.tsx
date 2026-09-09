import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { MeetingDebriefIndex, MeetingDebriefIndexEntry } from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import { meetingsApi, type MeetingsClient } from "../clients/meetings";
import { meetingDebriefName } from "../modules/meeting-debrief/naming";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

function RosterBadge({ entry }: { entry: MeetingDebriefIndexEntry }) {
  if (entry.rosterStatus === "prefilled") {
    return (
      <span className="status-badge status-ok" role="status">
        Roster prefilled from Calendar
      </span>
    );
  }
  return (
    <span className="status-badge status-attention" role="status">
      Roster confirmation required
    </span>
  );
}

function IdentityBadge({ entry }: { entry: MeetingDebriefIndexEntry }) {
  const parts: string[] = [];
  if (entry.identity.resolvedCount > 0) {
    parts.push(`${entry.identity.resolvedCount} resolved`);
  }
  if (entry.identity.unresolvedCount > 0) {
    parts.push(`${entry.identity.unresolvedCount} unresolved`);
  }
  /* Pluralized like the two counts beside it — "1 organizations" was the
     only row that ever read like a placeholder. */
  if (entry.identity.organizationCount > 0) {
    parts.push(
      `${entry.identity.organizationCount} organization${
        entry.identity.organizationCount === 1 ? "" : "s"
      }`,
    );
  }
  return <span className="muted">{parts.length > 0 ? parts.join(", ") : "No identity state"}</span>;
}

/**
 * What a Debrief's state means for the owner. A Debrief is finished as soon as
 * it is extracted — nothing waits for review — so the only outstanding state
 * is whether its one outward write, the Gmail draft, has been created (issue
 * #182). Tasks do not come from here at all.
 */
function ReviewStateBadge({ entry }: { entry: MeetingDebriefIndexEntry }) {
  if (entry.reviewState === "published") {
    return (
      <span className="status-badge status-ok" role="status">
        Draft created
      </span>
    );
  }
  return <ReadinessBadge entry={entry} />;
}

function ReadinessBadge({ entry }: { entry: MeetingDebriefIndexEntry }) {
  /* A Run that failed is never Ready, whatever result survived on it: the
     readiness field describes the extraction it holds, and reading it alone
     reported a failure as finished work. */
  if (entry.status === "failed") {
    return (
      <span className="status-badge status-attention" role="status">
        Extraction failed
      </span>
    );
  }
  if (entry.reviewReadiness === "no_extraction") {
    return (
      <span className="status-badge" role="status">
        Extracting…
      </span>
    );
  }
  /* Extracted and usable either way. `needs_roster` says only that the
     attendee list is not settled enough to address a draft to — it is a note
     about publishing, not a reason the Debrief is unfinished. */
  return (
    <span className="status-badge status-ok" role="status">
      {entry.reviewReadiness === "needs_roster" ? "Ready · roster needed to send" : "Ready"}
    </span>
  );
}

/** Newest meeting first: the retrospective people want is the last one. */
function compareEntries(a: MeetingDebriefIndexEntry, b: MeetingDebriefIndexEntry): number {
  /* A transcript that stated no meeting date sorts last rather than claiming
     the top of a list ordered by when the meeting happened. */
  if (a.meetingDate === b.meetingDate) return 0;
  if (a.meetingDate === null) return 1;
  if (b.meetingDate === null) return -1;
  return b.meetingDate.localeCompare(a.meetingDate);
}

export function MeetingDebriefPage({ client = meetingsApi }: { client?: MeetingsClient }) {
  useTitle("Meeting Debrief");
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [index, setIndex] = useState<MeetingDebriefIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* Meeting titles by Meeting id. The index rows are keyed by Transcript, so
     without this the Meeting column printed the Drive file name — a path, a
     timestamp and an extension where a meeting's name belongs. */
  const [meetingTitles, setMeetingTitles] = useState<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setIndex(await client.meetingDebriefIndex());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let live = true;
    void client
      .meetings()
      .then((meetings) => {
        if (!live) return;
        setMeetingTitles(new Map(meetings.meetings.map((meeting) => [meeting.id, meeting.title])));
      })
      .catch(() => {
        // A missing title only costs the file-name fallback, never the page.
      });
    return () => {
      live = false;
    };
  }, [client]);

  const entries = useMemo(() => (index ? [...index.entries].sort(compareEntries) : []), [index]);

  return (
    <div className="page">
      <h1 ref={headingRef} tabIndex={-1}>
        Meeting Debrief
      </h1>
      <p className="muted">
        Every mined transcript gets a retrospective: decisions, action items, open questions, and
        coaching — extracted from the Transcript Catalog and ready to read as soon as it lands.
        Regenerate any field or drop an action item at any time. Nothing is written outward — no
        Gmail draft, no Google Task — until you publish it.
      </p>
      {error && (
        <p className="banner-error" role="alert">
          {error}
        </p>
      )}
      {busy && <p className="muted">Loading…</p>}
      {index && index.entries.length === 0 && (
        <p className="muted">
          No Meeting Debriefs yet. They appear here as the Transcript Catalog mines transcripts.
        </p>
      )}
      {entries.length > 0 && (
        <div className="table-scroll">
          {/* Seven columns, so it stacks below 640px (.stacked-sm). The roles
              are stated because that rule changes `display`, which would
              otherwise drop the table semantics; each cell names its own
              column for the stacked reading. */}
          <table className="stacked-sm" role="table">
            <caption className="visually-hidden">Meeting Debriefs, newest meeting first</caption>
            <thead role="rowgroup">
              <tr role="row">
                <th scope="col">Meeting</th>
                <th scope="col">Date</th>
                <th scope="col">Found</th>
                <th scope="col">Calendar</th>
                <th scope="col">Roster</th>
                <th scope="col">Identity</th>
                <th scope="col">Recipients</th>
                <th scope="col">Review</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {entries.map((entry) => (
                <tr role="row" key={entry.runId}>
                  <td role="cell" data-label="Meeting">
                    <Link to={`/meeting-debrief/${encodeURIComponent(entry.runId)}`}>
                      {meetingDebriefName(entry, meetingTitles)}
                    </Link>
                    <div>
                      <Link to={`/meeting-debrief/${encodeURIComponent(entry.runId)}`}>
                        Open full Debrief
                      </Link>
                    </div>
                    {/* The Meeting is the record this retrospective is about;
                        the row above only reaches its Run. */}
                    {entry.meetingId ? (
                      <>
                        {" "}
                        <Link
                          className="muted"
                          to={`/meetings/${encodeURIComponent(entry.meetingId)}`}
                        >
                          (meeting)
                        </Link>
                      </>
                    ) : null}
                  </td>
                  <td role="cell" data-label="Date">
                    {entry.meetingDate ?? "—"}
                  </td>
                  {/* What the retrospective actually contains. Every other
                      column reported plumbing, so thirty rows read identically
                      and none of them said what was in the debrief. */}
                  <td role="cell" data-label="Found">
                    {/* The summary is the row's most readable thing, so it is
                        also a way into the Debrief it summarizes (issue
                        #182) — a real link, reachable by keyboard. */}
                    {entry.summary ? (
                      <Link to={`/meeting-debrief/${encodeURIComponent(entry.runId)}`}>
                        {entry.summary}
                      </Link>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td role="cell" data-label="Calendar">
                    {entry.linked ? "Linked" : "Not linked"}
                  </td>
                  <td role="cell" data-label="Roster">
                    <RosterBadge entry={entry} />
                  </td>
                  <td role="cell" data-label="Identity">
                    <IdentityBadge entry={entry} />
                  </td>
                  <td role="cell" data-label="Recipients">
                    {entry.recipientCount}
                  </td>
                  <td role="cell" data-label="Review">
                    <ReviewStateBadge entry={entry} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
