import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ChannelTrend, YoutubeTrends } from "@chief-of-staff-demo/shared";
import { LineChart } from "../components/LineChart";
import { ContentResearchSubNav } from "../components/ContentResearchSubNav";
import { errorMessage } from "../client";
import { contentApi, type ContentClient } from "../clients/content";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/* How many of a channel's videos the table paints before asking. "Every video,
   every day, with no cutoff" is a rule about what a Run records, not about what
   one page paints: a channel's back catalogue runs to thousands of rows, and a
   table that long is slow to render and impossible to walk with a keyboard. The
   rows are most-viewed-first, so the ones that carry the channel are always in
   the first page. */
const VIDEO_PAGE_SIZE = 50;

/** View counts are the point of the page, so they are grouped, not raw. */
function views(count: number): string {
  return count.toLocaleString();
}

/** A change since a measured day, or an em dash when nothing that old exists. */
function change(value: number | null): string {
  if (value === null) {
    return "—";
  }
  return value >= 0 ? `+${views(value)}` : `−${views(Math.abs(value))}`;
}

/**

 * YouTube Trends: one sub-tab per channel, the channel's line over time, and a
 * table of its videos whose rows expand to show that video's own line. The
 * numbers come from the Runs on disk through the derived trend, never from a
 * live read — so a weekly re-consent does not blank a page of data already
 * measured.
 */
