import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  CONTENT_TARGET_CATALOG,
  type ContentProject,
  type ContentProjectReadiness,
  type ContentProjectRevision,
  type ContentProjectTarget,
} from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import { contentApi, type ContentClient } from "../clients/content";
import { contentProjectGateNotices } from "../contentProjectGates";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

function subjectLabel(revision: ContentProjectRevision): string {
  const subject = revision.subject;
  return subject.kind === "topic" ? subject.topic : subject.profileId;
}

function targetLabel(target: ContentProjectTarget): string {
  const entry = CONTENT_TARGET_CATALOG.find((candidate) => candidate.target === target);
  return entry ? `${entry.contract.platform} · ${entry.contract.format}` : target;
}

/**
 * One Content Project, and the gates between it and generated work (spec #147).
 *
 * The page renders what `WorkspaceContentProjects` reports and asks it to act;
 * it decides nothing. An operation the domain refuses comes back naming its
 * gate, and that name is what the page shows — a refusal is never a bare
 * "not ready".
 */
export function ContentProjectDetailPage({ client = contentApi }: { client?: ContentClient }) {
  const { projectId } = useParams<{ projectId: string }>();
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [project, setProject] = useState<ContentProject | null>(null);
  const [readiness, setReadiness] = useState<ContentProjectReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [instruction, setInstruction] = useState("");

  const revision = project?.revisions.at(-1) ?? null;
  useTitle(revision ? subjectLabel(revision) : "Content Project");

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const detail = await client.contentProject(projectId);
      setProject(detail.project);
      setReadiness(detail.readiness);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [client, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (work: () => Promise<void>, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  if (!projectId) return null;

  return (
    <div className="page">
      <p>
        <Link to="/content-scout">← All Content Projects</Link>
      </p>
      <h1 ref={headingRef} tabIndex={-1}>
        {revision ? subjectLabel(revision) : "Content Project"}
      </h1>

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

      {!project && !error && (
        <p className="muted" role="status">
          Loading Content Project…
        </p>
      )}

      {project && revision && (
        <>
          <div className="card">
            <h2>Intent</h2>
            <dl>
              <dt>Revision</dt>
              <dd>{revision.revision}</dd>
              <dt>Objective</dt>
              <dd>{revision.objective}</dd>
              <dt>Audience</dt>
              <dd>{revision.audience}</dd>
              <dt>Research mode</dt>
              <dd>{revision.researchMode ?? "—"}</dd>
              <dt>Authorized Author</dt>
              <dd>
                <Link to={`/people/${encodeURIComponent(revision.author.profileId)}`}>
                  {revision.author.profileId}
                </Link>{" "}
                (revision {revision.author.profileRevision})
              </dd>
              <dt>Targets</dt>
              <dd>{revision.targets.map(targetLabel).join(", ") || "—"}</dd>
              <dt>Constraints</dt>
              <dd>{revision.constraints.join("; ") || "—"}</dd>
            </dl>
            {revision.sourceOpportunity && (
              <p className="muted">
                Started from Content Opportunity {revision.sourceOpportunity.opportunityId}.
              </p>
            )}
          </div>

          <div className="card">
            <h2>Readiness</h2>
            {readiness?.ready ? (
              <p className="status-badge status-ok" role="status">
                Every gate is clear — this Project can generate.
              </p>
            ) : (
              <>
                <p className="muted">
                  Generation stays closed until each of these is present. The Content Project
                  decides; this page only reports what it said.
                </p>
                <ul>
                  {readiness &&
                    contentProjectGateNotices(readiness).map((item) => (
                      <li key={item.gate}>
                        {item.label}{" "}
                        {item.href && item.hrefLabel && (
                          <Link to={item.href}>{item.hrefLabel}</Link>
                        )}
                      </li>
                    ))}
                </ul>
              </>
            )}
          </div>

          <div className="card">
            <h2>Evidence</h2>
            {revision.frozenEvidence ? (
              <p role="status">
                Frozen {new Date(revision.frozenEvidence.frozenAt).toLocaleString()} —{" "}
                {revision.frozenEvidence.sourceItems.length} Source Item(s). Everything generated
                from here argues from exactly this set.
              </p>
            ) : (
              <p className="muted">
                No evidence is frozen on this revision, so nothing can be generated from it yet.
              </p>
            )}
          </div>

          <div className="card">
            <h2>Outline Charters</h2>
            {revision.outlineCharters.length === 0 ? (
              <p className="muted">No Outline Charter has been proposed on this revision.</p>
            ) : (
              <ul>
                {revision.outlineCharters.map((brief) => {
                  const approved = revision.outlineCharterApprovals.some(
                    (approval) => approval.outlineCharterId === brief.id,
                  );
                  return (
                    <li key={brief.id}>
                      <strong>{brief.thesis || brief.id}</strong>{" "}
                      {approved ? (
                        <span className="status-badge status-ok">Approved — immutable</span>
                      ) : (
                        <button
                          type="button"
                          aria-disabled={busy}
                          onClick={() =>
                            void act(
                              () =>
                                client
                                  .contentProjectApproveOutlineCharter(projectId, brief.id)
                                  .then(() => undefined),
                              "The Outline Charter is approved and can no longer change.",
                            )
                          }
                        >
                          Approve Outline Charter
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="card">
            <h2>Platform Outlines</h2>
            <div className="field-row">
              <label htmlFor="outline-instruction">Regeneration instruction (optional)</label>
              <input
                id="outline-instruction"
                autoComplete="off"
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
              />
              <button
                type="button"
                className="primary"
                aria-disabled={busy}
                onClick={() =>
                  void act(
                    () =>
                      client.contentProjectGenerateOutlineSet(projectId).then((outcome) => {
                        if (outcome.failures.length > 0) {
                          setError(
                            `Outline Set incomplete: ${outcome.failures
                              .map((failure) => `${failure.target} (${failure.code})`)
                              .join(", ")}. Generating again retries only what is missing.`,
                          );
                        }
                      }),
                    "The Outline Set generated across every target.",
                  )
                }
              >
                {busy ? "Working…" : "Generate all nine targets"}
              </button>
            </div>
            {revision.platformOutlines.length === 0 ? (
              <p className="muted">No Platform Outline exists on this revision.</p>
            ) : (
              <div className="table-scroll">
                <table>
                  <caption className="visually-hidden">Platform Outlines by target</caption>
                  <thead>
                    <tr>
                      <th scope="col">Target</th>
                      <th scope="col">Version</th>
                      <th scope="col">Title</th>
                      <th scope="col">State</th>
                      <th scope="col">Draft</th>
                    </tr>
                  </thead>
                  <tbody>
                    {revision.platformOutlines.map((outline) => {
                      const approved = revision.platformOutlineApprovals.some(
                        (approval) => approval.platformOutlineId === outline.id,
                      );
                      return (
                        <tr key={outline.id}>
                          <td>{targetLabel(outline.target)}</td>
                          <td>{outline.version}</td>
                          <td>{outline.title}</td>
                          <td>
                            {approved ? (
                              <span className="status-badge status-ok">Approved</span>
                            ) : (
                              <button
                                type="button"
                                aria-disabled={busy}
                                onClick={() =>
                                  void act(
                                    () =>
                                      client
                                        .contentProjectApproveOutline(projectId, outline.target)
                                        .then(() => undefined),
                                    `The ${outline.target} Outline is approved.`,
                                  )
                                }
                              >
                                Approve
                              </button>
                            )}
                          </td>
                          <td>
                            <button
                              type="button"
                              aria-disabled={busy}
                              onClick={() =>
                                void act(
                                  () =>
                                    client
                                      .contentProjectGenerateDraft(
                                        projectId,
                                        outline.target,
                                        instruction.trim() === "" ? undefined : instruction,
                                      )
                                      .then(() => undefined),
                                  `A Content Engine Draft was generated for ${outline.target}.`,
                                )
                              }
                            >
                              Generate Draft
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <h2>Content Engine Drafts</h2>
            {revision.drafts.length === 0 ? (
              <p className="muted">
                No Draft has been generated. A Project may stop at a Platform Outline.
              </p>
            ) : (
              <ul>
                {revision.drafts.map((draft) => (
                  <li key={draft.id}>
                    {targetLabel(draft.target)} — version {draft.version}
                    {draft.claims.filter((claim) => !claim.supported).length > 0 && (
                      <span className="status-badge status-attention">
                        {draft.claims.filter((claim) => !claim.supported).length} unsupported
                        claim(s) marked
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="muted">
              A Draft is a Workspace record. No Notion page, publication record, schedule or
              analytics record is created, and no mail is sent.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
