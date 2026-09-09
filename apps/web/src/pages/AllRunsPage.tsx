import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { DriveIntakeStatus } from "@chief-of-staff-demo/shared";
import { RunsList } from "../components/RunsList";
import { intakeApi } from "../clients/workspace";
import { relativeTime } from "../display";
import { useGoogleConnection } from "../useGoogleConnection";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/**
 * Every Module's Runs, in one place. A Shell page rather than a tab: the tab bar
 * renders live Modules and ADR-0014 made a tab a promise about function, so a
 * Runs tab would be the bar's first entry that is not a Module. ADR-0010 refused
 * Home a Runs list and ADR-0014 gave it a capped feed instead; a route the feed
 * links into respects both rather than revising the same boundary a third time.
 *
 * No filter controls: the Module column says whose Run each row is, each
 * Module's page is the Module filter, and a newest-first paged list in a
 * single-user app has nothing a status dropdown would rescue.
 */
export function AllRunsPage() {
  useTitle("All runs");
  const headingRef = usePageFocus<HTMLHeadingElement>();
  /* The transcript intake liveness line. It lived on Transcript → Tasks'
     own Runs page until that Module was retired (issue #142); the fact it
     reports is still true, and now belongs to the Transcript Catalog, the
     sole private transcript intake writer. Remembered facts only — the
     endpoint makes zero Google calls, and after a restart it claims no
     last-checked time it does not have. */
  const [intake, setIntake] = useState<DriveIntakeStatus | null>(null);
  const { status: googleStatus } = useGoogleConnection();
  const loadIntake = useCallback(() => {
    void intakeApi
      .driveIntakeStatus()
      .then((next) => setIntake(next))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    loadIntake();
  }, [loadIntake]);

  return (
    <div className="page">
      <div className="page-header">
        <h1 ref={headingRef} tabIndex={-1}>
          All runs
        </h1>
      </div>
      <p className="muted">
        Every Module's runs, newest first. A Module's own tab shows only its own.
      </p>
      {googleStatus?.state === "connected" && intake?.configured && intake.enabled && (
        <p className="muted" data-testid="intake-liveness">
          Watching {intake.folderName || "your Drive folder"}
          {intake.lastPollAt
            ? ` · last checked ${relativeTime(intake.lastPollAt)}` +
              (intake.lastPollOutcome === "failed" ? " (that check failed)" : "")
            : ""}
          {" · "}
          every {intake.pollIntervalMinutes} min
        </p>
      )}
      <RunsList
        empty={
          <p className="muted">
            No runs yet. A Module starts one when its Intake finds work — see{" "}
            <Link to="/">Home</Link> for what is live.
          </p>
        }
      />
    </div>
  );
}
