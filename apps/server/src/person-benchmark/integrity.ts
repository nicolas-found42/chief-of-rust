import { createHash } from "node:crypto";
import type {
  BenchmarkIntegrityFinding,
  PersonDossier,
  PersonSourceDocument,
} from "@chief-of-staff-demo/shared";

/**
 * The deterministic half of the evaluation.
 *
 * These checks answer questions that have a right answer: does the quoted
 * passage occur in the retained source version, is the source still attributed
 * to this dossier, does a supported claim actually carry a citation, does a
 * work reference a claim that exists, and did private Workspace evidence stay
 * out of the public projection.
 *
 * A semantic judge cannot overrule any of them. A model that finds a claim
 * "clearly true" has said nothing about whether the record supporting it is
 * intact, and a benchmark that let it say so would reward invented citations.
 */
export function checkIntegrity(
  dossier: PersonDossier | null,
  sources: PersonSourceDocument[],
  publicProjection: PersonDossier | null,
): { findings: BenchmarkIntegrityFinding[]; verifiedCitations: number; totalCitations: number } {
  const findings: BenchmarkIntegrityFinding[] = [];
  if (!dossier) return { findings, verifiedCitations: 0, totalCitations: 0 };
  const byId = new Map(sources.map((source) => [source.id, source]));
  const claimIds = new Set(dossier.claims.map((claim) => claim.id));
  let verified = 0;
  let total = 0;

  for (const claim of dossier.claims) {
    if (claim.status !== "unknown" && claim.citations.length === 0)
      findings.push({
        fingerprint: findingKey("claim-status-supported", claim.statement),
        check: "claim-status-supported",
        severity: "critical",
        subject: claim.id,
        detail: `A ${claim.status} claim carries no citation: "${claim.statement.slice(0, 160)}"`,
      });
    for (const citation of claim.citations) {
      total += 1;
      const source = byId.get(citation.sourceId);
      if (!source) {
        findings.push({
          fingerprint: findingKey("citation-source-retained", claim.statement, citation.quote),
          check: "citation-source-retained",
          severity: "critical",
          subject: claim.id,
          detail: `Citation names source ${citation.sourceId}, which the dossier does not retain.`,
        });
        continue;
      }
      if (!source.text.includes(citation.quote)) {
        findings.push({
          fingerprint: findingKey(
            "citation-quote-present",
            claim.statement,
            source.url,
            source.hash,
            citation.quote,
          ),
          check: "citation-quote-present",
          severity: "critical",
          subject: claim.id,
          detail: `Quoted passage does not occur in the retained version of ${source.url}: "${citation.quote.slice(0, 160)}"`,
        });
        continue;
      }
      if (source.completeness === "partial" || source.extractionCoverage === "partial")
        findings.push({
          check: "citation-source-version",
          severity: "minor",
          subject: claim.id,
          detail: `Supported by a partially retained version of ${source.url}; the passage verified, the surrounding context may not be complete.`,
        });
      verified += 1;
    }
  }

  for (const work of dossier.works)
    for (const id of work.claimIds)
      if (!claimIds.has(id))
        findings.push({
          check: "work-claim-reference",
          severity: "major",
          subject: work.id,
          detail: `Work "${work.title}" references claim ${id}, which is not in the dossier.`,
        });

  /* Private Workspace evidence must not reach the public projection. This is a
     benchmark-side check of a production guarantee, so a regression shows up
     as a critical finding rather than as a quiet privacy change. */
  if (publicProjection) {
    const privateIds = new Set(
      sources.filter((source) => source.visibility === "private").map((source) => source.id),
    );
    for (const claim of publicProjection.claims)
      for (const citation of claim.citations)
        if (privateIds.has(citation.sourceId))
          findings.push({
            fingerprint: findingKey(
              "private-evidence-isolation",
              claim.statement,
              byId.get(citation.sourceId)?.url ?? "",
              byId.get(citation.sourceId)?.hash ?? "",
              citation.quote,
            ),
            check: "private-evidence-isolation",
            severity: "critical",
            subject: claim.id,
            detail: "A public projection cites private Workspace evidence.",
          });
  }

  return { findings, verifiedCitations: verified, totalCitations: total };
}

function findingKey(...evidence: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(evidence.map((value) => value.replace(/\s+/g, " ").trim())))
    .digest("hex");
}

/** How many findings would block acceptance on their own. */
export function criticalCount(findings: BenchmarkIntegrityFinding[]): number {
  return findings.filter((finding) => finding.severity === "critical").length;
}
