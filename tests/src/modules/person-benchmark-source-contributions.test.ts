import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { BenchmarkReportSchema } from "@chief-of-staff-demo/shared";
import { loadCorpus } from "../../../apps/server/src/person-benchmark/corpus.js";
import { evaluatePerson } from "../../../apps/server/src/person-benchmark/evaluate.js";
import {
  compareReports,
  renderComparison,
  renderReport,
  summarizeGroups,
} from "../../../apps/server/src/person-benchmark/report.js";
import { sourceContributions } from "../../../apps/server/src/person-benchmark/source-contributions.js";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { checkIntegrity } from "../../../apps/server/src/person-benchmark/integrity.js";

it("reports actual cited-family recovery separately from reference cohorts and unused retained material", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-source-contributions-"));
  try {
    const person = structuredClone(
      loadCorpus(
        fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
      ).people[0],
    );
    const quote = "Maya Chen designed the Atlas scheduler.";
    const socialUrl = "https://example.com/social";
    const recordsUrl = "https://example.com/records";
    person.fictional = true;
    person.lookup = {
      fullName: "Maya Chen",
      employerHint: null,
      profileUrls: [socialUrl, recordsUrl],
      emails: [],
    };
    person.facts = [
      {
        ...person.facts[0],
        id: "scheduler",
        statement: quote,
        support: [{ documentId: person.documents[0].id, quote }],
      },
    ];
    // The reference family deliberately differs from the production document that recovers it.
    person.documents = [{ ...person.documents[0], family: "documents-publishers" }];
    const evaluation = await evaluatePerson(person, "live-discovery", {
      workspaceDir: root,
      search: async () => [],
      readSource: async (url) => ({
        text: `${quote} ${url === socialUrl ? "Public post." : "Institutional copy not extracted."}`,
        capturedAt: null,
        completeness: "full",
        access: "retrieved",
        outboundUrls: [],
        family: url === socialUrl ? "public-social" : "professional-records",
        route: "controlled-fixture",
        upstreamIndex: "shared-index",
        publishedAt: null,
        author: null,
        anchors: [],
        provenanceNote: "Controlled test",
        sourceVersion: null,
        rights: null,
        finalUrl: url,
      }),
      complete:
        () =>
        async ({ user }) => ({
          fullName: null,
          employer: null,
          sourceClass: "self-report",
          author: null,
          publishedAt: null,
          claims:
            (JSON.parse(user) as { document: { url: string } }).document.url === socialUrl
              ? [
                  {
                    id: "scheduler",
                    section: "work",
                    statement: quote,
                    status: "supported",
                    nature: "statement",
                    matchConfidence: "high",
                    effectiveFrom: null,
                    effectiveTo: null,
                    citations: [{ sourceId: "source", quote }],
                    supports: [],
                    supersedes: [],
                    changeReason: null,
                  },
                ]
              : [],
          works: [],
          expertise: [],
          connections: [],
          sections: [],
        }),
      judge: async ({ user }) => {
        const input = JSON.parse(user) as { references?: unknown; dossier: { id: string }[] };
        return input.references
          ? {
              judgements: [
                {
                  factId: "scheduler",
                  verdict: "recovered",
                  evidence: quote,
                  claimId: input.dossier[0].id,
                  rationale: "The claim states the reference fact.",
                },
              ],
            }
          : {
              understanding: 1,
              remainingQuestions: 1,
              conversationReadiness: 1,
              rationale: "One controlled fact.",
              uncertain: false,
              overclaims: [],
            };
      },
    });
    expect(evaluation.result.completeness.judgements).toContainEqual(
      expect.objectContaining({ factId: "scheduler", verdict: "recovered" }),
    );
    const contribution = evaluation.result.sourceContributions!;
    expect(contribution).toContainEqual(
      expect.objectContaining({
        family: "public-social",
        recoveredFactIds: ["scheduler"],
        exclusiveRecoveredFactIds: ["scheduler"],
        sources: expect.arrayContaining([
          expect.objectContaining({ url: socialUrl, upstreamIndex: "shared-index", cited: true }),
        ]),
      }),
    );
    expect(contribution).toContainEqual(
      expect.objectContaining({
        family: "professional-records",
        claimIds: [],
        recoveredFactIds: [],
        exclusiveRecoveredFactIds: [],
        sources: expect.arrayContaining([
          expect.objectContaining({ url: recordsUrl, cited: false }),
        ]),
      }),
    );
    const groups = summarizeGroups([person], [evaluation.result]);
    expect(groups).toContainEqual(
      expect.objectContaining({
        dimension: "reference-source-family",
        key: "documents-publishers",
        recovered: 1,
      }),
    );
    expect(groups.some((group) => group.dimension === "source-family")).toBe(false);

    const report = BenchmarkReportSchema.parse(
      JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL(
              "../../../artifacts/person-benchmark/fixed-documents-expanded-2d0a903133188b6a.json",
              import.meta.url,
            ),
          ),
          "utf8",
        ),
      ),
    );
    report.people = [evaluation.result];
    report.groups = groups;
    const rendered = renderReport(report, [person]);
    expect(rendered).toContain("Actual source-family contributions");
    expect(rendered).toContain("public-social | 2 / 1 | 1 | 1 / 1 | 1");
    expect(rendered).toContain("professional-records | 2 / 0 | 0 | 0 / 1 | 0");
    const legacy = structuredClone(report);
    delete legacy.people[0].sourceContributions;
    const comparison = compareReports(legacy, report);
    expect(comparison.sourceContributions).toContainEqual(
      expect.objectContaining({
        family: "public-social",
        baseline: null,
        candidate: {
          people: 1,
          retainedSources: 2,
          citedSources: 1,
          recoveredFacts: 1,
          exclusiveRecoveredFacts: 1,
        },
      }),
    );
    expect(renderComparison(comparison)).toContain(
      "public-social | unmeasured | 2 / 1 | unmeasured | 1 / 1",
    );

    const store = new PersonDossierStore(root);
    const dossier = store.project(evaluation.profileId, "public")!;
    const sources = dossier.sourceIds.map((id) => store.source(evaluation.profileId, id)!);
    const record = sources.find((source) => source.url === recordsUrl)!;
    dossier.claims[0].citations.push({ sourceId: record.id, quote });
    const overlap = sourceContributions(
      dossier,
      sources,
      evaluation.result.completeness.judgements,
      new Set(),
    );
    expect(overlap.every((entry) => entry.recoveredFactIds.includes("scheduler"))).toBe(true);
    expect(overlap.every((entry) => entry.exclusiveRecoveredFactIds.length === 0)).toBe(true);
    const rejected = sourceContributions(
      dossier,
      sources,
      evaluation.result.completeness.judgements,
      new Set([dossier.claims[0].id]),
    );
    expect(rejected.every((entry) => entry.recoveredFactIds.length === 0)).toBe(true);

    const broken = structuredClone(dossier);
    broken.claims[0].citations = [{ sourceId: "unretained-random-id", quote }];
    const before = checkIntegrity(broken, sources, null).findings;
    broken.claims[0].id = "regenerated-claim-id";
    broken.claims[0].citations[0].sourceId = "another-unretained-id";
    expect(checkIntegrity(broken, sources, null).findings[0].fingerprint).toBe(
      before[0].fingerprint,
    );
    broken.claims[0].statement = "Maya Chen deployed an unrelated system.";
    expect(checkIntegrity(broken, sources, null).findings[0].fingerprint).not.toBe(
      before[0].fingerprint,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
