import {
  isSuccessfulSourceDiagnostic,
  type ContentScoutBrandProfileScanRunResult,
  type ContentScoutRunResult,
  type RunDetail,
  type SourceCapability,
} from "@chief-of-staff-demo/shared";

const SOURCE_CAPABILITY_LABELS: Record<SourceCapability, string> = {
  body: "Body",
  channel: "Channel",
  comments: "Comments",
  description: "Description",
  items: "Source Items",
  source_target: "Source Target",
  title: "Title",
  transcript: "Transcript",
  unknown_capability: "Unknown capability",
  youtube: "YouTube",
};

export function ContentScoutResultView({ detail }: { detail: RunDetail }) {
  /* A Brand Profile scan Run carries evidence counts, not the collection
     receipt; reading it through the discovery shape crashes the whole app
     on its absent fields. */
  if (detail.intake === "brand-profile-scan") {
    const scan = detail.result as ContentScoutBrandProfileScanRunResult | null;
    if (!scan) return null;
    return (
      <section aria-labelledby="content-scout-receipt">
        <h2 id="content-scout-receipt">Content Scout receipt</h2>
        <p>
          {scan.pages} pages crawled · {scan.included} included in the evidence ·{" "}
          {scan.changedSections} section{scan.changedSections === 1 ? "" : "s"} proposed a change
        </p>
      </section>
    );
  }
  const result = detail.result as ContentScoutRunResult | null;
  if (!result) return null;
  return (
    <section aria-labelledby="content-scout-receipt">
      <h2 id="content-scout-receipt">Content Scout receipt</h2>
      {result.adapters.length > 0 && (
        <>
          <div className="table-scroll" tabIndex={0} aria-label="Source Adapter summary table">
            <table aria-label="Source Adapter summary">
              <thead>
                <tr>
                  <th>Source Adapter</th>
                  <th>State</th>
                  <th>Source Targets</th>
                  <th>Source Items</th>
                  <th>Duration</th>
                  <th>Retries</th>
                  <th>Last successful request</th>
                  <th>Affected capabilities</th>
                  <th>Error classifications</th>
                </tr>
              </thead>
              <tbody>
                {result.adapters.map((adapter) => (
                  <tr key={adapter.adapterId}>
                    <td>{adapter.adapterId}</td>
                    <td>{adapter.state}</td>
                    <td>{adapter.targetsAttempted}</td>
                    <td>{adapter.itemsFound}</td>
                    <td>{adapter.durationMs} ms</td>
                    <td>{adapter.retries}</td>
                    <td>
                      {adapter.lastSuccessfulRequest
                        ? `${adapter.lastSuccessfulRequest.at} · ${adapter.lastSuccessfulRequest.route}`
                        : "None"}
                    </td>
                    <td>
                      {adapter.affectedCapabilities
                        .map((capability) => SOURCE_CAPABILITY_LABELS[capability])
                        .join(", ") || "None"}
                    </td>
                    <td>
                      {(
                        adapter.errorClassifications ??
                        (isSuccessfulSourceDiagnostic(adapter.outcome) ? [] : [adapter.outcome])
                      )
                        .map((classification) => classification.replaceAll("_", " "))
                        .join(", ") || "None"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.adapters.map((adapter) => (
            <details className="card" key={`${adapter.adapterId}-attempts`}>
              <summary>{adapter.adapterId} Source Adapter attempt receipts</summary>
              {adapter.attempts.map((attempt) => {
                const diagnostic = attempt.diagnostic;
                return (
                  <section
                    aria-labelledby={`${adapter.adapterId}-${attempt.targetId}-${attempt.attempt}`}
                    key={`${attempt.targetId}-${attempt.attempt}`}
                  >
                    <h3 id={`${adapter.adapterId}-${attempt.targetId}-${attempt.attempt}`}>
                      Source Target {attempt.targetId} · attempt {attempt.attempt}
                    </h3>
                    <dl className="receipt-grid">
                      {[
                        ["Outcome", attempt.outcome.replaceAll("_", " ")],
                        ["Route", diagnostic?.route ?? "Not recorded"],
                        ["Status", diagnostic?.status?.toString() ?? "Not reported"],
                        ["Content type", diagnostic?.contentType ?? "Not reported"],
                        ["Parser stage", diagnostic?.parserStage ?? "Not recorded"],
                        ["Response hash", diagnostic?.responseHash || "Not recorded"],
                        ["Source Adapter version", diagnostic?.adapterVersion ?? "Not recorded"],
                        ["Started", diagnostic?.startedAt ?? attempt.startedAt],
                        ["Finished", diagnostic?.finishedAt ?? attempt.finishedAt],
                        ["Cause chain", diagnostic?.causeChain.join(" → ") || "None"],
                      ].map(([label, value]) => (
                        <div className="receipt-row" key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                );
              })}
            </details>
          ))}
        </>
      )}
      <p>
        {result.shortlist.opportunityCount} shortlist opportunities ·{" "}
        {result.shortlist.omittedCount} omitted · {result.warnings} warnings
      </p>
      {result.projects?.map((entry) => (
        <div className="card" key={entry.opportunityId}>
          <strong>
            {entry.created ? "Started" : "Already started"} Content Project{" "}
            <code>{entry.projectId}</code>
          </strong>
        </div>
      ))}
    </section>
  );
}
