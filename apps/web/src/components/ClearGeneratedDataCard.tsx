import { useEffect, useRef, useState } from "react";
import { CLEAR_GENERATED_DATA_CONFIRMATION } from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import {
  clearDataApi,
  type ClearDataReceipt,
  type GeneratedDataInventory,
} from "../clients/workspace";

/**
 * The Settings danger zone's one action (issue #144): the repeatable successor
 * to the one-time migration gate, bounded by the same classification tables
 * (ADR-0046, ADR-0048). It deletes what the products generated and empties the
 * data rows of the two Sheets the app writes, while every credential, pointer
 * and provider-owned record — Google Tasks, Gmail drafts, the transcripts
 * Drive folder — is untouched by construction.
 *
 * The inventory is loaded eagerly so the disclosure names what would go before
 * anyone reaches for the phrase; the receipt is content-free by construction
 * (names and counts, never stored values).
 */
export function ClearGeneratedDataCard() {
  const [inventory, setInventory] = useState<GeneratedDataInventory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ClearDataReceipt | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const loadInventory = () => {
    clearDataApi
      .inventory()
      .then(setInventory)
      .catch((err) => setLoadError(errorMessage(err)));
  };

  useEffect(loadInventory, []);

  /* The error is announced by role="alert"; moving focus onto it makes the
     failure the next thing a keyboard user meets, not the button they pressed. */
  useEffect(() => {
    if (error !== null) errorRef.current?.focus();
  }, [error]);

  const confirmed = typed === CLEAR_GENERATED_DATA_CONFIRMATION;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setReceipt(await clearDataApi.confirm(typed));
      setTyped("");
      loadInventory();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const entries = inventory?.entries ?? [];

  return (
    <div className="card" role="group" aria-labelledby="group-clear-data">
      <h3 id="group-clear-data">Clear all generated data</h3>
      {error && (
        <p className="field-error" role="alert" ref={errorRef} tabIndex={-1}>
          {error}
        </p>
      )}
      {loadError && (
        <p className="muted" role="status">
          Could not load the inventory: {loadError}
        </p>
      )}
      <details>
        <summary>Show what this deletes, and run it</summary>
        <p className="muted">
          Deletes everything the products generated — Runs, Person Profiles, processed Transcripts,
          Brand Profiles, Content Research, Content Projects — plus the checkpoints that track what
          was already ingested or scheduled
          {entries.length > 0 ? (
            <>
              {" "}
              — currently {entries.reduce((sum, entry) => sum + (entry.fileCount ?? 1), 0)} records
            </>
          ) : null}
          . The data rows of the two Google Sheets this app writes (YouTube Trends and the Resonance
          Ledger) are emptied, headers and spreadsheets kept.
        </p>
        <p className="muted">
          Untouched: your Google, Notion and HubSpot sign-ins, the relay address, the Drive
          transcript folder and its files, Google Tasks, Gmail drafts, and every setting.
        </p>

        {receipt !== null && (
          <dl className="receipt-grid">
            {(
              [
                ["Directories removed", receipt.local.directories.length],
                [
                  "Records deleted",
                  receipt.local.directories.reduce((sum, entry) => sum + entry.files, 0),
                ],
                ["Checkpoints removed", receipt.local.files.length],
                [
                  "Sheets emptied",
                  receipt.sheets.filter((sheet) => sheet.outcome === "cleared").length,
                ],
              ] as const
            ).map(([label, value]) => (
              <div className="receipt-row" key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {receipt !== null && (
          <ul className="setup-check-list">
            {receipt.sheets.map((sheet) => (
              <li key={sheet.destination}>
                <code>{sheet.destination}</code> —{" "}
                {sheet.outcome === "cleared"
                  ? `${sheet.rows} rows removed from ${sheet.tabs} tab(s)`
                  : sheet.outcome === "skipped" || sheet.outcome === "missing"
                    ? `skipped: ${sheet.reason}`
                    : `failed: ${sheet.reason}`}
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={(event) => void submit(event)}>
          <p>
            <label htmlFor="clear-data-confirmation">
              Type <code>{CLEAR_GENERATED_DATA_CONFIRMATION}</code> to confirm
            </label>
            <input
              id="clear-data-confirmation"
              type="text"
              autoComplete="off"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </p>
          <button className="action-button primary" type="submit" disabled={!confirmed || busy}>
            {busy ? "Deleting…" : "Delete all generated data"}
          </button>
          <p className="field-hint">
            The button stays disabled until the phrase matches exactly. A mistyped phrase sends
            nothing.
          </p>
        </form>
      </details>
    </div>
  );
}
