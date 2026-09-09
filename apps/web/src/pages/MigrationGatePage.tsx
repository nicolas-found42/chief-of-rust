import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { TaskCutoverPreview, TaskCutoverReceipt } from "@chief-of-staff-demo/shared";
import { migrationApi } from "../clients/workspace";
import { errorMessage } from "../client";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

export function MigrationGatePage({ onCutOver }: { onCutOver: () => void }) {
  useTitle("Workspace migration");
  const focus = usePageFocus<HTMLHeadingElement>();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<TaskCutoverPreview | null>(null);
  const [receipt, setReceipt] = useState<TaskCutoverReceipt | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => {
    let live = true;
    void migrationApi
      .inventory()
      .then((value) => {
        if (live) setPreview(value);
      })
      .catch((err) => {
        if (live) setError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, []);
  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      setReceipt((await migrationApi.confirm(typed, preview)).receipt);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page">
      <h1 ref={focus} tabIndex={-1}>
        Workspace migration
      </h1>
      <p>
        Carry legacy meeting actions into canonical Tasks and Action Items. Existing work,
        historical Runs, settings and credentials are preserved.
      </p>
      {error && (
        <p role="alert" className="banner-error">
          {error}
        </p>
      )}
      {receipt ? (
        <section className="card">
          <h2>Migration complete</h2>
          <p>
            Canonical records and the migration receipt were saved together. Authentication and
            historical Runs were preserved.
          </p>
          <button
            type="button"
            onClick={() => {
              void navigate("/", { replace: true });
              onCutOver();
            }}
          >
            Continue to Home
          </button>
        </section>
      ) : cancelled ? (
        <section className="card">
          <h2>Migration cancelled</h2>
          <p>The Workspace is unchanged.</p>
          <button type="button" onClick={() => setCancelled(false)}>
            Review preview
          </button>
        </section>
      ) : preview ? (
        <section className="card">
          <h2>Canonical Tasks preview</h2>
          <p>
            Exact Workspace: <code>{preview.workspace}</code>
          </p>
          <dl>
            {Object.entries(preview.counts).map(([name, count]) => (
              <div key={name}>
                <dt>
                  {
                    {
                      legacyRuns: "Historical Debrief Runs",
                      receipts: "App-created provider receipts",
                      tasks: "Tasks after cutover",
                      actionItems: "Action Items after cutover",
                      taskLists: "Task Lists preserved",
                      tasksToCreate: "New canonical Tasks",
                      actionItemsToCreate: "New canonical Action Items",
                    }[name]
                  }
                </dt>
                <dd>{count}</dd>
              </div>
            ))}
          </dl>
          <p>No unrelated provider Tasks are imported. Cancelling changes nothing.</p>
          <form onSubmit={(event) => void confirm(event)}>
            <label htmlFor="cutover-confirmation">
              Type MIGRATE TASKS to authorize this Workspace cutover
            </label>
            <input
              id="cutover-confirmation"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
            />
            <button type="submit" disabled={busy || typed !== "MIGRATE TASKS"}>
              {busy ? "Migrating…" : "Migrate Tasks"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setTyped("");
                setCancelled(true);
              }}
            >
              Cancel
            </button>
          </form>
        </section>
      ) : (
        <p role="status">Preparing content-free preview…</p>
      )}
    </div>
  );
}