export function YoutubePage({ client = contentApi }: { client?: ContentClient }) {
  useTitle("YouTube Trends");
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [trends, setTrends] = useState<YoutubeTrends | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  /* Which video rows are open. One line per video would be a smear on a
     two-hundred-video channel, so a video's own line is revealed by expanding
     its row — the fifth primitive, which costs nothing new. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /* How many rows of the current channel's table are painted. */
  const [shown, setShown] = useState(VIDEO_PAGE_SIZE);

  const refresh = useCallback(async () => {
    try {
      setTrends(await client.youtubeTrends());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const channels = trends?.channels ?? [];
  /* The chosen sub-tab, or the first channel — kept honest when a channel is
     removed while its sub-tab is open. */
  const current: ChannelTrend | null =
    channels.find((channel) => channel.channelId === selected) ?? channels[0] ?? null;
  const currentId = current?.channelId ?? null;

  /* A different channel is a different table, so the cap starts over rather than
     carrying one channel's revealed rows into the next. */
  useEffect(() => {
    setShown(VIDEO_PAGE_SIZE);
  }, [currentId]);

  const visibleVideos = current ? current.videos.slice(0, shown) : [];
  const hiddenVideos = current ? current.videos.length - visibleVideos.length : 0;

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (adding) {
      return;
    }
    setAdding(true);
    setAddError(null);
    setNotice(null);
    try {
      /* Checked against YouTube while the operator is still looking at it: a
         typo is their problem now rather than a silent gap in tomorrow's data. */
      const { channel } = await client.addYoutubeChannel(url.trim());
      setUrl("");
      setNotice(`Now tracking ${channel.title}.`);
      setSelected(channel.id);
      await refresh();
    } catch (err) {
      setAddError(errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (channel: ChannelTrend) => {
    setNotice(null);
    setError(null);
    try {
      await client.removeYoutubeChannel(channel.channelId);
      /* Stops future work and erases nothing: past Runs are immutable, and
         re-adding resumes with a visible gap. */
      setNotice(`Stopped tracking ${channel.title}. Its history is kept.`);
      setSelected(null);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const recordToday = async () => {
    if (running) {
      return;
    }
    setRunning(true);
    setNotice(null);
    setError(null);
    try {
      await client.runYoutubeNow();
      setNotice("Recording today's view counts — the run will appear below.");
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1 ref={headingRef} tabIndex={-1}>
          YouTube Trends
        </h1>
        <button
          type="button"
          className="action-button"
          onClick={() => void recordToday()}
          aria-disabled={running}
        >
          {running ? "Recording…" : "Record today"}
        </button>
      </div>
      <ContentResearchSubNav />

      <p className="muted">
        Every channel below is checked once a day, from six in the morning, and every video on it is
        counted — including the back catalogue.
        {trends?.lastDay ? ` Last recorded ${trends.lastDay}.` : " Nothing recorded yet."}
      </p>

      {/* The same numbers, outside the app: chartable, shareable, and proof
          against this app disappearing. */}
      <p className="muted">
        {trends?.spreadsheet ? (
          <a href={trends.spreadsheet.url} className="text-link" target="_blank" rel="noreferrer">
            Open the spreadsheet
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        ) : (
          <>
            No spreadsheet yet — create one in{" "}
            <Link to="/settings" className="text-link">
              Settings → YouTube Trends
            </Link>{" "}
            to keep these numbers outside the app as well.
          </>
        )}
      </p>

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

      <form className="card" onSubmit={(event) => void add(event)}>
        <div className="field">
          <label htmlFor="channel-url">Channel URL</label>
          <div className="field-row">
            <input
              id="channel-url"
              aria-describedby={
                addError ? "channel-url-error channel-url-hint" : "channel-url-hint"
              }
              aria-invalid={addError ? true : undefined}
              value={url}
              placeholder="https://www.youtube.com/@name"
              onChange={(event) => setUrl(event.target.value)}
            />
            <button type="submit" className="action-button" aria-disabled={adding}>
              {adding ? "Checking…" : "Add channel"}
            </button>
          </div>
          {addError && (
            <p id="channel-url-error" className="field-error" role="alert">
              {addError}
            </p>
          )}
          <p id="channel-url-hint" className="muted field-hint">
            A handle address (youtube.com/@name) or an id address (youtube.com/channel/UC…). It is
            checked against YouTube now, not tomorrow.
          </p>
        </div>
      </form>

      {trends === null ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : channels.length === 0 ? (
        <div className="card">
          <p className="muted">
            No channels yet. Paste a channel address above and it will be checked against YouTube
            straight away; from then on its view counts are recorded once a day.
          </p>
        </div>
      ) : (
        <>
          {/* Sub-navigation inside the Module's page: the Shell's tab bar gains
              exactly one entry (ADR-0006), and it does not model a Module's
              internal sections. */}
          <nav className="sub-tabs" aria-label="Channels">
            {channels.map((channel) => (
              <button
                key={channel.channelId}
                type="button"
                className="sub-tab"
                aria-current={channel.channelId === current?.channelId ? "true" : undefined}
                onClick={() => setSelected(channel.channelId)}
              >
                {channel.title}
              </button>
            ))}
          </nav>

          {current && (
            <section aria-labelledby="channel-heading">
              <div className="page-header">
                <h2 id="channel-heading">
                  {current.title}{" "}
                  {current.handle && <span className="muted">{current.handle}</span>}
                </h2>
                <button
                  type="button"
                  className="action-button"
                  onClick={() => void remove(current)}
                >
                  Stop tracking
                </button>
              </div>

              {current.totals.length === 0 ? (
                <div className="card">
                  <p className="muted">
                    Nothing measured yet. The first run happens after six in the morning — or press{" "}
                    <strong>Record today</strong> to do it now.
                  </p>
                </div>
              ) : (
                <>
                  {/* The channel as a whole: is this growing? */}
                  <LineChart points={current.totals} label={`${current.title} total views`} />
                  <p className="channel-total">
                    {views(current.latest)} views
                    <span className="muted">
                      {" "}
                      · {change(current.change7)} in 7 days · {change(current.change30)} in 30 days
                      {" · "}
                      {current.totals.length === 1
                        ? "1 day measured"
                        : `${current.totals.length} days measured`}
                    </span>
                  </p>
                  {current.failedIds.length > 0 && (
                    <p className="muted">
                      {current.failedIds.length === 1
                        ? "1 video could not be read on the last run"
                        : `${current.failedIds.length} videos could not be read on the last run`}{" "}
                      — deleted or private videos stay counted up to the day they went.
                    </p>
                  )}
                  <div className="table-scroll" tabIndex={0}>
                    <table className="runs-table" data-testid="youtube-videos">
                      <caption className="visually-hidden">
                        Videos on {current.title}, most viewed first
                        {hiddenVideos > 0 &&
                          `, showing the first ${views(visibleVideos.length)} of ${views(current.videos.length)}`}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Video</th>
                          <th scope="col">Views</th>
                          <th scope="col">7 days</th>
                          <th scope="col">30 days</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleVideos.map((video) => {
                          const open = expanded.has(video.id);
                          return (
                            <React.Fragment key={video.id}>
                              <tr>
                                <td>
                                  <button
                                    type="button"
                                    className="row-toggle"
                                    aria-expanded={open}
                                    onClick={() =>
                                      setExpanded((current) => {
                                        const next = new Set(current);
                                        if (!next.delete(video.id)) {
                                          next.add(video.id);
                                        }
                                        return next;
                                      })
                                    }
                                  >
                                    {video.title}
                                  </button>
                                </td>
                                <td>{views(video.latest)}</td>
                                <td className="muted">{change(video.change7)}</td>
                                <td className="muted">{change(video.change30)}</td>
                              </tr>
                              {open && (
                                <tr>
                                  <td className="video-chart-cell" colSpan={4}>
                                    <LineChart points={video.points} label={video.title} />
                                    <p className="muted">
                                      <a
                                        href={`https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        Watch on YouTube
                                        <span className="visually-hidden">
                                          {" "}
                                          (opens in a new tab)
                                        </span>
                                      </a>
                                    </p>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {hiddenVideos > 0 && (
                    <div className="field-row">
                      <button
                        type="button"
                        className="action-button"
                        onClick={() => setShown((count) => count + VIDEO_PAGE_SIZE)}
                      >
                        Show more videos ({views(hiddenVideos)} left)
                      </button>
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
