import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type {
  Meeting,
  MeetingBriefIndexEntry,
  MeetingDebriefDetail,
  MeetingDebriefIndexEntry,
  MeetingIneligibility,
} from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import { runsApi } from "../clients/workspace";
import { meetingsApi, type MeetingsClient } from "../clients/meetings";
import { formatMeetingEndTime, formatMeetingTime } from "../display";
import { useMeetingIndex } from "../useMeetingIndex";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";
import { deliveryPresentation } from "../modules/meeting-brief/deliveryStatus";

/** Why this Meeting earns no Meeting Brief, said the way a person would say it. */
const INELIGIBILITY_LABELS: Record<MeetingIneligibility, string> = {
  all_day_excluded: "This is an all-day entry, so there is nothing to prepare for a time.",
  missing_time: "Calendar gave this entry no start or end time.",
  cancelled: "Calendar reports this occurrence as cancelled.",
  owner_declined: "You declined this meeting.",
  no_other_attendee: "Nobody else was invited, or everybody else declined.",
};

const RESPONSE_LABELS: Record<Meeting["participants"][number]["responseStatus"], string> = {
  accepted: "Accepted",
  tentative: "Tentative",
  needsAction: "No reply",
  declined: "Declined",
};

type MeetingTab = "brief" | "debrief";

/**
 * Tab label that accepts a state suffix later (e.g. "awaiting review")
 * without rework: pass `state` and it renders beside the label.
 */
function TabLabel({ label, state }: { label: string; state?: string | null }) {
  return (
    <>
      {label}
      {state ? <span className="muted"> — {state}</span> : null}
    </>
  );
}

