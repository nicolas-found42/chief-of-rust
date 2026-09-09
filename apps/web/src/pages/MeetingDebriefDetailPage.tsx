import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  ActionItem,
  MeetingDebriefDetail,
  MeetingDebriefField,
} from "@chief-of-staff-demo/shared";
import { MEETING_DEBRIEF_FIELDS } from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import { peopleApi } from "../clients/people";
import { meetingsApi, type MeetingsClient } from "../clients/meetings";
import { tasksApi, type TasksClient } from "../clients/tasks";
import { formatMeetingTime, statusLabel } from "../display";
import { meetingDebriefDetailName } from "../modules/meeting-debrief/naming";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

const FIELD_LABELS: Record<(typeof MEETING_DEBRIEF_FIELDS)[number], string> = {
  summary: "Summary",
  decisions: "Decisions",
  actionItems: "Action items",
  openQuestions: "Open questions",
  effectivenessEvidence: "Effectiveness evidence",
  coachingAdvice: "Coaching advice",
};

const BLOCKER_LABELS: Record<string, string> = {
  "owner-identity-unconfirmed":
    "The workspace owner's Google identity is not confirmed in Settings.",
  "roster-unconfirmed": "The attendee roster is not confirmed yet.",
};

function blockerLabel(blocker: string): string {
  const known = BLOCKER_LABELS[blocker];
  if (known) return known;
  if (blocker.startsWith("attendee-unverified-email:")) {
    const email = blocker.slice("attendee-unverified-email:".length);
    return `${email} has no Person Profile with a verified (Calendar-anchored) email.`;
  }
  return blocker;
}

/** Where the owner goes to clear one blocker, when this page can settle it. */
function blockerTarget(blocker: string): string | null {
  if (blocker === "roster-unconfirmed") return "#debrief-roster";
  if (blocker === "owner-identity-unconfirmed") return "/settings";
  return null;
}

/**
 * What the Debrief extracted. A record of the meeting, and only that: the
 * decisions the owner takes on a proposed commitment belong to its canonical
 * Action Item, which has a stable identity this array does not (issue #199).
 */
function ExtractionSection({ detail }: { detail: MeetingDebriefDetail }) {
  const debrief = detail.extraction;
  if (!debrief) {
    return (
      <section aria-labelledby="debrief-extraction">
        <h2 id="debrief-extraction">Extraction</h2>
        <p className="muted">No extraction yet — the debrief is {statusLabel(detail.status)}.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="debrief-extraction">
      <h2 id="debrief-extraction">Extraction</h2>
      <h3>Summary</h3>
      <p>{debrief.summary}</p>
      <h3>Decisions</h3>
      {debrief.decisions.length === 0 ? (
        <p className="muted">No decisions recorded.</p>
      ) : (
        <ul>
          {debrief.decisions.map((decision, index) => (
            <li key={index}>
              {decision.statement}
              {decision.evidence && <span className="muted"> — “{decision.evidence}”</span>}
            </li>
          ))}
        </ul>
      )}
      <h3>Action items</h3>
      {debrief.actionItems.length === 0 ? (
        <p className="muted">No action items.</p>
      ) : (
        <ul>
          {debrief.actionItems.map((item, index) => (
            <li key={index}>
              {item.title} — owner: {item.owner ?? "unassigned"}
              {item.ownerProfileId && (
                <>
                  {" "}
                  <Link to={`/people/${encodeURIComponent(item.ownerProfileId)}`}>
                    (confirmed Profile)
                  </Link>
                </>
              )}
              {!item.ownerProfileId && item.ownerMentionId && (
                <span className="muted"> (identity not confirmed)</span>
              )}
              {item.dueDate && <span className="muted"> — due {item.dueDate}</span>}
            </li>
          ))}
        </ul>
      )}
      {/* What the meeting proposed is above; what the owner decided is a
          canonical Action Item with a stable identity, and it is reviewed
          where it lives (issues #177, #199). This page no longer carries
          positional Done and Dismiss buttons, because an index into an
          extracted array is not an identity a decision can be pinned to. */}
      {debrief.actionItems.length > 0 && (
        <p className="muted">
          These are the commitments the meeting proposed. Review them — create a Task, create a
          completed Task, or dismiss — in <Link to="/tasks#action-items">Tasks</Link>, where each
          one has a stable identity of its own that regenerating this Debrief cannot disturb.
        </p>
      )}
      <h3>Open questions</h3>
      {debrief.openQuestions.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul>
          {debrief.openQuestions.map((question, index) => (
            <li key={index}>
              {question.question}
              {question.raisedBy && <span className="muted"> — raised by {question.raisedBy}</span>}
            </li>
          ))}
        </ul>
      )}
      <h3>Effectiveness evidence</h3>
      <p>{debrief.effectivenessEvidence}</p>
      <h3>Coaching advice</h3>
      <p>{debrief.coachingAdvice}</p>
    </section>
  );
}

