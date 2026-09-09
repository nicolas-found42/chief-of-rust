import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  CONTENT_RESEARCH_PLATFORMS,
  type ContentResearchIndex,
  type ContentResearchPlatform,
  type NamedPerson,
  type PersonProfile,
  type PersonSuggestion,
  type ResonanceScoredItem,
} from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import { peopleApi } from "../clients/people";
import { contentApi, type ContentClient } from "../clients/content";
import { ContentResearchSubNav } from "../components/ContentResearchSubNav";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

type PlatformFilter = "all" | ContentResearchPlatform;

const PLATFORM_LABELS: Record<ContentResearchPlatform, string> = {
  rss: "RSS",
  youtube: "YouTube",
  reddit: "Reddit",
  hn: "HN",
  news: "News",
};

const PLATFORM_OPTIONS: { value: PlatformFilter; label: string }[] = [
  { value: "all", label: "All platforms" },
  ...CONTENT_RESEARCH_PLATFORMS.map((platform) => ({
    value: platform,
    label: PLATFORM_LABELS[platform],
  })),
];

function formatHandleHints(person: NamedPerson): string {
  const hints: string[] = [];
  if (person.handleHints.blueskyDid) hints.push(`Bluesky ${person.handleHints.blueskyDid}`);
  if (person.handleHints.mastodon) hints.push(`Mastodon ${person.handleHints.mastodon}`);
  if (person.handleHints.youtubeChannelId)
    hints.push(`YouTube ${person.handleHints.youtubeChannelId}`);
  if (person.handleHints.hnUsername) hints.push(`HN ${person.handleHints.hnUsername}`);
  if (person.handleHints.blogRssHints.length > 0)
    hints.push(`RSS ${person.handleHints.blogRssHints.join(", ")}`);
  return hints.length > 0 ? hints.join(" · ") : "No handle hints";
}

/**
 * Which fields the adapter actually got. Anything the source did not supply —
 * `unavailable`, `unsupported`, `failed` — is absent here rather than listed as
 * though it were present.
 */
function completenessSummary(item: ResonanceScoredItem): string {
  const parts = Object.entries(item.completeness)
    .filter(([, value]) => value === "available")
    .map(([key]) => key);
  return parts.length > 0 ? parts.join(", ") : "nothing available";
}

/**
 * Evidence from a feed is the URL that was fetched; evidence from an API is the
 * route that was called (`youtube.data.playlistItems.list`). Only the first can
 * be opened, so only the first is rendered as a link.
 */
function isOpenableEvidence(evidenceUrl: string): boolean {
  return /^https?:\/\//i.test(evidenceUrl);
}

