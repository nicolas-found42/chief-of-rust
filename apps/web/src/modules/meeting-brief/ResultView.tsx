import { useEffect, useState } from "react";
import type {
  MeetingBriefPersonProfileReadModel,
  MeetingBriefRunResult,
  RunDetail,
} from "@chief-of-staff-demo/shared";
import { Link, useNavigate } from "react-router-dom";
import { errorMessage } from "../../client";
import { meetingsApi, type MeetingsClient } from "../../clients/meetings";
import { deliveryPresentation } from "./deliveryStatus";

export function MeetingBriefResultView({
  detail,
  client = meetingsApi,
}: {
  detail: RunDetail;
  client?: MeetingsClient;
}) {
  const navigate = useNavigate();
  const [profileReadModel, setProfileReadModel] =
    useState<MeetingBriefPersonProfileReadModel | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerationError, setRegenerationError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void client
      .meetingBriefProfileConsumers(detail.id)
      .then((readModel) => {
        if (current) setProfileReadModel(readModel);
      })
      .catch(() => {
        if (current) setProfileReadModel(null);
      });
    return () => {
      current = false;
    };
  }, [client, detail.id]);
  const result = detail.result as MeetingBriefRunResult | null;
  if (!result) {
    if (detail.status === "skipped") {
      return (
        <section aria-labelledby="meeting-brief-result">
          <h2 id="meeting-brief-result">Meeting Brief</h2>
          <p className="muted">
            This meeting was not eligible at preparation time — no brief was produced.
          </p>
          {detail.skipReason ? <p role="status">{detail.skipReason}</p> : null}
        </section>
      );
    }
    return null;
  }
  const brief = result.meetingBrief;
  const delivery = result.delivery;
  const deliveryStatus = deliveryPresentation(delivery.status);
  const logistics = brief.logistics;
  const staleProfileConsumers = (profileReadModel?.consumers ?? []).filter(
    (consumer) => consumer.state?.refreshRequired,
  );
  const regenerate = async () => {
    if (regenerating) return;
    setRegenerating(true);
    setRegenerationError(null);
    try {
      const refreshed = await client.regenerateMeetingBrief(detail.id);
      await navigate(`/runs/${refreshed.runId}`);
    } catch (error) {
      setRegenerationError(errorMessage(error));
      setRegenerating(false);
    }
  };

  return (
    <section aria-labelledby="meeting-brief-result">
      <h2 id="meeting-brief-result">Meeting Brief</h2>

      {result.supersedes ? (
        <p className="muted" role="status">
          Revision of <Link to={`/runs/${result.supersedes}`}>previous brief</Link> (supersedes{" "}
          {result.supersedes})
        </p>
      ) : null}

      {staleProfileConsumers.length > 0 ? (
        <div className="banner banner-warn" role="alert">
          <strong>Profile-derived claims need refresh.</strong> This immutable Brief used Profile
          evidence that was later corrected, merged, or detached. It cannot be retried in place;
          regenerate it from current Profile truth.
          <ul>
            {staleProfileConsumers.map(({ link, state }) => (
              <li key={`${link.guestEmail}-${link.profileId}-${link.profileRevision}`}>
                {link.guestEmail}: revision {link.profileRevision} of{" "}
                <Link to={`/people/${state?.currentProfileId ?? link.profileId}`}>
                  {state?.currentProfileId ?? link.profileId}
                </Link>
              </li>
            ))}
          </ul>
          <button type="button" className="primary" onClick={() => void regenerate()}>
            {regenerating ? "Regenerating…" : "Regenerate with current profiles"}
          </button>
          {regenerationError ? <p>{regenerationError}</p> : null}
        </div>
      ) : null}

      <div className="card">
        <h3>Logistics</h3>
        <dl className="receipt-grid">
          <div className="receipt-row">
            <dt>Title</dt>
            <dd>{logistics.title}</dd>
          </div>
          <div className="receipt-row">
            <dt>Start</dt>
            <dd>
              <time dateTime={logistics.startAt}>
                {new Date(logistics.startAt).toLocaleString()}
              </time>
            </dd>
          </div>
          <div className="receipt-row">
            <dt>End</dt>
            <dd>
              <time dateTime={logistics.endAt}>{new Date(logistics.endAt).toLocaleString()}</time>
            </dd>
          </div>
          <div className="receipt-row">
            <dt>Location</dt>
            <dd>{logistics.location ?? "—"}</dd>
          </div>
          <div className="receipt-row">
            <dt>Conference link</dt>
            <dd>
              {logistics.conferenceLink ? (
                <a href={logistics.conferenceLink} target="_blank" rel="noreferrer">
                  {logistics.conferenceLink}{" "}
                  <span className="visually-hidden">(opens in a new tab)</span>
                </a>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div className="receipt-row">
            <dt>Event version</dt>
            <dd>{result.eventVersion}</dd>
          </div>
          <div className="receipt-row">
            <dt>Occurrence</dt>
            <dd>{result.occurrenceKey}</dd>
          </div>
        </dl>
      </div>

      {brief.guests.length > 0 ? (
        <div className="card">
          <h3>Guests</h3>
          <ul>
            {brief.guests.map((guest) => (
              <li key={guest.email}>
                <strong>{guest.name ? `${guest.name} — ${guest.email}` : guest.email}</strong>
                {guest.role ? <div className="muted">Role: {guest.role}</div> : null}
                {guest.background ? <div>{guest.background}</div> : null}
                {guest.relationshipHistory.length > 0 ? (
                  <div className="muted">History: {guest.relationshipHistory.join(" · ")}</div>
                ) : null}
                {guest.crmContext ? <div className="muted">CRM: {guest.crmContext}</div> : null}
                {guest.talkingPoints.length > 0 ? (
                  <ul>
                    {guest.talkingPoints.map((point, idx) => (
                      <li key={idx}>{point}</li>
                    ))}
                  </ul>
                ) : null}
                {guest.uncertainty.length > 0 ? (
                  <p className="muted">Uncertainty: {guest.uncertainty.join("; ")}</p>
                ) : null}
                {guest.evidenceReferences.length > 0 ? (
                  <p className="muted">
                    Evidence:{" "}
                    {guest.evidenceReferences.map((ref, idx) => (
                      <span key={idx}>
                        <a href={ref} target="_blank" rel="noreferrer">
                          {ref}
                        </a>
                        {idx < guest.evidenceReferences.length - 1 ? ", " : ""}
                      </span>
                    ))}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {brief.companies.length > 0 ? (
        <div className="card">
          <h3>Companies</h3>
          <ul>
            {brief.companies.map((company) => (
              <li key={company.name}>
                <strong>
                  {company.name} {company.domain ? `(${company.domain})` : ""}
                </strong>
                {company.hubspotContext ? (
                  <div className="muted">{company.hubspotContext}</div>
                ) : null}
                {company.docs.length > 0 ? <div>Docs: {company.docs.join(", ")}</div> : null}
                {company.news.length > 0 ? <div>News: {company.news.join(" · ")}</div> : null}
                {company.industry.length > 0 ? (
                  <div>Industry: {company.industry.join(" · ")}</div>
                ) : null}
                {company.uncertainty.length > 0 ? (
                  <p className="muted">Uncertainty: {company.uncertainty.join("; ")}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {brief.conversationStarters.length > 0 ? (
        <div className="card">
          <h3>Conversation starters</h3>
          <ol>
            {brief.conversationStarters.map((starter, idx) => (
              <li key={idx}>{starter}</li>
            ))}
          </ol>
        </div>
      ) : null}

      <div className="card">
        <h3>Sources</h3>
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
        ) : (
          <p className="muted">No source references</p>
        )}
        {brief.missingEvidence.length > 0 ? (
          <div className="banner banner-warn" role="status" aria-label="Missing evidence warnings">
            <p>
              <strong>Missing evidence</strong>
            </p>
            <ul>
              {brief.missingEvidence.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {brief.uncertainty.length > 0 ? (
          <div className="banner banner-warn" role="status">
            <p>
              <strong>Uncertainty</strong>
            </p>
            <ul>
              {brief.uncertainty.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="card">
        <h3>Delivery</h3>
        <p role="status">
          <span className={`status-badge ${deliveryStatus.className}`}>{deliveryStatus.label}</span>{" "}
          {delivery.attempts > 0 ? `· attempts: ${delivery.attempts}` : ""}
        </p>
        {delivery.recipient ? <p>Recipient: {delivery.recipient}</p> : null}
        {delivery.messageId ? <p>Message ID: {delivery.messageId}</p> : null}
        {delivery.deliveryId ? <p>Delivery ID: {delivery.deliveryId}</p> : null}
        {delivery.sentAt ? (
          <p>
            Sent at:{" "}
            <time dateTime={delivery.sentAt}>{new Date(delivery.sentAt).toLocaleString()}</time>
          </p>
        ) : null}
        {deliveryStatus.explanation ? (
          <p
            className={deliveryStatus.isError ? "field-error" : "muted"}
            role={deliveryStatus.isError ? "alert" : undefined}
          >
            {deliveryStatus.explanation}
          </p>
        ) : null}
        <p className="muted">
          Delivery is fixed to the workspace owner&apos;s connected Google identity; External Guests
          are never emailed.
        </p>
      </div>
      <details className="disclosure">
        <summary>Source JSON</summary>
        <pre>{JSON.stringify(brief, null, 2)}</pre>
      </details>
    </section>
  );
}