/**
 * People and organizations the Catalog found in the transcript.
 *
 * Mentions are per-span: a name spoken three hundred times is three hundred
 * mentions of the same person. Listed one per span this section ran to tens of
 * thousands of rows and buried the Debrief above it, so it groups by name and
 * counts, and shows the most-mentioned first. The rest stay one disclosure
 * away rather than being dropped.
 */
const IDENTITY_ROWS_SHOWN = 12;

interface NamedMention {
  mentionId: string;
  surfaceText: string;
}

/** One row per distinct name, most mentioned first, ties broken alphabetically. */
function groupMentions(mentions: NamedMention[]): { name: string; count: number; key: string }[] {
  const byName = new Map<string, { name: string; count: number; key: string }>();
  for (const mention of mentions) {
    const name = mention.surfaceText.trim();
    if (name === "") continue;
    const key = name.toLocaleLowerCase();
    const found = byName.get(key);
    if (found) found.count += 1;
    else byName.set(key, { name, count: 1, key });
  }
  return [...byName.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function MentionList({ mentions, empty }: { mentions: NamedMention[]; empty: string }) {
  const [expanded, setExpanded] = useState(false);
  const groups = groupMentions(mentions);
  if (groups.length === 0) return <p className="muted">{empty}</p>;
  const shown = expanded ? groups : groups.slice(0, IDENTITY_ROWS_SHOWN);
  const hidden = groups.length - shown.length;
  return (
    <>
      <p className="muted">
        {groups.length} name{groups.length === 1 ? "" : "s"} across {mentions.length} mention
        {mentions.length === 1 ? "" : "s"}.
      </p>
      <ul className="mention-list">
        {shown.map((group) => (
          <li key={group.key}>
            {group.name}
            {group.count > 1 ? <span className="muted"> ×{group.count}</span> : null}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" className="action-button" onClick={() => setExpanded(true)}>
          Show {hidden} more
        </button>
      )}
    </>
  );
}

function IdentitySection({ detail }: { detail: MeetingDebriefDetail }) {
  const identity = detail.identity;
  return (
    <section aria-labelledby="debrief-identity">
      <h2 id="debrief-identity">Who and what was mentioned</h2>
      <h3>Matched to a Person Profile</h3>
      {identity.resolved.length === 0 ? (
        <p className="muted">No mention matched a Person Profile.</p>
      ) : (
        <ul className="mention-list">
          {identity.resolved.map((resolved) => (
            <li key={resolved.mentionId}>
              {resolved.surfaceText} —{" "}
              <Link to={`/people/${encodeURIComponent(resolved.profileId)}`}>Profile</Link>
            </li>
          ))}
        </ul>
      )}
      <h3>Other names heard</h3>
      <MentionList mentions={identity.unresolved} empty="No other names were picked up." />
      <h3>Organizations</h3>
      <MentionList mentions={identity.organizations} empty="No organizations mentioned." />
    </section>
  );
}

const STATE_LABELS: Record<string, string> = {
  extracted: "Extracted",
  published: "Email draft created",
};

/**
 * One owner turn against a Debrief: run it, then re-read the detail. Held by
 * the page rather than by one section, because the action items above and the
 * roster and recipients below are all turns on the same Run.
 */
function useDebriefActions(onChanged: () => Promise<void> | void) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = useCallback(
    (run: () => Promise<unknown>) => {
      setBusy(true);
      setActionError(null);
      run()
        .then(() => onChanged())
        .catch((err: unknown) => setActionError(errorMessage(err)))
        .finally(() => setBusy(false));
    },
    [onChanged],
  );

  return { busy, actionError, setActionError, act };
}

type DebriefActions = ReturnType<typeof useDebriefActions>;

function ReviewSection({
  detail,
  actions,
  client,
}: {
  detail: MeetingDebriefDetail;
  actions: DebriefActions;
  client: MeetingsClient;
}) {
  const review = detail.review;
  const { busy, actionError, setActionError, act } = actions;
  const [rosterDraft, setRosterDraft] = useState("");
  const [recipientQuery, setRecipientQuery] = useState("");
  const [matches, setMatches] = useState<
    Array<{ id: string; fullName: string | null; primaryEmail: string | null }>
  >([]);

  const searchProfiles = useCallback(
    async (query: string) => {
      setActionError(null);
      try {
        setMatches(
          (await peopleApi.people(query)).map((profile) => ({
            id: profile.id,
            fullName: profile.fullName,
            primaryEmail: profile.primaryEmail,
          })),
        );
      } catch (err) {
        setActionError(errorMessage(err));
      }
    },
    [setActionError],
  );

  if (!review) return null;

  /* Everything stays editable until the outward writes go out. Publishing is
     what locks a Debrief — nothing else ever did, and waiting for review no
     longer does. */
  const actionable = review.state !== "published";
  /* The speakers the transcript recorded, in the roster field's own syntax and
     awaiting their emails. */
  const speakerDraft = detail.speakers.map((speaker) => `${speaker} <>`).join(", ");
  /* What to show as the roster: the confirmed one, else Calendar's prefill. */
  const rosterShown: { email: string; displayName: string | null; profileId?: string | null }[] =
    review.roster.entries.length > 0 ? review.roster.entries : detail.roster;
  /* The prefill the owner would be confirming, in the field's own syntax. */
  const prefillDraft = detail.roster
    .map((person) =>
      person.displayName ? `${person.displayName} <${person.email}>` : person.email,
    )
    .join(", ");
  const entryDraft = rosterDraft
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const emailMatch = /<([^>]+)>|([^\s<]+@[^\s<]+\.[^\s<]+)/.exec(part);
      const email = emailMatch?.[1] ?? emailMatch?.[2] ?? "";
      const name = part
        .replace(/<[^>]*>/, "")
        .replace(/[^\s<]+@[^\s<]+\.[^\s<]+/, "")
        .trim();
      return email ? { email, displayName: name || null } : null;
    })
    .filter((entry): entry is { email: string; displayName: string | null } => entry !== null);

  return (
    <section aria-labelledby="debrief-review">
      <h2 id="debrief-review">Review</h2>
      <p
        className={`status-badge ${review.state === "published" ? "status-ok" : ""}`}
        role="status"
      >
        {STATE_LABELS[review.state] ?? review.state}
      </p>
      {review.duplicateWarning && (
        <p className="banner-error" role="alert">
          Duplicate output warning: this transcript already has a published Debrief (
          <Link
            to={`/meeting-debrief/${encodeURIComponent(review.duplicateWarning.approvedRunId)}`}
          >
            {review.duplicateWarning.approvedRunId}
          </Link>
          ). Redoing it may duplicate its Gmail draft and owner Tasks.
        </p>
      )}
      {actionError && (
        <p className="banner-error" role="alert">
          {actionError}
        </p>
      )}
      {busy && <p className="muted">Working…</p>}

      {actionable && (
        <>
          <h3>Regenerate a field</h3>
          <p className="muted">
            Regeneration re-extracts from the immutable transcript — the rejected value is never
            shown to the model again. Regenerating action items clears earlier done and dismiss
            decisions.
          </p>
          <ul>
            {(Object.keys(FIELD_LABELS) as MeetingDebriefField[]).map((field) => (
              <li key={field}>
                <button
                  type="button"
                  onClick={() => act(() => client.meetingDebriefRegenerate(detail.runId, field))}
                >
                  Regenerate {FIELD_LABELS[field]}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Roster: one section, not two. The page used to state the roster here
          and again in a section of its own below, which disagreed with itself
          the moment either changed. */}
      <h3 id="debrief-roster">Roster confirmation</h3>
      <p className="muted">
        {detail.roster.length > 0
          ? "Prefilled from the meeting's calendar attendees, and waiting to be confirmed."
          : "No calendar attendees to start from, so the roster has to be named here."}
      </p>
      {review.roster.status === "confirmed" ? (
        <p className="status-badge status-ok" role="status">
          Roster confirmed
          {review.roster.confirmedAt ? ` ${formatMeetingTime(review.roster.confirmedAt)}` : ""}.
        </p>
      ) : (
        <p className="status-badge status-attention" role="status">
          Confirm the roster to create the email draft.
        </p>
      )}
      {/* The confirmed roster if there is one, else what Calendar gave the
          record. Reading only the review's own entries, the section announced
          a prefilled roster and then said none was recorded — the prefill
          lives on the Transcript until the owner confirms it. */}
      {rosterShown.length === 0 ? (
        <p className="muted">No roster recorded.</p>
      ) : (
        <ul>
          {rosterShown.map((entry) => (
            <li key={entry.email}>
              {/* Calendar often gives no display name, and "x@y <x@y>" is the
                  same address twice. */}
              {entry.displayName ? `${entry.displayName} <${entry.email}>` : entry.email}
              {entry.profileId ? (
                <>
                  {" "}
                  <Link to={`/people/${encodeURIComponent(entry.profileId)}`}>
                    (confirmed Profile)
                  </Link>
                </>
              ) : (
                <span className="muted"> (no Profile bound)</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {actionable && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (entryDraft.length === 0) return;
            act(() => client.meetingDebriefConfirmRoster(detail.runId, entryDraft));
          }}
        >
          <label htmlFor="debrief-roster-input">
            Roster — one attendee per comma, as “Name &lt;email&gt;” or “email”
          </label>
          <input
            id="debrief-roster-input"
            value={rosterDraft}
            onChange={(event) => setRosterDraft(event.target.value)}
            placeholder="Alice <alice@example.com>, Bob <bob@example.com>"
          />
          <button type="submit" disabled={busy || entryDraft.length === 0}>
            Confirm roster
          </button>
          {/* The transcript already names who spoke. Retyping them was busywork
              the page could do itself; the emails still have to be supplied,
              because a spoken name is not a mailbox. */}
          {rosterDraft === "" && prefillDraft !== "" && (
            <p className="muted">
              From the calendar:{" "}
              <button type="button" onClick={() => setRosterDraft(prefillDraft)}>
                Start from these {detail.roster.length} attendees
              </button>
            </p>
          )}
          {rosterDraft === "" && prefillDraft === "" && speakerDraft !== "" && (
            <p className="muted">
              Heard in the transcript:{" "}
              <button type="button" onClick={() => setRosterDraft(speakerDraft)}>
                Start from {detail.speakers.join(", ")}
              </button>
            </p>
          )}
        </form>
      )}

      <h3>Recipients</h3>
      <p className="muted">
        Every confirmed attendee other than the owner is a recipient automatically. Anyone else
        needs an explicit confirmed Person Profile with a verified email.
      </p>
      <ul>
        {review.automaticRecipients.map((recipient) => (
          <li key={recipient.profileId}>
            {recipient.email} — <span className="muted">automatic (confirmed attendee)</span>{" "}
            <Link to={`/people/${encodeURIComponent(recipient.profileId)}`}>(Profile)</Link>
          </li>
        ))}
        {review.additionalRecipients.map((recipient) => (
          <li key={recipient.profileId}>
            {recipient.email} —{" "}
            <span className="muted">added (confirmed Profile with verified email)</span>{" "}
            <Link to={`/people/${encodeURIComponent(recipient.profileId)}`}>(Profile)</Link>
            {actionable && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() =>
                    act(() =>
                      client.meetingDebriefRemoveRecipient(detail.runId, recipient.profileId),
                    )
                  }
                >
                  Remove
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {review.suggestedRecipients.length > 0 && (
        <p className="muted">
          Suggested from follow-up context:{" "}
          {review.suggestedRecipients
            .map(
              (suggestion) =>
                `${suggestion.name}${suggestion.email ? ` <${suggestion.email}>` : ""}`,
            )
            .join(", ")}
        </p>
      )}
      {actionable && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void searchProfiles(recipientQuery);
          }}
        >
          <label htmlFor="debrief-recipient-search">
            Search Person Profiles to add a recipient
          </label>
          <input
            id="debrief-recipient-search"
            value={recipientQuery}
            onChange={(event) => setRecipientQuery(event.target.value)}
          />
          <button type="submit">Search</button>
        </form>
      )}
      {matches.length > 0 && actionable && (
        <ul>
          {matches.map((profile) => (
            <li key={profile.id}>
              {profile.fullName ?? profile.id}{" "}
              {profile.primaryEmail && ` <${profile.primaryEmail}>`}{" "}
              <Link to={`/people/${encodeURIComponent(profile.id)}`}>(Profile)</Link>{" "}
              <button
                type="button"
                disabled={!profile.primaryEmail}
                onClick={() => {
                  if (profile.primaryEmail) {
                    act(() =>
                      client.meetingDebriefAddRecipient(detail.runId, {
                        profileId: profile.id,
                        email: profile.primaryEmail!,
                      }),
                    );
                  }
                }}
              >
                Add as recipient
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* The one outward write left in the product (issue #182). The Debrief
          itself is finished and readable above; this creates a Gmail draft to
          the confirmed recipients and does nothing else — Tasks come from the
          Action Item queue, which needs no Gmail at all. */}
      <h3>Email draft</h3>
      <p className="muted">
        This creates a draft in Gmail addressed to the confirmed recipients. It does not send the
        email, and it does not create Tasks. Nothing above waits on it — the Debrief is already
        complete, and its Action Items are reviewable on Tasks whether a draft exists or not.
      </p>
      {review.state === "published" ? (
        <div>
          <p>
            Draft created{review.approvedAt ? ` ${formatMeetingTime(review.approvedAt)}` : ""} and
            waiting in Gmail — nothing has been sent. The Debrief, roster, recipients, and decisions
            are locked so they stay aligned with the draft; redo starts a separate debrief.
          </p>
          {review.draft && (
            <p>
              <a href={review.draft.url} target="_blank" rel="noreferrer">
                Open draft in Gmail
              </a>
            </p>
          )}
        </div>
      ) : review.approvalBlockers.length > 0 ? (
        <div>
          <p className="muted" role="status">
            Creating the email draft needs:
          </p>
          {/* Each blocker reaches whatever settles it. The list used to name
              the roster with the roster form a screen away and no way to it. */}
          <ul>
            {review.approvalBlockers.map((blocker) => {
              const target = blockerTarget(blocker);
              return (
                <li key={blocker}>
                  {target ? <a href={target}>{blockerLabel(blocker)}</a> : blockerLabel(blocker)}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => act(() => client.meetingDebriefApprove(detail.runId))}
        >
          Create email draft
        </button>
      )}
      {review.state === "published" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => act(() => client.meetingDebriefRedo(detail.runId))}
        >
          Redo (start a new debrief)
        </button>
      )}
    </section>
  );
}

/**
 * The durable Action Items this Debrief proposed (issue #179): the Debrief's
 * own history of what was pending, promoted or dismissed. A dismissed proposal
 * can be restored to pending here, long after the Undo on the Tasks page is
 * gone; promotion itself stays on Tasks, where the review panel lives.
 */
function ActionItemHistorySection({
  runId,
  tasksClient,
}: {
  runId: string;
  tasksClient: Pick<TasksClient, "actionItems" | "restoreActionItem">;
}) {
  const [items, setItems] = useState<ActionItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await tasksClient.actionItems({ debriefRunId: runId })).items);
    } catch {
      /* History is secondary: the extraction above stays usable when it fails. */
      setItems([]);
    }
  }, [tasksClient, runId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (items === null || items.length === 0) return null;
  return (
    <section aria-labelledby="debrief-action-item-history">
      <h2 id="debrief-action-item-history">Action Item history</h2>
      {failure && (
        <p className="banner-error" role="alert">
          {failure}
        </p>
      )}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            {item.proposal.title}{" "}
            {item.state === "dismissed" && (
              <span className="status-badge status-attention"> Dismissed</span>
            )}
            {item.state === "promoted" && <span className="status-badge status-ok"> Promoted</span>}
            {item.state === "pending" && <span className="muted"> (pending review)</span>}
            {item.state === "promoted" && item.promotedTaskId && (
              <>
                {" "}
                <Link to={`/tasks#task-${item.promotedTaskId}`}>Open the Task</Link>
              </>
            )}
            {item.state === "pending" && (
              <>
                {" "}
                <Link to="/tasks">Review in Tasks</Link>
              </>
            )}
            {item.state === "dismissed" && (
              <>
                {" "}
                <button
                  type="button"
                  aria-disabled={busy}
                  onClick={() => {
                    if (busy) return;
                    setBusy(true);
                    setFailure(null);
                    tasksClient
                      .restoreActionItem(item.id)
                      .then(() => load())
                      .catch((err: unknown) => setFailure(errorMessage(err)))
                      .finally(() => setBusy(false));
                  }}
                >
                  Restore to pending
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * When the meeting was, and — only when there is something to say — what the
 * Debrief is still doing. A finished Debrief says nothing here: the engine's
 * own words for a Run ("Waiting", "Completed") described the Run, not the
 * retrospective, and "Waiting" contradicted the "Extracted" badge and the
 * page's own promise that nothing waits.
 */
function StatusLine({ detail }: { detail: MeetingDebriefDetail }) {
  const unfinished = detail.status !== "done";
  return (
    <p className="muted">
      {detail.meetingDate ?? "No meeting date"}
      {unfinished && ` · ${statusLabel(detail.status)}`}
      {detail.review?.state === "published" && (
        <>
          {" · "}
          <span className="status-badge status-ok" role="status">
            Email draft created
          </span>
        </>
      )}
    </p>
  );
}

export function MeetingDebriefDetailPage({
  client = meetingsApi,
  tasksClient = tasksApi,
}: {
  client?: MeetingsClient;
  tasksClient?: Pick<TasksClient, "actionItems" | "restoreActionItem">;
}) {
  const { runId } = useParams<{ runId: string }>();
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [detail, setDetail] = useState<MeetingDebriefDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [meetingTitles, setMeetingTitles] = useState<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    if (!runId) return;
    setError(null);
    try {
      setDetail(await client.meetingDebriefDetail(runId));
      setNotFound(false);
    } catch (err) {
      if (/404|not found/i.test(errorMessage(err))) {
        setNotFound(true);
      } else {
        setError(errorMessage(err));
      }
    }
  }, [client, runId]);

  const actions = useDebriefActions(refresh);

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

  const name = detail ? meetingDebriefDetailName(detail, meetingTitles) : "Meeting Debrief";
  /* The tab carries the meeting, like every other Meeting Wizard page. A
     constant "Meeting Debrief detail" made two open debriefs indistinguishable
     in the browser's own list of them. */
  useTitle(name);

  return (
    <div className="page">
      <p>
        <Link to="/meeting-debrief">← All Meeting Debriefs</Link>
      </p>
      <h1 ref={headingRef} tabIndex={-1}>
        {name}
      </h1>
      {notFound && (
        <p className="banner-error" role="alert">
          Unknown Meeting Debrief.
        </p>
      )}
      {error && (
        <p className="banner-error" role="alert">
          {error}
        </p>
      )}
      {detail && (
        <>
          <StatusLine detail={detail} />
          {/* The Meeting is where this retrospective belongs, and the Debrief
              already knows which one — the page just never said so. */}
          {detail.meetingId && (
            <p>
              <Link to={`/meetings/${encodeURIComponent(detail.meetingId)}`}>
                Open this meeting
              </Link>
            </p>
          )}
          <ExtractionSection detail={detail} />
          <ReviewSection detail={detail} actions={actions} client={client} />
          <ActionItemHistorySection runId={detail.runId} tasksClient={tasksClient} />
          <IdentitySection detail={detail} />
        </>
      )}
    </div>
  );
}