export function ContentResearchPage({ client = contentApi }: { client?: ContentClient }) {
  useTitle("Content Research");
  const headingRef = usePageFocus<HTMLHeadingElement>();

  const [index, setIndex] = useState<ContentResearchIndex | null>(null);
  const [people, setPeople] = useState<NamedPerson[] | null>(null);
  const [suggestions, setSuggestions] = useState<PersonSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [showGated, setShowGated] = useState(false);
  const [expandedReports, setExpandedReports] = useState<Set<string>>(new Set());
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [profiles, setProfiles] = useState<PersonProfile[] | null>(null);
  const [allPeople, setAllPeople] = useState<NamedPerson[] | null>(null);
  const [newProfileId, setNewProfileId] = useState("");
  const [suggestionProfiles, setSuggestionProfiles] = useState<Record<string, string>>({});
  const [newSite, setNewSite] = useState("");
  const [newYoutube, setNewYoutube] = useState("");
  const [newHn, setNewHn] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [idx, ppl, all, sug, prf] = await Promise.all([
        client.contentResearchIndex(),
        client.contentResearchPeople(),
        client.contentResearchAllPeople(),
        client.contentResearchSuggestions(),
        peopleApi.people(),
      ]);
      setIndex(idx);
      setPeople(ppl);
      setAllPeople(all);
      setSuggestions(sug);
      setProfiles(prf);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep selected person honest when the index changes.
  useEffect(() => {
    if (!index || index.byPerson.length === 0) return;
    if (selectedPersonId && index.byPerson.some((entry) => entry.personId === selectedPersonId))
      return;
    setSelectedPersonId(index.byPerson[0]!.personId);
  }, [index, selectedPersonId]);

  const currentPerson =
    index?.byPerson.find((entry) => entry.personId === selectedPersonId) ?? null;

  const gatedRuns = (index?.runs ?? []).filter((run) => run.status !== "done");

  /* Archived watches are gone from this surface; pausing or resuming them is
     not offered (#134 review): an archived watch's configuration is already
     resolved by its removal. */
  const watchRows = (allPeople ?? []).filter((person) => person.archivedAt === null);

  const act = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await refresh();
      setNotice(message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleAddPerson = async (event: React.FormEvent) => {
    event.preventDefault();
    const profileId = newProfileId.trim();
    if (!profileId) {
      setAddError("Select a confirmed Person Profile — or create one under Person Profiles first.");
      return;
    }
    const site = newSite.trim();
    if (site && !/^https?:\/\//i.test(site)) {
      setAddError("The site or feed address must start with http:// or https://.");
      return;
    }
    setAddError(null);
    /* Each hint names a surface to watch: a feed is read directly, a site is
       asked for the feeds it declares, and the channel and username reach
       YouTube and HN. With none, only the name-searched surfaces find them. */
    const youtubeChannelId = newYoutube.trim();
    const hnUsername = newHn.trim();
    const handleHints = {
      blogRssHints: site ? [site] : [],
      ...(youtubeChannelId ? { youtubeChannelId } : {}),
      ...(hnUsername ? { hnUsername } : {}),
    };
    const hasHint = site || youtubeChannelId || hnUsername;
    const profile = profiles?.find((candidate) => candidate.id === profileId);
    await act(
      () => client.addContentResearchPerson(profileId, hasHint ? handleHints : undefined),
      `Watching ${profile?.fullName ?? profileId}.`,
    );
    setNewProfileId("");
    setNewSite("");
    setNewYoutube("");
    setNewHn("");
  };

  const toggleReport = (runId: string) => {
    setExpandedReports((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const toggleItem = (key: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (!index || !people || !suggestions) {
    return (
      <section className="page">
        <h1 ref={headingRef} tabIndex={-1}>
          Content Research — what is resonating, for whom, and why
        </h1>
        <p role="status" className={error ? "field-error" : "muted"}>
          {error ?? "Loading Content Research…"}
        </p>
      </section>
    );
  }

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <h1 ref={headingRef} tabIndex={-1}>
            Content Research — what is resonating, for whom, and why
          </h1>
          <p className="muted">
            Named people watched across RSS, YouTube, Reddit, HN and News — ranked by resonance
            against their own 90-day baseline.
          </p>
        </div>
      </div>
      <ContentResearchSubNav />

      <div aria-live="polite" aria-atomic="true">
        {error && (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="banner banner-ok" role="status">
            {notice}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="toolbar research-toolbar">
        <button
          type="button"
          className="primary"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            void act(() => client.runContentResearch(), "Content Research run started.");
          }}
        >
          {busy ? "Working…" : "Run Now"}
        </button>
        <button
          type="button"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            void act(() => client.backfillContentResearch(7), "Backfill 7d started.");
          }}
        >
          Backfill 7d
        </button>
        <button
          type="button"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            void act(() => client.backfillContentResearch(30), "Backfill 30d started.");
          }}
        >
          Backfill 30d
        </button>
        <button
          type="button"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            void act(() => client.backfillContentResearch(90), "Backfill 90d started.");
          }}
        >
          Backfill 90d
        </button>
        <button
          type="button"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            void act(() => client.discoverContentResearchPeople(), "People discovery started.");
          }}
        >
          Discover Now
        </button>
        <label>
          Platform:{" "}
          <select
            value={platform}
            onChange={(event) => setPlatform(event.target.value as PlatformFilter)}
          >
            {PLATFORM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Watchlist */}
      <section className="card" aria-labelledby="watchlist-heading">
        <h2 id="watchlist-heading">Watchlist — named people</h2>
        {watchRows.length === 0 ? (
          <p className="muted">No one watched yet. Add a Person Profile below.</p>
        ) : (
          <ul>
            {watchRows.map((person) => (
              <li key={person.id} className="research-person-row">
                <strong>{person.name}</strong>{" "}
                {person.pausedAt && <span className="status-badge">paused</span>}{" "}
                <span className="muted">· {formatHandleHints(person)}</span>{" "}
                <span className="muted">
                  · added {new Date(person.createdAt).toLocaleDateString()}
                </span>{" "}
                {person.pausedAt ? (
                  <button
                    type="button"
                    aria-disabled={busy}
                    onClick={() => {
                      if (busy) return;
                      void act(
                        () => client.resumeContentResearchPerson(person.id),
                        `Resumed watching ${person.name}.`,
                      );
                    }}
                  >
                    Resume
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-disabled={busy}
                    onClick={() => {
                      if (busy) return;
                      void act(
                        () => client.pauseContentResearchPerson(person.id),
                        `Paused watching ${person.name}.`,
                      );
                    }}
                  >
                    Pause
                  </button>
                )}
                <button
                  type="button"
                  aria-disabled={busy}
                  onClick={() => {
                    if (busy) return;
                    void act(
                      () => client.stopWatchingContentResearchPerson(person.id),
                      `No longer watching ${person.name}.`,
                    );
                  }}
                >
                  Stop watching
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={(event) => void handleAddPerson(event)} className="research-add-form">
          <div className="field-row">
            <select
              aria-label="Person Profile"
              value={newProfileId}
              onChange={(event) => setNewProfileId(event.target.value)}
            >
              <option value="">Select a Person Profile…</option>
              {(profiles ?? []).map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.fullName ?? profile.primaryEmail ?? profile.id}
                </option>
              ))}
            </select>
            <Link to="/people/new" className="field-hint muted">
              Create a Person Profile
            </Link>
            <input
              aria-label="Site or feed address"
              placeholder="Site or feed — e.g. https://example.com"
              value={newSite}
              onChange={(event) => setNewSite(event.target.value)}
            />
            <input
              aria-label="YouTube channel id"
              placeholder="YouTube channel id — e.g. UC…"
              value={newYoutube}
              onChange={(event) => setNewYoutube(event.target.value)}
            />
            <input
              aria-label="Hacker News username"
              placeholder="HN username"
              value={newHn}
              onChange={(event) => setNewHn(event.target.value)}
            />
            <button type="submit" aria-disabled={busy}>
              Add person
            </button>
          </div>
          {addError && (
            <p className="field-error" role="alert">
              {addError}
            </p>
          )}
          <p className="muted field-hint">
            People-first watchlist — no LinkedIn. Every hint is optional: paste a feed to watch it
            directly, or a site and its declared feeds are discovered; a channel id and an HN
            username add those surfaces. With none, Reddit, HN and News are searched by name.
          </p>
        </form>
      </section>

      {/* Cross-Run index primary by Person */}
      {index.byPerson.length === 0 ? (
        <div className="card">
          <h2>Resonance index</h2>
          <p className="muted">
            No reports yet. Add people to the watchlist and choose Run Now — or wait for the daily
            08:00 scan.
          </p>
        </div>
      ) : (
        <>
          <nav className="sub-tabs" aria-label="People">
            {index.byPerson.map((entry) => (
              <button
                key={entry.personId}
                type="button"
                className="sub-tab"
                aria-current={entry.personId === currentPerson?.personId ? "true" : undefined}
                onClick={() => setSelectedPersonId(entry.personId)}
              >
                {entry.personName}
              </button>
            ))}
          </nav>

          {currentPerson && (
            <section className="card" aria-labelledby="person-heading">
              <h2 id="person-heading">{currentPerson.personName}</h2>
              {currentPerson.reports.length === 0 ? (
                <p className="muted">No reports for this person yet.</p>
              ) : (
                <>
                  {/* Simple textual sparkline: resonanceScoreMax over time */}
                  <p className="muted">
                    {currentPerson.reports.length} report
                    {currentPerson.reports.length === 1 ? "" : "s"} · latest resonance{" "}
                    {currentPerson.reports[0]!.resonanceScoreMax.toFixed(2)} · oldest{" "}
                    {currentPerson.reports[
                      currentPerson.reports.length - 1
                    ]!.resonanceScoreMax.toFixed(2)}
                  </p>
                  <div className="research-sparkline">
                    {[...currentPerson.reports]
                      .slice()
                      .reverse()
                      .map((report) => {
                        const max = Math.max(
                          ...currentPerson.reports.map((entry) => entry.resonanceScoreMax),
                          1,
                        );
                        const height = Math.max(
                          4,
                          Math.round((report.resonanceScoreMax / max) * 28),
                        );
                        return (
                          <span
                            key={report.runId}
                            title={`${report.generatedAt}: ${report.resonanceScoreMax.toFixed(2)}`}
                            className="research-sparkline-bar"
                            style={{ height: `${height}px` }}
                          />
                        );
                      })}
                  </div>

                  {[...currentPerson.reports]
                    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
                    .map((report) => {
                      const filtered =
                        platform === "all"
                          ? report.items
                          : report.items.filter((item) => item.platform === platform);
                      const isOpen = expandedReports.has(report.runId);
                      return (
                        <details
                          key={report.runId}
                          className="disclosure research-report"
                          open={isOpen}
                          onToggle={() => toggleReport(report.runId)}
                        >
                          <summary>
                            {new Date(report.generatedAt).toLocaleString()} · max resonance{" "}
                            {report.resonanceScoreMax.toFixed(2)} · {filtered.length} item
                            {filtered.length === 1 ? "" : "s"}
                            {platform !== "all" ? ` · ${platform}` : ""} ·{" "}
                            {report.runId.slice(0, 8)}
                          </summary>
                          <div className="disclosure-body">
                            {/* The Run link belongs in the body: a link inside <summary>
                                nests one interactive control inside another. */}
                            <p className="muted">
                              <Link to={`/runs/${report.runId}`}>Open this Run</Link>
                            </p>
                            {filtered.length === 0 ? (
                              <p className="muted">No items for this platform in this report.</p>
                            ) : (
                              <ul className="research-item-list">
                                {filtered
                                  .slice()
                                  .sort((a, b) => b.resonanceScore - a.resonanceScore)
                                  .map((item) => {
                                    const itemKey = `${report.runId}:${item.sourceItemId}`;
                                    const itemOpen = expandedItems.has(itemKey);
                                    return (
                                      <li key={item.sourceItemId} className="research-item">
                                        <div className="research-item-badges">
                                          <span className="status-badge">{item.platform}</span>
                                          <span className="status-badge">
                                            resonance {item.resonanceScore.toFixed(2)}
                                          </span>
                                          <span className="muted">
                                            weighted {item.weightedCount}
                                          </span>
                                        </div>
                                        <div className="research-item-title">
                                          <strong>{item.title ?? "(untitled)"}</strong>{" "}
                                          <a
                                            href={item.canonicalUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                          >
                                            open
                                          </a>
                                          {item.evidenceUrl &&
                                            item.evidenceUrl !== item.canonicalUrl && (
                                              <>
                                                {" · "}
                                                {isOpenableEvidence(item.evidenceUrl) ? (
                                                  <a
                                                    href={item.evidenceUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                  >
                                                    evidence
                                                  </a>
                                                ) : (
                                                  <span className="muted">
                                                    evidence: {item.evidenceUrl}
                                                  </span>
                                                )}
                                              </>
                                            )}
                                        </div>
                                        {item.hook && (
                                          <p className="research-item-hook">
                                            <em>{item.hook}</em>
                                            {item.evidenceQuote && (
                                              <span className="muted">
                                                {" "}
                                                — “{item.evidenceQuote}”
                                              </span>
                                            )}
                                          </p>
                                        )}
                                        <p className="muted research-item-note">
                                          completeness: {completenessSummary(item)} · counts:{" "}
                                          {Object.entries(item.counts)
                                            .filter(([, value]) => value !== undefined)
                                            .map(([key, value]) => `${key} ${value}`)
                                            .join(", ") || "none"}
                                          {item.publishedAt &&
                                            ` · published ${new Date(item.publishedAt).toLocaleDateString()}`}
                                        </p>
                                        <button
                                          type="button"
                                          className="linklike"
                                          aria-expanded={itemOpen}
                                          onClick={() => toggleItem(itemKey)}
                                        >
                                          {itemOpen ? "Hide detail" : "Show detail"}
                                        </button>
                                        {itemOpen && (
                                          <div className="research-item-detail">
                                            <dl className="receipt-grid">
                                              <div className="receipt-row">
                                                <dt>canonicalUrl</dt>
                                                <dd>
                                                  <a
                                                    href={item.canonicalUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                  >
                                                    {item.canonicalUrl}
                                                  </a>
                                                </dd>
                                              </div>
                                              {item.evidenceUrl && (
                                                <div className="receipt-row">
                                                  <dt>evidenceUrl</dt>
                                                  <dd>
                                                    {isOpenableEvidence(item.evidenceUrl) ? (
                                                      <a
                                                        href={item.evidenceUrl}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                      >
                                                        {item.evidenceUrl}
                                                      </a>
                                                    ) : (
                                                      item.evidenceUrl
                                                    )}
                                                  </dd>
                                                </div>
                                              )}
                                              <div className="receipt-row">
                                                <dt>completeness</dt>
                                                <dd>
                                                  {Object.entries(item.completeness)
                                                    .map(([key, value]) => `${key}: ${value}`)
                                                    .join(" · ")}
                                                </dd>
                                              </div>
                                              <div className="receipt-row">
                                                <dt>sourceItemId</dt>
                                                <dd>{item.sourceItemId}</dd>
                                              </div>
                                            </dl>
                                          </div>
                                        )}
                                      </li>
                                    );
                                  })}
                              </ul>
                            )}
                          </div>
                        </details>
                      );
                    })}
                </>
              )}
            </section>
          )}
        </>
      )}

      {/* Collapsed gated/skipped Runs */}
      <section className="card" aria-labelledby="gated-heading">
        <h2 id="gated-heading">Gated / skipped Runs</h2>
        {gatedRuns.length === 0 ? (
          <p className="muted">No gated or skipped runs.</p>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setShowGated((value) => !value)}
              aria-expanded={showGated}
            >
              {showGated ? "Hide" : "Show"} {gatedRuns.length} run
              {gatedRuns.length === 1 ? "" : "s"}
            </button>
            {showGated && (
              <ul className="research-gated-list">
                {gatedRuns.map((run) => (
                  <li key={run.runId} className="research-gated-row">
                    <Link to={`/runs/${run.runId}`}>{run.runId.slice(0, 8)}</Link>{" "}
                    <span className="status-badge status-skipped">{run.status}</span>{" "}
                    <span className="muted">{run.intake}</span> · {run.summary}
                    <span className="muted"> · {new Date(run.createdAt).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {/* Suggestions */}
      <section className="card" aria-labelledby="suggestions-heading">
        <h2 id="suggestions-heading">People suggestions</h2>
        {suggestions.length === 0 ? (
          <p className="muted">
            No suggestions. Use Discover Now to propose people related to the brand.
          </p>
        ) : (
          <ul className="research-item-list">
            {suggestions.map((suggestion) => (
              <li key={suggestion.id} className="research-item">
                <div className="research-item-badges">
                  <strong>{suggestion.name}</strong>
                  <span className="status-badge">{suggestion.state}</span>
                  <span className="muted">{suggestion.source}</span>
                </div>
                <p className="research-item-hook">{suggestion.reason}</p>
                <p className="muted research-item-note">
                  Relationship: {suggestion.relationshipToBrand}
                </p>
                {suggestion.supportingUrls.length > 0 && (
                  <p className="muted research-item-note">
                    Evidence:{" "}
                    {suggestion.supportingUrls.map((url, index) => (
                      <span key={url}>
                        {index > 0 ? " · " : ""}
                        <a href={url} target="_blank" rel="noreferrer">
                          {url}
                        </a>
                      </span>
                    ))}
                  </p>
                )}
                {suggestion.decisionReason && (
                  <p className="muted research-item-note">Decision: {suggestion.decisionReason}</p>
                )}
                <div className="toolbar research-suggestion-actions">
                  {suggestion.state === "pending" && (
                    <>
                      <select
                        aria-label={`Profile for ${suggestion.name}`}
                        value={suggestionProfiles[suggestion.id] ?? ""}
                        onChange={(event) =>
                          setSuggestionProfiles((prev) => ({
                            ...prev,
                            [suggestion.id]: event.target.value,
                          }))
                        }
                      >
                        <option value="">Select or create a Profile…</option>
                        {(profiles ?? []).map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.fullName ?? profile.primaryEmail ?? profile.id}
                          </option>
                        ))}
                      </select>
                      <Link to="/people/new" className="field-hint muted">
                        Create a Person Profile
                      </Link>
                      <button
                        type="button"
                        className="primary"
                        aria-disabled={busy}
                        onClick={() => {
                          if (busy) return;
                          void act(
                            () =>
                              client.decideContentResearchSuggestion(
                                suggestion.id,
                                "approved",
                                suggestionProfiles[suggestion.id] || undefined,
                              ),
                            `Approved ${suggestion.name}.`,
                          );
                        }}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        aria-disabled={busy}
                        onClick={() => {
                          if (busy) return;
                          void act(
                            () =>
                              client.decideContentResearchSuggestion(suggestion.id, "dismissed"),
                            `Dismissed ${suggestion.name}.`,
                          );
                        }}
                      >
                        Dismiss
                      </button>
                    </>
                  )}
                  {suggestion.state === "dismissed" && (
                    <button
                      type="button"
                      aria-disabled={busy}
                      onClick={() => {
                        if (busy) return;
                        void act(
                          () => client.decideContentResearchSuggestion(suggestion.id, "restore"),
                          `Restored ${suggestion.name}.`,
                        );
                      }}
                    >
                      Restore
                    </button>
                  )}
                  {suggestion.state === "approved" && (
                    <span className="muted">Approved — now in watchlist.</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
