import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { MeetingBriefIndexEntry } from "@chief-of-staff-demo/shared";
import { meetingsApi, type MeetingsClient } from "../clients/meetings";
import { runsApi } from "../clients/workspace";
import { errorMessage } from "../client";
import { formatMeetingTime, statusLabel } from "../display";
import { useMeetingIndex } from "../useMeetingIndex";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";
import { deliveryPresentation } from "../modules/meeting-brief/deliveryStatus";

/**
 * The Calendar ETag as a version a reader can compare. Calendar hands it over
 * quoted — `"3575507876827966"` — and printed raw the quotes read as though
 * the page were quoting somebody.
 */
function calendarVersionLabel(version: string): string {
  return version.replace(/^"|"$/g, "");
}

function groupByOccurrence(
  briefs: MeetingBriefIndexEntry[],
): Map<string, MeetingBriefIndexEntry[]> {
  const groups = new Map<string, MeetingBriefIndexEntry[]>();
  for (const entry of briefs) {
    const list = groups.get(entry.occurrenceKey) ?? [];
    list.push(entry);
    groups.set(entry.occurrenceKey, list);
  }
  for (const [key, list] of groups) {
    list.sort((a, b) => {
      if (a.supersedes === b.runId) return -1;
      if (b.supersedes === a.runId) return 1;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
    groups.set(key, list);
  }
  return groups;
}

function DeliveryBadge({ delivery }: { delivery: MeetingBriefIndexEntry["delivery"] }) {
  if (!delivery) return <span className="muted">No delivery</span>;
  const presentation = deliveryPresentation(delivery.status);
  return (
    <span className={`status-badge ${presentation.className}`} role="status">
      {presentation.label}
    </span>
  );
}

export function MeetingBriefPage({ client = meetingsApi }: { client?: MeetingsClient }) {
  const { occurrenceKey } = useParams();
  const headingRef = usePageFocus<HTMLHeadingElement>();
  useTitle("Meeting Brief");
  const [sendRunId, setSendRunId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  /* Stable fetcher: the Brief journey reads the module's Cross-Run index. */
  const fetchIndex = useCallback(() => client.meetingBriefIndex(), [client]);
  const { index, error, busy, refresh, prepareNow } = useMeetingIndex(
    fetchIndex,
    client.prepareMeetingBriefNow,
  );
  /* Meetings by occurrence key, so a Brief that failed before it could compose
     one still has a name to show instead of a Calendar event id — and so a
     cancelled occurrence can say when it was to be. */
  const [meetingsByKey, setMeetingsByKey] = useState<
    Map<string, { title: string; startAt: string }>
  >(new Map());
  const meetingTitles = useMemo(
    () => new Map([...meetingsByKey].map(([key, meeting]) => [key, meeting.title])),
    [meetingsByKey],
  );
  useEffect(() => {
    let live = true;
    void client
      .meetings()
      .then((meetings) => {
        if (!live) return;
        setMeetingsByKey(
          new Map(
            meetings.meetings
              .filter((meeting) => meeting.occurrenceKey !== null)
              .map((meeting) => [
                meeting.occurrenceKey as string,
                { title: meeting.title, startAt: meeting.startAt },
              ]),
          ),
        );
      })
      .catch(() => {
        // A missing title only costs the fallback below, never the page.
      });
    return () => {
      live = false;
    };
  }, [client]);

  const groups = useMemo(() => {
    if (!index) return new Map<string, MeetingBriefIndexEntry[]>();
    return groupByOccurrence(index.briefs);
  }, [index]);
  const visibleGroups = useMemo(
    () => (occurrenceKey ? new Map([...groups].filter(([key]) => key === occurrenceKey)) : groups),
    [groups, occurrenceKey],
  );

  const currentByOccurrence = useMemo(() => {
    const map = new Map<string, MeetingBriefIndexEntry>();
    const cancelled = new Set(index?.cancellations.map((item) => item.occurrenceKey) ?? []);
    for (const [key, list] of visibleGroups) {
      if (cancelled.has(key)) continue;
      const latestRevision = list[0];
      if (latestRevision) map.set(key, latestRevision);
    }
    return map;
  }, [visibleGroups, index]);

  if (!index) {
    return (
      <div className="page">
        <h1 ref={headingRef} tabIndex={-1}>
          Meeting Brief
        </h1>
        {error ? (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        ) : (
          <p className="muted" role="status">
            Loading meeting briefs…
          </p>
        )}
      </div>
    );
  }

  const upcoming = occurrenceKey
    ? index.upcoming.filter((item) => item.occurrenceKey === occurrenceKey)
    : index.upcoming;
  const briefs = occurrenceKey
    ? index.briefs.filter((entry) => entry.occurrenceKey === occurrenceKey)
    : index.briefs;

  return (
    <div className="page">
      <h1 ref={headingRef} tabIndex={-1}>
        Meeting Brief
      </h1>
      {/* Filtered to one meeting: say which meeting, by its name. The raw
          occurrence key was a diagnostic identity printed where the reader
          needed to know what they were looking at. */}
      {occurrenceKey ? (
        <p>
          <Link to="/meetings">← Meeting Wizard overview</Link> ·{" "}
          {meetingTitles.get(occurrenceKey) ?? "this meeting"} only
        </p>
      ) : null}
      <p className="muted">
        Briefs prepared for meetings with other people on the invite — guest and company context,
        conversation starters, and the sources behind them. The newest brief for each meeting is
        shown; earlier revisions stay in the history below.
      </p>
      {error ? (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      ) : null}
      {sendError ? (
        <div className="banner banner-error" role="alert">
          {sendError}
        </div>
      ) : null}
      <div className="field-row">
        <button
          type="button"
          className="action-button"
          onClick={() => void refresh()}
          aria-disabled={busy}
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <section aria-labelledby="upcoming-heading">
        <h2 id="upcoming-heading">Upcoming meetings</h2>
        {upcoming.length === 0 ? (
          /* Empty here is the ordinary case once the week is prepared, not a
             fault. The old copy named the Intake and its schedule, which told
             the reader nothing about their own week. */
          <p className="muted">
            Nothing waiting to be prepared — every eligible meeting ahead already has its brief
            below.
          </p>
        ) : (
          <ul className="card-list">
            {upcoming.map((item) => (
              <li key={item.occurrenceKey} className="card">
                <h3>{item.summary}</h3>
                <p className="muted">
                  {meetingTitles.get(item.occurrenceKey) ?? "Untitled meeting"}
                </p>
                <p>
                  <span className="muted">Starts:</span>{" "}
                  <time dateTime={item.startAt}>{formatMeetingTime(item.startAt)}</time>
                </p>
                <p>
                  <span className="muted">Preparation due:</span>{" "}
                  <time dateTime={item.dueAt}>{formatMeetingTime(item.dueAt)}</time>
                </p>
                <button
                  type="button"
                  aria-disabled={busy}
                  onClick={() => {
                    if (busy) return;
                    void prepareNow(item.occurrenceKey);
                  }}
                >
                  Prepare now
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="current-heading">
        <h2 id="current-heading">Current briefs</h2>
        {currentByOccurrence.size === 0 ? (
          <p className="muted">
            No Meeting Briefs yet — one is prepared for each eligible meeting shortly before it.
          </p>
        ) : (
          <ul className="card-list">
            {Array.from(currentByOccurrence.entries()).map(([occurrenceKey, entry]) => {
              const brief = entry.meetingBrief;
              return (
                <li key={occurrenceKey} className="card">
                  {/* A failed preparation has no brief to take a title from,
                      and the Calendar event id is not a name — the Meeting
                      title is, so fall back to it before the raw id. */}
                  <h3>
                    {brief?.logistics.title ??
                      meetingTitles.get(occurrenceKey) ??
                      "Untitled meeting"}
                  </h3>
                  <p className="muted">
                    Prepared{" "}
                    <time dateTime={entry.createdAt}>{formatMeetingTime(entry.createdAt)}</time> ·{" "}
                    {statusLabel(entry.status)}
                  </p>
                  {entry.supersedes ? (
                    <p className="muted">
                      Supersedes a previous revision —{" "}
                      <a href="#history-heading">see revision history</a>.
                    </p>
                  ) : null}
                  <p>
                    Delivery: <DeliveryBadge delivery={entry.delivery} />
                    {entry.delivery?.recipient ? ` · to ${entry.delivery.recipient}` : ""}
                  </p>
                  {entry.delivery && deliveryPresentation(entry.delivery.status).explanation ? (
                    <p className="muted">
                      {deliveryPresentation(entry.delivery.status).explanation}
                    </p>
                  ) : null}
                  {entry.providerOutcomes && entry.providerOutcomes.length > 0 ? (
                    <details className="provider-outcomes">
                      <summary className="muted">
                        {entry.providerOutcomes.length} source
                        {entry.providerOutcomes.length === 1 ? "" : "s"} consulted
                      </summary>
                      <ul>
                        {entry.providerOutcomes.map((outcome, outcomeIndex) => (
                          <li key={`${outcome.provider}:${outcome.attendee}:${outcomeIndex}`}>
                            {outcome.provider} · {outcome.attendee} — {outcome.outcome}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {brief ? (
                    <>
                      <p>{brief.summary}</p>
                      {brief.guests.length > 0 ? (
                        <div>
                          <h4>Guests</h4>
                          <ul>
                            {brief.guests.map((g) => (
                              <li key={g.email}>
                                {g.name ? `${g.name} — ${g.email}` : g.email}{" "}
                                {g.role ? `· ${g.role}` : ""}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {brief.companies.length > 0 ? (
                        <div>
                          <h4>Companies</h4>
                          <ul>
                            {brief.companies.map((c) => (
                              <li key={c.name}>
                                {c.name} {c.domain ? `(${c.domain})` : ""}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {brief.conversationStarters.length > 0 ? (
                        <div>
                          <h4>Conversation starters</h4>
                          <ol>
                            {brief.conversationStarters.map((s, idx) => (
                              <li key={idx}>{s}</li>
                            ))}
                          </ol>
                        </div>
                      ) : null}
                      {(brief.sourceReferences.length > 0 ||
                        brief.missingEvidence.length > 0 ||
                        brief.uncertainty.length > 0) && (
                        <div>
                          <h4>Sources & evidence</h4>
                          {brief.sourceReferences.length > 0 ? (
                            <ul>
                              {brief.sourceReferences.map((ref, idx) => (
                                <li key={idx}>
                                  <a href={ref} target="_blank" rel="noreferrer">
                                    {ref}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {brief.missingEvidence.length > 0 ? (
                            <div className="banner banner-warn" role="status">
                              <strong>Missing evidence:</strong> {brief.missingEvidence.join("; ")}
                            </div>
                          ) : null}
                          {brief.uncertainty.length > 0 ? (
                            <p className="muted">Uncertainty: {brief.uncertainty.join("; ")}</p>
                          ) : null}
                        </div>
                      )}
                      {/* Show at least one source link name for a11y */}
                    </>
                  ) : (
                    <>
                      <p className="muted">
                        No brief — preparation {statusLabel(entry.status).toLowerCase()}.
                      </p>
                      <p>
                        <Link to={`/runs/${entry.runId}`} className="action-button">
                          Technical details
                        </Link>
                      </p>
                    </>
                  )}
                  {/* Owner-only manual send: preparation never emails (issue
                      #163); this button retries the Run's deliver stage, which
                      is the explicit send. The server fixes the recipient to
                      the owner. */}
                  {brief && entry.delivery?.status !== "sent" ? (
                    <div className="field-row">
                      <button
                        type="button"
                        className="action-button"
                        aria-disabled={busy || sendRunId !== null}
                        onClick={() => {
                          if (busy || sendRunId !== null) return;
                          setSendRunId(entry.runId);
                          setSendError(null);
                          runsApi
                            .retry(entry.runId)
                            .then(() => refresh())
                            .catch((cause: unknown) => setSendError(errorMessage(cause)))
                            .finally(() => setSendRunId(null));
                        }}
                      >
                        {sendRunId === entry.runId ? "Sending…" : "Send brief email"}
                      </button>
                      <span className="muted">Sends to the owner only.</span>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="cancellation-heading">
        <h2 id="cancellation-heading">Cancelled meetings</h2>
        {index.cancellations.length === 0 ? (
          <p className="muted">No cancelled meeting occurrences.</p>
        ) : (
          <ul className="card-list">
            {index.cancellations.map((cancellation) => (
              <li key={cancellation.occurrenceKey} className="card">
                {/* The meeting's own name and when it was to be, so two
                    cancelled occurrences of one recurring meeting are told
                    apart. "occurrence <title>" read as a broken sentence and
                    identified nothing. */}
                <h3>{meetingTitles.get(cancellation.occurrenceKey) ?? cancellation.summary}</h3>
                <p>
                  <span className="status-badge status-active">Cancelled</span>
                  {meetingsByKey.get(cancellation.occurrenceKey) ? (
                    <>
                      {" · was "}
                      <time dateTime={meetingsByKey.get(cancellation.occurrenceKey)!.startAt}>
                        {formatMeetingTime(meetingsByKey.get(cancellation.occurrenceKey)!.startAt)}
                      </time>
                    </>
                  ) : null}
                </p>
                <p className="muted">
                  Completed briefs remain in revision history, but this occurrence is no longer a
                  current brief.
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="history-heading">
        <h2 id="history-heading">Revision history</h2>
        {briefs.length === 0 ? (
          <p className="muted">No historical briefs yet.</p>
        ) : (
          <ul className="card-list">
            {briefs
              .slice()
              .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
              .map((entry) => {
                const isCurrent =
                  currentByOccurrence.get(entry.occurrenceKey)?.runId === entry.runId;
                return (
                  <li key={entry.runId} className="card">
                    {/* Which meeting this revision is of. Unfiltered, the
                        history mixes every meeting's revisions together, and
                        two of them read "Current" with nothing to say what
                        each was current for. */}
                    <h3>{meetingTitles.get(entry.occurrenceKey) ?? "Untitled meeting"}</h3>
                    <p>
                      {/* The Calendar version stays here and only here: it is
                          what tells one revision from the next. On a current
                          brief it is a raw ETag beside a meeting's name. */}
                      version {calendarVersionLabel(entry.eventVersion)} ·{" "}
                      {formatMeetingTime(entry.createdAt)} ·{" "}
                      <span
                        className={`status-badge ${isCurrent ? "status-done" : "status-active"}`}
                      >
                        {isCurrent ? "Current" : "Superseded"}
                      </span>{" "}
                      <DeliveryBadge delivery={entry.delivery} />
                    </p>
                    {entry.supersedes ? (
                      <p className="muted">Supersedes a previous revision.</p>
                    ) : null}
                    {entry.delivery && deliveryPresentation(entry.delivery.status).explanation ? (
                      <p className="muted">
                        {deliveryPresentation(entry.delivery.status).explanation}
                      </p>
                    ) : null}
                    {entry.meetingBrief ? (
                      <p className="muted">{entry.meetingBrief.summary}</p>
                    ) : null}
                    <p>
                      {statusLabel(entry.status)}
                      {!entry.meetingBrief || entry.status !== "done" ? (
                        <>
                          {" · "}
                          <Link to={`/runs/${entry.runId}`}>Technical details</Link>
                        </>
                      ) : null}
                    </p>
                  </li>
                );
              })}
          </ul>
        )}
      </section>
    </div>
  );
}
