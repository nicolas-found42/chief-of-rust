import { useEffect, useState } from "react";
import { errorMessage } from "../../client";
import { contentApi, type ContentClient } from "../../clients/content";

/**
 * YouTube Trends' own settings surface: the spreadsheet it keeps the operator's
 * data in, outside the app.
 *
 * Creation is an action here rather than something the first Run does silently.
 * Setup belongs in the settings flow, and a link buried in a Run record scrolls
 * out of Home's feed — where this one stays findable weeks later.
 */
export function SpreadsheetCard({ client = contentApi }: { client?: ContentClient }) {
  const [spreadsheet, setSpreadsheet] = useState<{ id: string; url: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void client
      .youtubeTrends()
      .then((trends) => {
        setSpreadsheet(trends.spreadsheet);
        setLoaded(true);
      })
      .catch((err) => {
        setError(errorMessage(err));
        setLoaded(true);
      });
  }, [client]);

  const create = async () => {
    if (creating) {
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const { spreadsheet: made } = await client.createYoutubeSpreadsheet();
      setSpreadsheet(made);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="card" role="group" aria-labelledby="group-youtube-sheet">
      <h3 id="group-youtube-sheet">Spreadsheet</h3>
      <p className="muted">
        Each day's view counts are appended to a spreadsheet of your own — one tab per channel, one
        row per video per day. It is yours to chart, filter and share, and it outlives this app.
      </p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {!loaded ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : spreadsheet ? (
        <p className="connection-summary">
          <a href={spreadsheet.url} target="_blank" rel="noreferrer">
            Open the spreadsheet
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        </p>
      ) : (
        <div className="field-row">
          <button
            type="button"
            className="action-button"
            onClick={() => void create()}
            aria-disabled={creating}
          >
            {creating ? "Creating…" : "Create the spreadsheet"}
          </button>
          <span className="muted">
            It lands in the root of your Drive. Nothing to name, nothing to pick.
          </span>
        </div>
      )}
    </div>
  );
}
