import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  TranscriptRelevanceReviewItem,
  TranscriptRelevanceReviewState,
  TranscriptSummary,
  TranscriptDeletionTombstone,
  TranscriptConsumerDisclosure,
} from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import { peopleApi, type PeopleClient } from "../clients/people";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/**
 * The semantic transcript relevance Review surface (spec #117, issue #127):
 * full-corpus discovery is a suggestion lane. Every result arrives as a
 * cited, explained excerpt with its review state, and only an explicit owner
 * decision moves it — confirming relevance never changes a Profile.
 */
const STATE_FILTERS = ["all", "pending", "confirmed", "rejected", "unresolved"] as const;

const REVIEW_STATE_LABEL: Record<TranscriptRelevanceReviewState, string> = {
  pending: "Pending review",
  confirmed: "Confirmed",
  rejected: "Rejected",
  unresolved: "Left unresolved",
};

export function TranscriptReviewPage({ client = peopleApi }: { client?: PeopleClient }) {
  useTitle("Transcript review");
  const focusRef = usePageFocus<HTMLHeadingElement>();
  const [items, setItems] = useState<TranscriptRelevanceReviewItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [meetingTitle, setMeetingTitle] = useState("");
  const [topics, setTopics] = useState("");
  const [stateFilter, setStateFilter] = useState<(typeof STATE_FILTERS)[number]>("all");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptSummary[] | null>(null);
  const [tombstones, setTombstones] = useState<TranscriptDeletionTombstone[]>([]);
  const [confirmations, setConfirmations] = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, TranscriptConsumerDisclosure[]>>({});
  const load = useCallback(async () => {
    try {
      const queue = await client.transcriptRelevanceQueue();
      setItems(queue.items);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [client]);

  const loadCorpus = useCallback(async () => {
    try {
      const [corpus, standing] = await Promise.all([
        client.transcripts(),
        client.transcriptTombstones(),
      ]);
      setTranscripts(corpus.transcripts);
      setTombstones(standing.tombstones);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [client]);

  useEffect(() => {
    void load();
    void loadCorpus();
  }, [load, loadCorpus]);

  const runSearch = async () => {
    setError(null);
    setNotice(null);
    setSearching(true);
    try {
      const topicList = topics
        .split(",")
        .map((topic) => topic.trim())
        .filter((topic) => topic.length > 0);
      const result = await client.searchTranscriptRelevance({
        text: query,
        ...(meetingTitle.trim() || topicList.length > 0
          ? {
              meeting: {
                ...(meetingTitle.trim() ? { title: meetingTitle.trim() } : {}),
                ...(topicList.length > 0 ? { topics: topicList } : {}),
              },
            }
          : {}),
      });
      setItems(result.items);
      setNotice(
        result.items.some((item) => item.reviewState === "pending")
          ? "Search finished. Nothing here is a fact: confirm, reject, or leave each result unresolved."
          : "Search finished. No new relevance candidates.",
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  };

  const decide = async (candidateId: string, action: "confirm" | "reject" | "unresolved") => {
    setError(null);
    setNotice(null);
    try {
      const { item } = await client.decideTranscriptRelevance(candidateId, action);
      setItems((current) =>
        (current ?? []).map((entry) => (entry.candidate.id === candidateId ? item : entry)),
      );
      setNotice(
        action === "confirm"
          ? "Relevance confirmed. It is now an auditable relevance decision — it still does not change any Profile."
          : action === "reject"
            ? "Relevance rejected. The result stays out of every factual consumer."
            : "Left unresolved. The result stays reviewable and non-factual.",
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const visible = (items ?? []).filter(
    (item) => stateFilter === "all" || item.reviewState === stateFilter,
  );

  const deleteTranscript = async (transcriptId: string) => {
    setError(null);
    setNotice(null);
    try {
      const receipt = await client.deleteTranscript(
        transcriptId,
        confirmations[transcriptId] ?? "",
      );
      const { removed } = receipt;
      const removedTotal =
        removed.transcriptRecords +
        removed.identityMentions +
        removed.organizationMentions +
        removed.identityCandidates +
        removed.identityDecisions +
        removed.organizationMergeDecisions +
        removed.transcriptRememberedMappings +
        removed.extractionLedgerEntries +
        removed.relevanceCandidates +
        removed.relevanceDecisions +
        removed.consumerRecords;
      await loadCorpus();
      setConfirmations((current) => ({ ...current, [transcriptId]: "" }));
      setNotice(
        `Transcript deleted. ${removedTotal} local records removed, ` +
          `tombstone written for ${receipt.tombstone.externalFileId}. ` +
          `Remote provider operations: ${receipt.remoteProviderOperations} — the remote Drive source ` +
          `and any previously created Gmail, Tasks, or other provider records remain untouched.`,
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const restoreProcessing = async (externalFileId: string) => {
    setError(null);
    setNotice(null);
    try {
      await client.restoreTranscriptProcessing(externalFileId);
      await loadCorpus();
      setNotice(
        `Processing permission restored for ${externalFileId}. The Catalog will process the file again on its next pass.`,
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <h1 ref={focusRef} tabIndex={-1}>
        Transcript review
      </h1>
      <p className="muted">
        Search the whole retained transcript corpus for conversations relevant to a meeting or a
        topic. Results are suggestions with citations: nothing becomes fact — not a Profile fact,
        not Brief evidence, not an attendee identity — until you confirm it here.
      </p>
      {error && (
        <p className="banner-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="banner-ok" role="status">
          {notice}
        </p>
      )}
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
      >
        <div className="field-row">
          <label htmlFor="relevance-query">Search the transcript corpus</label>
          <input
            id="relevance-query"
            type="search"
            value={query}
            placeholder="e.g. export button timing out on large accounts"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="field-row">
          <label htmlFor="relevance-meeting-title">Meeting title (optional)</label>
          <input
            id="relevance-meeting-title"
            type="text"
            value={meetingTitle}
            onChange={(event) => setMeetingTitle(event.target.value)}
          />
        </div>
        <div className="field-row">
          <label htmlFor="relevance-topics">Topics (optional, comma-separated)</label>
          <input
            id="relevance-topics"
            type="text"
            value={topics}
            onChange={(event) => setTopics(event.target.value)}
          />
        </div>
        <div className="field-row runs-toolbar">
          <button className="action-button primary" type="submit" disabled={searching}>
            {searching ? "Searching…" : "Search transcripts"}
          </button>
          <label htmlFor="relevance-state-filter">Review state</label>
          <select
            id="relevance-state-filter"
            value={stateFilter}
            onChange={(event) =>
              setStateFilter(event.target.value as (typeof STATE_FILTERS)[number])
            }
          >
            {STATE_FILTERS.map((state) => (
              <option key={state} value={state}>
                {state === "all" ? "All states" : REVIEW_STATE_LABEL[state]}
              </option>
            ))}
          </select>
          <Link className="back-link" to="/people">
            Back to Person Profiles
          </Link>
        </div>
      </form>
      {items === null ? (
        <p className="muted">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="muted">
          {items.length === 0
            ? "No relevance candidates yet. Search the corpus to find reviewable excerpts."
            : "No results in that review state."}
        </p>
      ) : (
        <ul className="relevance-list">
          {visible.map((item) => (
            <li key={item.candidate.id} className="card">
              <h2>{item.candidate.sourceContext.fileName}</h2>
              <blockquote>{item.candidate.excerpt.text}</blockquote>
              <dl>
                <dt>Meeting date</dt>
                <dd>{item.candidate.sourceContext.meetingDate ?? "—"}</dd>
                <dt>Relevance explanation</dt>
                <dd>{item.candidate.explanation}</dd>
                <dt>Index or model version</dt>
                <dd>{item.candidate.relevanceVersion}</dd>
                <dt>Review state</dt>
                <dd>{REVIEW_STATE_LABEL[item.reviewState]}</dd>
                {item.decision?.note && (
                  <>
                    <dt>Decision note</dt>
                    <dd>{item.decision.note}</dd>
                  </>
                )}
              </dl>
              {item.candidate.sourceContext.sourceUrl && (
                <p>
                  <a href={item.candidate.sourceContext.sourceUrl}>Open source document</a>
                </p>
              )}
              {item.reviewState === "pending" && (
                <div className="field-row runs-toolbar">
                  <button
                    className="action-button primary"
                    type="button"
                    onClick={() => void decide(item.candidate.id, "confirm")}
                  >
                    Confirm relevance
                  </button>
                  <button
                    className="action-button"
                    type="button"
                    onClick={() => void decide(item.candidate.id, "reject")}
                  >
                    Reject
                  </button>
                  <button
                    className="linklike"
                    type="button"
                    onClick={() => void decide(item.candidate.id, "unresolved")}
                  >
                    Leave unresolved
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <section aria-labelledby="retained-transcripts-heading">
        <h2 id="retained-transcripts-heading">Retained transcripts</h2>
        <p className="muted">
          Deleting a transcript removes every local copy of it — the full text, excerpts, mentions,
          candidates, and your identity and relevance decisions. It deletes nothing remotely: the
          remote Drive source and any previously created Gmail, Tasks, or other provider records
          remain untouched. Type DELETE TRANSCRIPT to confirm.
        </p>
        {transcripts === null ? (
          <p className="muted">Loading…</p>
        ) : transcripts.length === 0 ? (
          <p className="muted">No transcripts are retained locally.</p>
        ) : (
          <ul className="relevance-list">
            {transcripts.map((transcript) => (
              <li key={transcript.id} className="card">
                <h3>{transcript.fileName}</h3>
                <dl>
                  <dt>Meeting date</dt>
                  <dd>{transcript.meetingDate ?? "—"}</dd>
                  <dt>Recorded locally at</dt>
                  <dd>{transcript.ingestedAt}</dd>
                </dl>
                <div className="field-row">
                  <label htmlFor={`delete-confirmation-${transcript.id}`}>
                    Type DELETE TRANSCRIPT to confirm deleting “{transcript.fileName}”
                  </label>
                  <input
                    id={`delete-confirmation-${transcript.id}`}
                    type="text"
                    value={confirmations[transcript.id] ?? ""}
                    onChange={(event) => {
                      setConfirmations((current) => ({
                        ...current,
                        [transcript.id]: event.target.value,
                      }));
                      /* The #122 confirmation pattern: what the cascade will
                         remove is disclosed before the irreversible action. */
                      if (previews[transcript.id] === undefined) {
                        void client
                          .transcriptDeletionPreview(transcript.id)
                          .then((preview) =>
                            setPreviews((current) => ({
                              ...current,
                              [transcript.id]: preview.consumerRecords,
                            })),
                          )
                          .catch(() => {});
                      }
                    }}
                  />
                </div>
                {previews[transcript.id] && (
                  <p className="muted">
                    {previews[transcript.id]!.some((disclosure) => disclosure.recordCount > 0)
                      ? `Deletion will also remove: ${previews[transcript.id]!.filter(
                          (disclosure) => disclosure.recordCount > 0,
                        )
                          .map((d) => `${d.label} (${d.recordCount})`)
                          .join(", ")}.`
                      : "No registered consumer holds additional transcript-derived records."}
                  </p>
                )}
                <div className="field-row runs-toolbar">
                  <button
                    className="action-button"
                    type="button"
                    disabled={(confirmations[transcript.id] ?? "") !== "DELETE TRANSCRIPT"}
                    onClick={() => void deleteTranscript(transcript.id)}
                  >
                    Delete transcript
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {tombstones.length > 0 && (
          <>
            <h3>Deleted transcripts — do not reingest</h3>
            <ul className="relevance-list">
              {tombstones.map((tombstone) => (
                <li key={tombstone.externalFileId} className="card">
                  <dl>
                    <dt>Source file</dt>
                    <dd>{tombstone.externalFileId}</dd>
                    <dt>Deleted at</dt>
                    <dd>{tombstone.deletedAt}</dd>
                    <dt>Policy</dt>
                    <dd>Do not reingest until processing permission is restored</dd>
                  </dl>
                  <div className="field-row runs-toolbar">
                    <button
                      className="action-button"
                      type="button"
                      onClick={() => void restoreProcessing(tombstone.externalFileId)}
                    >
                      Restore processing permission
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}