/** Newest revision first, mirroring the Brief journey's grouping. */
function compareBriefEntries(a: MeetingBriefIndexEntry, b: MeetingBriefIndexEntry): number {
  if (a.supersedes === b.runId) return -1;
  if (b.supersedes === a.runId) return 1;
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

/**
 * The Brief tab: the current Meeting Brief for this Meeting, keyed by the
 * Meeting's occurrence key and read from the same Cross-Run index the Brief
 * journey renders. When no Brief exists the tab names which eligibility test
 * failed; a failed preparation renders the error with a retry into the
 * existing prepare endpoint.
 */
function MeetingBriefTab({ meeting, client }: { meeting: Meeting; client: MeetingsClient }) {
  /* Stable fetcher: the Brief tab reads the module's Cross-Run index. */
  const fetchIndex = useCallback(() => client.meetingBriefIndex(), [client]);
  const { index, error, busy, refresh, prepareNow } = useMeetingIndex(
    fetchIndex,
    client.prepareMeetingBriefNow,
  );
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const occurrenceKey = meeting.occurrenceKey;

  const entries = useMemo(() => {
    if (!index || !occurrenceKey) return [];
    return index.briefs
      .filter((entry) => entry.occurrenceKey === occurrenceKey)
      .sort(compareBriefEntries);
  }, [index, occurrenceKey]);
  const cancelled = useMemo(
    () => index?.cancellations.some((item) => item.occurrenceKey === occurrenceKey) ?? false,
    [index, occurrenceKey],
  );
  const current = cancelled ? undefined : entries[0];
  const upcoming = useMemo(
    () => index?.upcoming.find((item) => item.occurrenceKey === occurrenceKey),
    [index, occurrenceKey],
  );

  if (meeting.ineligibleReason) {
    return <p className="muted">{INELIGIBILITY_LABELS[meeting.ineligibleReason]}</p>;
  }

  if (!occurrenceKey) {
    return (
      <p className="muted">
        This meeting has no Calendar occurrence, so there is no Brief to prepare.
      </p>
    );
  }

  if (!index) {
    return (
      <div>
        {error ? (
          <div className="banner banner-error" role="alert">
            {error}{" "}
            <button type="button" onClick={() => void refresh()} aria-disabled={busy}>
              Retry
            </button>
          </div>
        ) : (
          <p className="muted" role="status">
            Loading brief…
          </p>
        )}
      </div>
    );
  }

  const brief = current?.meetingBrief ?? null;

  return (
    <div>
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

      {brief && current ? (
        <div className="card">
          <h3>{brief.logistics.title}</h3>
          <p className="muted">
            {/* Prepared-at and a way through to the full journey. The
                occurrence id and the Calendar ETag are diagnostics — they live
                on the Run detail page, not on a product surface. */}
            Prepared{" "}
            <time dateTime={current.createdAt}>{formatMeetingTime(current.createdAt)}</time> ·{" "}
            <Link to={`/meetings/brief/${encodeURIComponent(occurrenceKey)}`}>
              View in the Brief journey
            </Link>
          </p>
          <p>{brief.summary}</p>
          {brief.guests.length > 0 ? (
            <div>
              <h4>Guests</h4>
              <ul>
                {brief.guests.map((guest) => (
                  <li key={guest.email}>
                    {guest.name ? `${guest.name} — ${guest.email}` : guest.email}{" "}
                    {guest.role ? `· ${guest.role}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {brief.conversationStarters.length > 0 ? (
            <div>
              <h4>Conversation starters</h4>
              <ol>
                {brief.conversationStarters.map((starter, starterIndex) => (
                  <li key={starterIndex}>{starter}</li>
                ))}
              </ol>
            </div>
          ) : null}
          <p>
            Delivery:{" "}
            {current.delivery ? (
              <span
                className={`status-badge ${deliveryPresentation(current.delivery.status).className}`}
                role="status"
              >
                {deliveryPresentation(current.delivery.status).label}
              </span>
            ) : (
              <span className="muted">No delivery</span>
            )}
          </p>
          {/* Why the delivery sits where it does. The Brief journey has said
              this all along; here the badge stood alone, so "Pending" gave the
              reader nothing to do with it. */}
          {current.delivery && deliveryPresentation(current.delivery.status).explanation ? (
            <p className="muted">{deliveryPresentation(current.delivery.status).explanation}</p>
          ) : null}
          {/* Owner-only send: the server fixes the recipient to the owner;
              this button only resumes the Run's deliver stage. */}
          {current.delivery?.status !== "sent" ? (
            <div className="field-row">
              <button
                type="button"
                className="action-button"
                aria-disabled={busy || sendBusy}
                onClick={() => {
                  if (busy || sendBusy) return;
                  setSendBusy(true);
                  setSendError(null);
                  runsApi
                    .retry(current.runId)
                    .then(() => refresh())
                    .catch((cause: unknown) => setSendError(errorMessage(cause)))
                    .finally(() => setSendBusy(false));
                }}
              >
                {sendBusy ? "Sending…" : "Send brief email"}
              </button>
              <span className="muted">Sends to the owner only.</span>
            </div>
          ) : null}
        </div>
      ) : current ? (
        <div className="banner banner-error" role="alert">
          <p>
            Preparation failed and left no brief.{" "}
            <Link to={`/runs/${current.runId}`}>Technical details</Link>
          </p>
          <button
            type="button"
            className="action-button"
            aria-disabled={busy}
            onClick={() => {
              if (busy) return;
              void prepareNow(occurrenceKey);
            }}
          >
            {busy ? "Retrying…" : "Retry preparation"}
          </button>
        </div>
      ) : upcoming ? (
        <div className="card">
          <p className="muted">
            Scheduled — preparation due{" "}
            <time dateTime={upcoming.dueAt}>{formatMeetingTime(upcoming.dueAt)}</time>.
          </p>
          <button
            type="button"
            className="action-button"
            aria-disabled={busy}
            onClick={() => {
              if (busy) return;
              void prepareNow(occurrenceKey);
            }}
          >
            {busy ? "Preparing…" : "Prepare now"}
          </button>
        </div>
      ) : (
        <div className="card">
          <p className="muted">No Meeting Brief yet for this meeting.</p>
          <button
            type="button"
            className="action-button"
            aria-disabled={busy}
            onClick={() => {
              if (busy) return;
              void prepareNow(occurrenceKey);
            }}
          >
            {busy ? "Preparing…" : "Prepare now"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The Debrief index entry that answers this Meeting: the index rows are keyed
 * by Transcript, so the Meeting's Transcripts select the rows and the best
 * Run answers. A finished Run with review state wins over a Run still
 * extracting; anything else keeps arrival order.
 */
function pickDebriefEntry(
  entries: MeetingDebriefIndexEntry[],
  transcriptIds: string[],
): MeetingDebriefIndexEntry | undefined {
  const matches = entries.filter((entry) => transcriptIds.includes(entry.transcriptId));
  if (matches.length === 0) return undefined;
  const rank = (entry: MeetingDebriefIndexEntry): number => {
    if (entry.status === "done" && entry.reviewState !== null) return 0;
    if (entry.status === "done") return 1;
    if (entry.status === "pending" || entry.status === "running") return 2;
    return 3;
  };
  return [...matches].sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * The Debrief tab's state suffix. A Debrief no longer waits for anyone, so the
 * only state worth putting beside the tab label is that its outward writes
 * have gone out; an unpublished one is simply the Debrief.
 */
function debriefTabState(entry: MeetingDebriefIndexEntry | undefined): string | null {
  return entry?.reviewState === "published" ? "published" : null;
}

/**
 * The Debrief tab: the Meeting Debrief for this Meeting's Transcript,
 * resolved through the existing routes — the Meeting's Transcripts select
 * the Debrief index row, and the row's Run id reads the detail. Renders the
 * effectiveness evidence and coaching advice with a link into the full
 * Debrief journey; without a Transcript the tab names the absence instead
 * of rendering an empty panel.
 */
function MeetingDebriefTab({
  transcripts,
  entry,
  indexReady,
  indexError,
  refreshIndex,
  client,
}: {
  transcripts: { id: string; title: string }[] | null;
  entry: MeetingDebriefIndexEntry | undefined;
  indexReady: boolean;
  indexError: string | null;
  refreshIndex: () => void;
  client: MeetingsClient;
}) {
  const [detail, setDetail] = useState<MeetingDebriefDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const runId = entry?.runId ?? null;

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    client
      .meetingDebriefDetail(runId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setDetailError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [client, runId, detailAttempt]);

  if (transcripts === null || !indexReady) {
    return (
      <p className="muted" role="status">
        Loading debrief…
      </p>
    );
  }

  if (transcripts.length === 0) {
    return (
      <div>
        <p className="muted">
          Meeting debrief is not available yet — no transcript has been matched to this meeting.
        </p>
        <p>
          <Link to="/meeting-debrief">Open the Meeting Debrief journey</Link>
        </p>
      </div>
    );
  }

  if (indexError && !entry) {
    return (
      <div className="banner banner-error" role="alert">
        {indexError}{" "}
        <button type="button" onClick={refreshIndex}>
          Retry
        </button>
      </div>
    );
  }

  if (!entry) {
    return (
      <div>
        <p className="muted">
          Meeting debrief is not available yet — the matched transcript has no debrief yet.
        </p>
        <p>
          <Link to="/meeting-debrief">Open the Meeting Debrief journey</Link>
        </p>
      </div>
    );
  }

  if (detailError) {
    return (
      <div className="banner banner-error" role="alert">
        {detailError}{" "}
        <button type="button" onClick={() => setDetailAttempt((attempt) => attempt + 1)}>
          Retry
        </button>
      </div>
    );
  }

  if (!detail) {
    return (
      <p className="muted" role="status">
        Loading debrief…
      </p>
    );
  }

  if (!detail.extraction) {
    return (
      <div>
        <p className="muted">No extraction yet — the debrief is {detail.status}.</p>
        <p>
          <Link to={`/meeting-debrief/${encodeURIComponent(detail.runId)}`}>Open the debrief</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <p className="muted">
        {detail.review?.state === "published" ? (
          <span className="status-badge status-ok" role="status">
            Email draft created
          </span>
        ) : null}
      </p>
      <h3>Summary</h3>
      <p>{detail.extraction.summary}</p>
      <h3>Effectiveness evidence</h3>
      <p>{detail.extraction.effectivenessEvidence}</p>
      <h3>Coaching advice</h3>
      <p>{detail.extraction.coachingAdvice}</p>
      <p>
        <Link to={`/meeting-debrief/${encodeURIComponent(detail.runId)}`}>
          Open the full debrief
        </Link>
      </p>
    </div>
  );
}

/**
 * The transcript-orphan notice (issue #154): a Meeting created from a
 * Transcript alone carries no Calendar occurrence, so the page names that
 * and offers the nearest Calendar Meetings as merge targets. The section id
 * is the stable anchor the tab work wraps around; merging navigates to the
 * surviving Meeting because this record is forgotten by the merge.
 */
function TranscriptOrphanNotice({
  meetingId,
  client,
}: {
  meetingId: string;
  client: MeetingsClient;
}) {
  const navigate = useNavigate();
  const [nearMatches, setNearMatches] = useState<Meeting[] | null>(null);
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .meetingNearMatches(meetingId)
      .then((result) => {
        if (!cancelled) setNearMatches(result.nearMatches);
      })
      .catch(() => {
        if (!cancelled) setNearMatches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, meetingId]);

  async function merge(target: Meeting) {
    if (!target.occurrenceKey || mergingId) return;
    setMergingId(target.id);
    setMergeError(null);
    try {
      const survivor = await client.mergeMeeting(meetingId, {
        targetOccurrenceKey: target.occurrenceKey,
      });
      void navigate(`/meetings/${survivor.id}`);
    } catch (cause: unknown) {
      setMergeError(errorMessage(cause));
      setMergingId(null);
    }
  }

  return (
    <section id="transcript-orphan-notice" aria-labelledby="transcript-orphan-notice-heading">
      <h2 id="transcript-orphan-notice-heading">Created from a transcript</h2>
      <p className="muted">
        No calendar event matches this transcript yet, so the Meeting holds the transcript&apos;s
        own record. Pick the calendar meeting it belongs to and the transcript carries across.
      </p>
      {mergeError ? (
        <div className="banner banner-error" role="alert">
          {mergeError}
        </div>
      ) : null}
      {!nearMatches ? (
        <p className="muted" role="status">
          Looking for nearby meetings…
        </p>
      ) : nearMatches.length === 0 ? (
        <p className="muted">No nearby calendar meeting found.</p>
      ) : (
        <ul className="card-list">
          {nearMatches.map((candidate) => (
            <li key={candidate.id} className="card">
              <h3>{candidate.title}</h3>
              <p>
                <time dateTime={candidate.startAt}>{formatMeetingTime(candidate.startAt)}</time>
              </p>
              <p>
                <button
                  type="button"
                  disabled={mergingId !== null}
                  onClick={() => void merge(candidate)}
                >
                  {mergingId === candidate.id ? "Merging…" : "Merge into this meeting"}
                </button>
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One Meeting's page (ADR-0050): the durable record, addressed by the
 * Meeting's own identity rather than by a Calendar occurrence key, because a
 * Meeting may have no occurrence at all.
 *
 * Facts and participants sit on top; the Brief and Debrief tabs render
 * beneath. This component owns the tab shell.
 */
export function MeetingPage({ client = meetingsApi }: { client?: MeetingsClient }) {
  const { meetingId } = useParams<{ meetingId: string }>();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [transcripts, setTranscripts] = useState<{ id: string; title: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tabOverride, setTabOverride] = useState<MeetingTab | null>(null);
  const [debriefEntries, setDebriefEntries] = useState<MeetingDebriefIndexEntry[] | null>(null);
  const [debriefIndexError, setDebriefIndexError] = useState<string | null>(null);
  const headingRef = usePageFocus<HTMLHeadingElement>();
  useTitle(meeting ? meeting.title : "Meeting");

  useEffect(() => {
    if (!meetingId) return;
    let cancelled = false;
    client
      .meeting(meetingId)
      .then((result) => {
        if (!cancelled) setMeeting(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    client
      .meetingTranscripts(meetingId)
      .then((result) => {
        if (!cancelled) setTranscripts(result.transcripts);
      })
      .catch(() => {
        if (!cancelled) setTranscripts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, meetingId]);
  const refreshDebriefIndex = useCallback(() => {
    client
      .meetingDebriefIndex()
      .then((result) => {
        setDebriefEntries(result.entries);
        setDebriefIndexError(null);
      })
      .catch((cause: unknown) => {
        setDebriefIndexError(errorMessage(cause));
      });
  }, [client]);

  useEffect(() => {
    refreshDebriefIndex();
  }, [refreshDebriefIndex]);

  const debriefEntry = useMemo(() => {
    if (!debriefEntries || !transcripts) return undefined;
    return pickDebriefEntry(
      debriefEntries,
      transcripts.map((transcript) => transcript.id),
    );
  }, [debriefEntries, transcripts]);
  const debriefState = debriefTabState(debriefEntry);
  const defaultTab: MeetingTab =
    meeting && Number.isFinite(Date.parse(meeting.endAt)) && Date.parse(meeting.endAt) <= Date.now()
      ? "debrief"
      : "brief";
  const tab = tabOverride ?? defaultTab;
  const briefTabRef = useRef<HTMLButtonElement>(null);
  const debriefTabRef = useRef<HTMLButtonElement>(null);
  /* Left/Right wrap around the two tabs, Home/End jump to the ends. Selection
     follows focus: only the selected panel is mounted, so arrowing across does
     fetch, but both panels read from indexes this page has already asked for
     and the wait is a spinner in place rather than a navigation. */
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const order: MeetingTab[] = ["brief", "debrief"];
    const current = order.indexOf(tab);
    let next: MeetingTab | null = null;
    if (event.key === "ArrowRight") next = order[(current + 1) % order.length]!;
    else if (event.key === "ArrowLeft") next = order[(current - 1 + order.length) % order.length]!;
    else if (event.key === "Home") next = order[0]!;
    else if (event.key === "End") next = order[order.length - 1]!;
    if (!next) return;
    event.preventDefault();
    setTabOverride(next);
    (next === "brief" ? briefTabRef : debriefTabRef).current?.focus();
  };

  if (error) {
    return (
      <div className="page">
        <h1 ref={headingRef} tabIndex={-1}>
          Meeting
        </h1>
        <div className="banner banner-error" role="alert">
          {error}
        </div>
        <p>
          <Link to="/meetings">Back to the Meeting Wizard</Link>
        </p>
      </div>
    );
  }

  if (!meeting) {
    return (
      <div className="page">
        <h1 ref={headingRef} tabIndex={-1}>
          Meeting
        </h1>
        <p className="muted" role="status">
          Loading meeting…
        </p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1 ref={headingRef} tabIndex={-1}>
        {meeting.title}
      </h1>
      <p className="muted">
        <time dateTime={meeting.startAt}>{formatMeetingTime(meeting.startAt)}</time>
        {/* A transcript-derived Meeting has no duration to state, so an end
            equal to its start is silence rather than "9:00 AM — 9:00 AM". */}
        {meeting.endAt !== meeting.startAt ? (
          <>
            {" — "}
            <time dateTime={meeting.endAt}>{formatMeetingEndTime(meeting.endAt)}</time>
          </>
        ) : null}
        {meeting.cancelled ? (
          <>
            {" · "}
            <span className="status-badge status-active">Cancelled</span>
          </>
        ) : null}
      </p>

      {meeting.ineligibleReason ? (
        <p className="muted">{INELIGIBILITY_LABELS[meeting.ineligibleReason]}</p>
      ) : null}

      <section aria-labelledby="meeting-participants-heading">
        <h2 id="meeting-participants-heading">Participants</h2>
        {meeting.participants.length === 0 ? (
          <p className="muted">Calendar listed no participants for this meeting.</p>
        ) : (
          /* A roster reads as a list, not as a stack of cards: four
             participants used to fill most of the first screen, and each one
             printed its email twice when Calendar gave no display name. */
          <ul className="roster-list">
            {meeting.participants.map((participant, index) => (
              <li key={`${participant.email}::${participant.displayName ?? ""}::${index}`}>
                {participant.displayName ?? participant.email}
                <span className="muted">
                  {/* A transcript-derived participant is a speaker name with no
                      address, so the email clause has to disappear entirely
                      rather than leave its separator behind. */}
                  {participant.displayName && participant.email ? ` · ${participant.email}` : ""}
                  {` · ${RESPONSE_LABELS[participant.responseStatus]}`}
                  {participant.organizer ? " · Organizer" : ""}
                  {participant.self ? " · You" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {/* --- transcript-orphan slot (issue #154) — start. This section stays a
          clearly delimited block so the orphan notice can anchor here; the
          Brief/Debrief tabs below wrap around it without touching it. --- */}
      <section aria-labelledby="meeting-transcripts-heading">
        <h2 id="meeting-transcripts-heading">Transcripts</h2>
        {!transcripts ? (
          <p className="muted" role="status">
            Loading transcripts…
          </p>
        ) : transcripts.length === 0 ? (
          <p className="muted">No transcript matched yet.</p>
        ) : (
          <ul className="card-list">
            {transcripts.map((transcript) => (
              <li key={transcript.id} className="card">
                <h3>{transcript.title}</h3>
              </li>
            ))}
          </ul>
        )}
      </section>
      {meeting.occurrenceKey === null ? (
        <TranscriptOrphanNotice meetingId={meeting.id} client={client} />
      ) : null}
      {/* --- transcript-orphan slot (issue #154) — end --- */}

      {/* The ARIA tabs pattern, kept whole: exactly one tab is in the tab
          order (roving tabindex) and the arrow keys move between them. The
          role was already declared here; without these the contract was a
          promise to assistive technology that the page did not keep. */}
      <div role="tablist" aria-label="Meeting detail" onKeyDown={onTabKeyDown}>
        <button
          type="button"
          role="tab"
          id="meeting-tab-brief"
          ref={briefTabRef}
          tabIndex={tab === "brief" ? 0 : -1}
          aria-selected={tab === "brief"}
          aria-controls="meeting-tabpanel-brief"
          onClick={() => setTabOverride("brief")}
        >
          <TabLabel label="Brief" />
        </button>
        <button
          type="button"
          role="tab"
          id="meeting-tab-debrief"
          ref={debriefTabRef}
          tabIndex={tab === "debrief" ? 0 : -1}
          aria-selected={tab === "debrief"}
          aria-controls="meeting-tabpanel-debrief"
          onClick={() => setTabOverride("debrief")}
        >
          <TabLabel label="Debrief" state={debriefState} />
        </button>
      </div>

      {tab === "brief" ? (
        <div role="tabpanel" id="meeting-tabpanel-brief" aria-labelledby="meeting-tab-brief">
          <MeetingBriefTab meeting={meeting} client={client} />
        </div>
      ) : (
        <div role="tabpanel" id="meeting-tabpanel-debrief" aria-labelledby="meeting-tab-debrief">
          <MeetingDebriefTab
            transcripts={transcripts}
            entry={debriefEntry}
            indexReady={debriefEntries !== null}
            indexError={debriefIndexError}
            refreshIndex={refreshDebriefIndex}
            client={client}
          />
        </div>
      )}

      <p>
        <Link to="/meetings">Back to the Meeting Wizard</Link>
      </p>
    </div>
  );
}
