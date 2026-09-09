import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  BenchmarkReportSchema,
  PersonDossierSchema,
  PersonSourceDocumentSchema,
} from "@chief-of-staff-demo/shared";
import type {
  BenchmarkPerson,
  BenchmarkPersonResult,
  BenchmarkReport,
  PersonDossier,
  PersonSourceDocument,
} from "@chief-of-staff-demo/shared";
import { loadCorpus } from "../../../apps/server/src/person-benchmark/corpus.js";
import { assessPerson } from "../../../apps/server/src/person-benchmark/evaluate.js";
import { judgePerson } from "../../../apps/server/src/person-benchmark/judge.js";
import {
  remainingMisses,
  renderReport,
  summarizeGroups,
} from "../../../apps/server/src/person-benchmark/report.js";

function fixture() {
  const person = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  ).people[0];
  person.fictional = true;
  person.displayName = "Fictional Maya";
  person.facts = [{ ...person.facts[0], statement: "Maya designed the scheduler." }];
  const quote = `${"Context. ".repeat(100)}The team built the interface; the individual designed its scheduler.`;
  const sources = Array.from({ length: 41 }, (_, index) =>
    PersonSourceDocumentSchema.parse({
      schemaVersion: 1,
      id: `source-${index}`,
      url: `https://example.com/${index}`,
      title: `Source ${index}`,
      author: null,
      publishedAt: null,
      retrievedAt: "2026-09-06",
      text: quote,
      hash: "a".repeat(64),
      family: "fixture",
      sourceClass: "independent-account",
      visibility: "public",
      completeness: "full",
      access: "retrieved",
      acquisition: "fixture",
      outboundUrls: ["https://example.com/navigation"],
    }),
  );
  const dossier = PersonDossierSchema.parse({
    schemaVersion: 1,
    profileId: "fixture",
    revision: 1,
    updatedAt: "2026-09-06",
    sourceIds: sources.map((source) => source.id),
    works: [],
    expertise: [],
    connections: [],
    sections: [],
    claims: Array.from({ length: 121 }, (_, index) => ({
      id: `claim-${index}`,
      statement:
        index === 120
          ? "Maya designed the scheduler and built the entire interface."
          : `Other fact ${index}`,
      section: "career",
      status: "supported",
      nature: "statement",
      matchConfidence: "high",
      effectiveFrom: null,
      effectiveTo: null,
      supports: [],
      supersedes: [],
      changeReason: null,
      citations: Array.from({ length: 4 }, (_, citation) => ({
        sourceId: `source-${citation === 3 ? 40 : citation}`,
        quote: citation === 3 ? quote : "Context.",
      })),
    })),
  });
  return { person, dossier, sources, quote };
}

it("assesses recovery and overclaims beyond claim 120 with complete passages and source metadata", async () => {
  const { person, dossier, sources, quote } = fixture();
  const result = await judgePerson(
    async ({ user }) => {
      const request = JSON.parse(user) as {
        references?: unknown;
        dossier: {
          id: string;
          statement: string;
          citations: { citationIndex: number; sourceId: string; quote: string }[];
        }[];
        retainedSources?: { url: string }[];
      };
      expect(user).not.toContain("https://example.com/navigation");
      const target = request.dossier.find((claim) => claim.id === "claim-120");
      if (request.references)
        return {
          judgements: [
            {
              factId: person.facts[0].id,
              verdict: target ? "recovered" : "missing",
              evidence: target?.statement ?? null,
              claimId: target?.id ?? null,
              rationale: "Matched supplied evidence.",
            },
          ],
        };
      expect(request.retainedSources).toEqual(
        sources.map((source) =>
          PersonSourceDocumentSchema.omit({ text: true, outboundUrls: true }).parse(source),
        ),
      );
      const supportPresent =
        target?.citations.some((citation) => citation.quote === quote) &&
        request.retainedSources?.some((source) => source.url === sources[40].url);
      return {
        understanding: 1,
        remainingQuestions: 1,
        conversationReadiness: 1,
        rationale: "Checked individual contribution.",
        uncertain: false,
        overclaims:
          target && supportPresent
            ? [
                {
                  claimId: target.id,
                  citationIndex: 3,
                  statement: target.statement,
                  kind: "team-output-as-personal",
                  rationale: "The complete passage attributes the interface to the team.",
                  matchedUnjustifiedId: null,
                  uncertain: false,
                },
              ]
            : [],
      };
    },
    person,
    dossier,
    sources,
  );
  expect(result.complete).toBe(true);
  expect(result.judgements[0]).toMatchObject({ verdict: "recovered", claimId: "claim-120" });
  expect(result.overclaims).toContainEqual(
    expect.objectContaining({
      claimId: "claim-120",
      kind: "team-output-as-personal",
      citationIndex: 3,
      citedSourceId: "source-40",
      citedQuote: quote,
    }),
  );
});

/** The durable rationale for one reply, asserting the record the run keeps. */
async function recordedRationale(rationale: string): Promise<string> {
  const { person, dossier, sources } = fixture();
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId: person.facts[0].id,
                verdict: "recovered",
                evidence: dossier.claims[120].statement,
                claimId: "claim-120",
                rationale,
              },
            ],
          }
        : {
            understanding: 1,
            remainingQuestions: 0,
            conversationReadiness: 1,
            rationale: "Reviewed support.",
            uncertain: false,
            overclaims: [],
          },
    person,
    dossier,
    sources,
  );
  expect(result.complete).toBe(true);
  expect(result.judgements[0].verdict).toBe("recovered");
  return result.judgements[0].rationale;
}

it("passes an exact-fit rationale through to the record unchanged", async () => {
  // 998 ASCII units plus one two-unit emoji: exactly the 1000-unit ceiling.
  const exact = "x".repeat(998) + String.fromCodePoint(0x1f600);
  expect(await recordedRationale(exact)).toBe(exact);
});

it("clips an over-long rationale to the schema ceiling", async () => {
  const overlong = "Long. " + "y".repeat(1400);
  expect(await recordedRationale(overlong)).toBe(overlong.slice(0, 1000));
});

it("drops a whole surrogate pair rather than half when it straddles the ceiling", async () => {
  const straddling = "x".repeat(999) + `${String.fromCodePoint(0x1f600)} excluded`;
  const recorded = await recordedRationale(straddling);
  expect(recorded).toBe("x".repeat(999));
  expect(recorded).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

it("marks a saturated overclaim response incomplete while retaining its findings", async () => {
  const { person, dossier, sources } = fixture();
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId: person.facts[0].id,
                verdict: "missing",
                evidence: null,
                claimId: null,
                rationale: "Not recovered.",
              },
            ],
          }
        : {
            understanding: 0,
            remainingQuestions: 0,
            conversationReadiness: 0,
            rationale: "Many unsupported assertions.",
            uncertain: false,
            overclaims: dossier.claims.slice(0, 40).map((claim) => ({
              claimId: claim.id,
              citationIndex: 0,
              statement: claim.statement,
              kind: "unsupported-inference",
              rationale: "The citation does not establish this claim.",
              matchedUnjustifiedId: null,
              uncertain: false,
            })),
          },
    person,
    dossier,
    sources,
  );
  expect(result.complete).toBe(false);
  expect(result.overclaims).toHaveLength(40);
  expect(result.incompleteReason).toContain("overclaim response limit of 40");
  expect(result.usefulness.reviewRequired).toBe(true);
  expect(result.usefulness.rationale).toContain("overclaim response limit of 40");
});

it.each([
  ["wrong-person", false],
  ["invented-evidence", false],
  ["unsupported-inference", true],
  ["none", false],
] as const)(
  "withholds recovered/partial credit from validated %s findings before aggregates",
  async (kind, uncertain) => {
    const { assessPerson } = await import("../../../apps/server/src/person-benchmark/evaluate.js");
    const { createHash } = await import("node:crypto");
    const { person, dossier, sources } = fixture();
    for (const source of sources)
      source.hash = createHash("sha256").update(source.text).digest("hex");
    for (const verdict of ["recovered", "partial"] as const) {
      const result = await assessPerson(person, "fixed-documents", {
        dossier,
        publicProjection: dossier,
        sources,
        operation: null,
        elapsedMilliseconds: 0,
        judge: async ({ user }) =>
          user.includes('"references":')
            ? {
                judgements: [
                  {
                    factId: person.facts[0].id,
                    verdict,
                    evidence: dossier.claims[120].statement,
                    claimId: "claim-120",
                    rationale: "Semantic match.",
                  },
                ],
              }
            : {
                understanding: 1,
                remainingQuestions: 1,
                conversationReadiness: 1,
                uncertain: false,
                rationale: "Reviewed support.",
                overclaims:
                  kind === "none"
                    ? []
                    : [
                        {
                          claimId: "claim-120",
                          statement: dossier.claims[120].statement,
                          citationIndex: 3,
                          kind,
                          rationale: "The selected passage does not support this attribution.",
                          matchedUnjustifiedId: null,
                          uncertain,
                        },
                      ],
              },
      });
      expect(result.assessment?.judge).toBe("completed");
      expect(result.completeness.judgements[0].verdict).toBe(
        kind === "none" ? verdict : "ambiguous",
      );
      if (kind !== "none") {
        expect(result.completeness.recovered + result.completeness.partial).toBe(0);
        expect(result.completeness.judgements[0]).toMatchObject({
          reviewRequired: true,
          rationale: expect.stringContaining(`Original semantic verdict: ${verdict}`),
        });
        expect(
          Object.values(result.completeness.byRequirement).every((row) => row.recovered === 0),
        ).toBe(true);
        expect(result.sourceContributions?.every((row) => row.recoveredFactIds.length === 0)).toBe(
          true,
        );
      }
    }
  },
);
/** A minimal report around one assessed fixture person, rendered the way a run writes it. */
async function renderedReport(
  person: BenchmarkPerson,
  result: BenchmarkPersonResult,
): Promise<{
  report: BenchmarkReport;
  rendered: string;
}> {
  const report = BenchmarkReportSchema.parse({
    schemaVersion: 1,
    runId: "support-attribution",
    status: "failed",
    statusDetail: "Fixture",
    mode: "fixed-documents",
    selection: { requested: [person.slug], evaluated: [person.slug], skipped: [] },
    provenance: {
      corpusVersion: "fixed",
      referenceVersions: { [person.slug]: person.referenceVersion },
      pipeline: "expanded",
      researchProvider: "fixture",
      researchModel: "fixture",
      judgeProvider: "fixture",
      judgeModel: "fixture",
      judgeVersion: "1",
      promptVersion: "1",
      collectorVersions: {},
      researchSettings: {},
      network: "fixed-documents",
      startedAt: "2026-09-07",
      finishedAt: "2026-09-07",
      host: "fixture",
    },
    people: [result],
    groups: summarizeGroups([person], [result]),
    remainingMisses: remainingMisses([person], [result]),
  });
  return { report, rendered: renderReport(report, [person]) };
}
it("attributes verdicts withheld for an incomplete support assessment separately from semantic ambiguity", async () => {
  const { person, dossier, sources } = fixture();
  for (const source of sources)
    source.hash = createHash("sha256").update(source.text).digest("hex");
  /* The observed shape (#271): the reference phase completes on the same
     model, and the support/usefulness phase fails against the upstream. The
     judge fake fails the support call the way the seam reports it. */
  const result = await assessPerson(person, "fixed-documents", {
    dossier,
    publicProjection: dossier,
    sources,
    operation: null,
    elapsedMilliseconds: 0,
    judge: async ({ user }) => {
      if (user.includes('"references":'))
        return {
          judgements: [
            {
              factId: person.facts[0].id,
              verdict: "recovered",
              evidence: dossier.claims[120].statement,
              claimId: "claim-120",
              rationale: "Semantic match.",
            },
          ],
        };
      throw new Error("SSE error chunk from the upstream: code 502");
    },
  });
  /* ADR-0067 keeps the per-verdict record withheld; what changes is that the
     headline counts name the cause instead of blurring it into ambiguity. */
  expect(result.completeness).toMatchObject({
    recovered: 0,
    ambiguous: 1,
    ambiguousSupportAssessmentFailed: 1,
  });
  expect(result.assessment?.phases?.support.status).toBe("failed");
  const { report, rendered: readable } = await renderedReport(person, result);
  expect(readable).toContain(
    "1 of them withheld for an incomplete support/usefulness assessment rather than semantic ambiguity",
  );
  expect(readable).toContain("Support-failed");
  /* The group table is a headline consumers read; the summary must carry the
     same attribution the per-person record does (#271, CODING_STANDARDS:
     a test asserts the record, not only its summary). */
  for (const group of report.groups) expect(group.ambiguousSupportAssessmentFailed).toBe(1);
  /* The bullet must reconcile against the fact denominator on the page:
     the fixture's one fact is ambiguous-withheld, so zero are missing. */
  expect(readable).toContain("left ambiguous for review, 1 of them withheld");
  expect(readable).toContain("0 contradicted by the reference, and 0 still missing.");
});

it("appends the withholding disclosure to beyond-current-coverage miss rows", async () => {
  /* #284: the anders-danielsson withheld rows read only as research-side
     language ambiguity because the beyond-current-coverage branch replaces
     the judgement's rationale — which carries the downgrade disclosure —
     with the corpus note. The disclosure must survive the substitution. */
  const { person, dossier, sources } = fixture();
  for (const source of sources)
    source.hash = createHash("sha256").update(source.text).digest("hex");
  person.facts[0] = {
    ...person.facts[0],
    acquisition: "beyond-current-coverage",
    note: "Recorded only in the Swedish-language source.",
  };
  const result = await assessPerson(person, "fixed-documents", {
    dossier,
    publicProjection: dossier,
    sources,
    operation: null,
    elapsedMilliseconds: 0,
    judge: async ({ user }) => {
      if (user.includes('"references":'))
        return {
          judgements: [
            {
              factId: person.facts[0].id,
              verdict: "recovered",
              evidence: dossier.claims[120].statement,
              claimId: "claim-120",
              rationale: "Semantic match.",
            },
          ],
        };
      throw new Error("SSE error chunk from the upstream: code 502");
    },
  });
  const { report, rendered: readable } = await renderedReport(person, result);
  const miss = report.remainingMisses[0];
  expect(miss.explanation).toContain("Recorded only in the Swedish-language source.");
  expect(miss.explanation).toContain(
    "Original semantic verdict: recovered; downgraded to ambiguous because support/usefulness assessment did not complete; positive recovery credit is withheld.",
  );
  expect(readable).toContain("positive recovery credit is withheld.");
});

it("does not attribute a judge's own ambiguity to an incomplete support assessment", async () => {
  const { person, dossier, sources } = fixture();
  for (const source of sources)
    source.hash = createHash("sha256").update(source.text).digest("hex");
  const result = await assessPerson(person, "fixed-documents", {
    dossier,
    publicProjection: dossier,
    sources,
    operation: null,
    elapsedMilliseconds: 0,
    judge: async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId: person.facts[0].id,
                verdict: "ambiguous",
                evidence: dossier.claims[120].statement,
                claimId: "claim-120",
                rationale: "The evidence genuinely underdetermines the fact.",
              },
            ],
          }
        : {
            understanding: 1,
            remainingQuestions: 1,
            conversationReadiness: 1,
            uncertain: false,
            rationale: "Reviewed support.",
            overclaims: [],
          },
  });
  expect(result.assessment?.phases?.support.status).toBe("completed");
  expect(result.completeness).toMatchObject({
    recovered: 0,
    ambiguous: 1,
    ambiguousSupportAssessmentFailed: 0,
  });
  const { report, rendered: readable } = await renderedReport(person, result);
  expect(readable).toContain(
    "0 of them withheld for an incomplete support/usefulness assessment rather than semantic ambiguity",
  );
  for (const group of report.groups) expect(group.ambiguousSupportAssessmentFailed).toBe(0);
});

it.each(["wrong-index", "null-with-citations", "null-without-citations"] as const)(
  "validates the selected citation against its own claim: %s",
  async (kind) => {
    const { person, dossier, sources } = fixture();
    if (kind === "null-without-citations") dossier.claims[120].citations = [];
    const result = await judgePerson(
      async ({ user }) =>
        user.includes('"references":')
          ? {
              judgements: [
                {
                  factId: person.facts[0].id,
                  verdict: "missing",
                  evidence: null,
                  claimId: null,
                  rationale: "Missing.",
                },
              ],
            }
          : {
              understanding: 1,
              remainingQuestions: 1,
              conversationReadiness: 1,
              uncertain: false,
              rationale: "Reviewed support.",
              overclaims: [
                {
                  claimId: "claim-120",
                  statement: dossier.claims[120].statement,
                  citationIndex: kind === "wrong-index" ? 29 : null,
                  kind: "invented-evidence",
                  rationale: "Fixture finding.",
                  matchedUnjustifiedId: null,
                  uncertain: false,
                },
              ],
            },
      person,
      dossier,
      sources,
    );
    expect(result.complete).toBe(kind === "null-without-citations");
    if (kind === "null-without-citations")
      expect(result.overclaims[0]).toMatchObject({
        citationIndex: null,
        citedSourceId: null,
        citedQuote: null,
      });
    else {
      expect(result.overclaims).toEqual([]);
      expect(result.phases.support).toMatchObject({
        status: "failed",
        unresolvedFindings: [
          expect.objectContaining({ claimId: "claim-120", citedSourceId: null, citedQuote: null }),
        ],
      });
    }
  },
);

const SUPPORT_OK = {
  understanding: 1,
  remainingQuestions: 1,
  conversationReadiness: 1,
  uncertain: false,
  rationale: "Reviewed support.",
  overclaims: [],
};

it("credits a verdict that selects its claim by a verbatim claim excerpt", async () => {
  const { person, dossier, sources } = fixture();
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId: person.facts[0].id,
                verdict: "recovered",
                evidence: dossier.claims[120].statement,
                claimId: "claim-120",
                rationale: "The dossier states the same fact.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0]).toMatchObject({ verdict: "recovered", claimId: "claim-120" });
  expect(result.judgements[0].rationale).not.toContain("does not occur in the dossier");
  expect(result.judgements[0].reviewRequired).toBe(false);
});

it("rejects a citation-passage selection as an unresolved observation", async () => {
  const { person, dossier, sources, quote } = fixture();
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId: person.facts[0].id,
                verdict: "recovered",
                evidence: quote,
                claimId: "claim-120",
                rationale: "The dossier states the same fact.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0].verdict).toBe("ambiguous");
  expect(result.judgements[0].reviewRequired).toBe(true);
  expect(result.judgements[0].rationale).toContain("does not occur in the dossier");
  expect(result.judgements[0].rationale).toContain("cited passage, not the claim statement");
});

it("recognizes a citation-passage selection despite formatting differences", async () => {
  const { person, dossier, sources, quote } = fixture();
  const wrapped = quote.replace("built the interface;", "built the\ninterface;");
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId: person.facts[0].id,
                verdict: "recovered",
                evidence: wrapped,
                claimId: "claim-120",
                rationale: "The dossier states the same fact.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0].verdict).toBe("ambiguous");
  expect(result.judgements[0].rationale).toContain("does not occur in the dossier");
  expect(result.judgements[0].rationale).toContain("cited passage, not the claim statement");
});

it("rejects an invented excerpt as an unresolved observation", async () => {
  const { person, dossier, sources } = fixture();
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId: person.facts[0].id,
                verdict: "recovered",
                evidence: "Maya single-handedly invented the scheduler in 1999.",
                claimId: "claim-120",
                rationale: "The dossier states the same fact.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0].verdict).toBe("ambiguous");
  expect(result.judgements[0].reviewRequired).toBe(true);
  expect(result.judgements[0].rationale).toContain("does not occur in the dossier");
  expect(result.judgements[0].rationale).not.toContain("cited passage, not the claim statement");
});

it("shows the recovery judge claim statements without cited passages", async () => {
  const { person, dossier, sources } = fixture();
  const captured: { dossier: unknown[] | null } = { dossier: null };
  await judgePerson(
    async ({ user }) => {
      const request = JSON.parse(user) as { references?: unknown; dossier: unknown[] };
      if (request.references) {
        captured.dossier = request.dossier;
        return {
          judgements: [
            {
              factId: person.facts[0].id,
              verdict: "missing",
              evidence: null,
              claimId: null,
              rationale: "Not recovered.",
            },
          ],
        };
      }
      return SUPPORT_OK;
    },
    person,
    dossier,
    sources,
  );
  expect(captured.dossier).toHaveLength(dossier.claims.length);
  for (const entry of captured.dossier ?? []) {
    expect(entry).not.toHaveProperty("citations");
    expect(JSON.stringify(entry)).not.toContain("Context.");
  }
});

/* Issue #236: paraphrase and cross-language matches receive decided verdicts.
 *
 * The contract has a deterministic half and a model half, and only the first
 * is reachable from here. These tests pin the recovery prompt's contract and
 * the guard's treatment of each verdict shape: that a decided paraphrase
 * survives, that a cross-language excerpt is credited while citation
 * integrity stays exact, that a rejection carries the claim it rejected, and
 * that the judge's own ambiguity is preserved as itself.
 *
 * Whether the model actually decides a paraphrase it could have parked is not
 * a unit test — it needs a live call, which spends provider budget and has no
 * credential in CI, so it belongs in a prompt eval rather than in `check`.
 * That measurement is issue #270, against a population whose dossiers carry
 * claims; the run recorded on the pull request is its first data point.
 */

/**
 * One reference fact, one dossier claim, one cited passage. The wording of
 * each is the variable under test, so a paraphrase, a translation and an
 * unsupported broadening differ only in the strings supplied here.
 */
function semanticFixture(options: { reference: string; claim: string; passage: string }): {
  person: BenchmarkPerson;
  factId: string;
  dossier: PersonDossier;
  sources: PersonSourceDocument[];
} {
  const person = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  ).people[0];
  person.fictional = true;
  person.displayName = "Fictional Maya";
  const factId = person.facts[0].id;
  person.facts = [{ ...person.facts[0], statement: options.reference }];
  const sources = [
    PersonSourceDocumentSchema.parse({
      schemaVersion: 1,
      id: "source-0",
      url: "https://example.com/0",
      title: "Source 0",
      author: null,
      publishedAt: null,
      retrievedAt: "2026-09-06",
      text: `Context. ${options.passage}`,
      hash: "b".repeat(64),
      family: "fixture",
      sourceClass: "independent-account",
      visibility: "public",
      completeness: "full",
      access: "retrieved",
      acquisition: "fixture",
      outboundUrls: [],
    }),
  ];
  const dossier = PersonDossierSchema.parse({
    schemaVersion: 1,
    profileId: "semantic-fixture",
    revision: 1,
    updatedAt: "2026-09-06",
    sourceIds: ["source-0"],
    works: [],
    expertise: [],
    connections: [],
    sections: [],
    claims: [
      {
        id: "claim-semantic",
        statement: options.claim,
        section: "career",
        status: "supported",
        nature: "statement",
        matchConfidence: "high",
        effectiveFrom: null,
        effectiveTo: null,
        supports: [],
        supersedes: [],
        changeReason: null,
        citations: [{ sourceId: "source-0", quote: options.passage }],
      },
    ],
  });
  return { person, factId, dossier, sources };
}

it("states the meaning contract to the recovery judge", async () => {
  const { person, factId, dossier, sources } = semanticFixture({
    reference: "Maya designed the scheduler in 2021.",
    claim: "In 2021 Maya created the scheduling component.",
    passage: "Colleagues confirm Maya created the scheduling component in 2021.",
  });
  let recoverySystem = "";
  await judgePerson(
    async ({ system, user }) => {
      if (!user.includes('"references":')) return SUPPORT_OK;
      recoverySystem = system;
      return {
        judgements: [
          { factId, verdict: "missing", evidence: null, claimId: null, rationale: "Not stated." },
        ],
      };
    },
    person,
    dossier,
    sources,
  );
  /* Paraphrase and translation are decidable; scope, subject and dates are
     what a paraphrase has to preserve; ambiguous is for evidence that does
     not settle the question, not for wording the judge has to work at. */
  expect(recoverySystem).toContain("same scope, subject and dates");
  expect(recoverySystem).toContain("different language");
  expect(recoverySystem).toContain("broadens");
  expect(recoverySystem).toContain("genuinely does not settle");
});

it("credits a paraphrase that preserves scope, subject and dates", async () => {
  const claim = "In 2021 Maya created the scheduling component.";
  const { person, factId, dossier, sources } = semanticFixture({
    reference: "Maya designed the scheduler in 2021.",
    claim,
    passage: "Colleagues confirm Maya created the scheduling component in 2021.",
  });
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId,
                verdict: "recovered",
                evidence: claim,
                claimId: "claim-semantic",
                rationale: "The dossier restates the fact with the same scope, subject and dates.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0]).toMatchObject({
    verdict: "recovered",
    claimId: "claim-semantic",
    evidenceQuote: claim,
    reviewRequired: false,
  });
  expect(result.judgements[0].rationale).not.toContain("Downgraded");
});

it("judges a claim written in another language than its citation on meaning", async () => {
  /* The claim is Swedish, its cited passage Swedish, the reference English:
     the language gap is the designed property the collection carries, not a
     reason to withhold a verdict. */
  const claim = "Danielsson tillträdde som verkställande direktör för Skanska den 1 januari 2018.";
  const { person, factId, dossier, sources } = semanticFixture({
    reference: "Anders Danielsson took office as chief executive of Skanska on 1 January 2018.",
    claim,
    passage: `Enligt bolaget: ${claim}`,
  });
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId,
                verdict: "recovered",
                evidence: claim,
                claimId: "claim-semantic",
                rationale: "The Swedish claim states the English reference fact.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0]).toMatchObject({
    verdict: "recovered",
    claimId: "claim-semantic",
    evidenceQuote: claim,
    reviewRequired: false,
  });
  /* Citation integrity is untouched by the language gap: the cited passage
     still has to occur verbatim in the retained source. */
  const { checkIntegrity } = await import("../../../apps/server/src/person-benchmark/integrity.js");
  expect(checkIntegrity(dossier, sources, dossier).findings).toEqual([]);
});

it("keeps the excerpt contract for a cross-language citation-passage selection", async () => {
  const claim = "Danielsson tillträdde som verkställande direktör för Skanska den 1 januari 2018.";
  const passage = `Enligt bolaget: ${claim}`;
  const { person, factId, dossier, sources } = semanticFixture({
    reference: "Anders Danielsson took office as chief executive of Skanska on 1 January 2018.",
    claim,
    passage,
  });
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId,
                verdict: "recovered",
                evidence: passage,
                claimId: "claim-semantic",
                rationale: "The dossier states the same fact.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0].verdict).toBe("ambiguous");
  expect(result.judgements[0].rationale).toContain("cited passage, not the claim statement");
});

it("rejects an unsupported broadening and records the claim it rejected", async () => {
  const claim = "Maya led European operations for several years.";
  const { person, factId, dossier, sources } = semanticFixture({
    reference: "Maya led the Berlin office from 2019 to 2021.",
    claim,
    passage: "Maya led European operations for several years, the profile says.",
  });
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId,
                verdict: "missing",
                evidence: claim,
                claimId: "claim-semantic",
                rationale: "The dossier widens the Berlin office to European operations.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0]).toMatchObject({
    verdict: "missing",
    claimId: "claim-semantic",
    evidenceQuote: claim,
    reviewRequired: false,
  });
  expect(result.judgements[0].rationale).not.toContain("Downgraded");
});

it("withholds a rejection that names a claim it never quoted", async () => {
  const { person, factId, dossier, sources } = semanticFixture({
    reference: "Maya led the Berlin office from 2019 to 2021.",
    claim: "Maya led European operations for several years.",
    passage: "Maya led European operations for several years, the profile says.",
  });
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId,
                verdict: "missing",
                evidence: null,
                claimId: "claim-semantic",
                rationale: "The dossier claims something broader.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0].verdict).toBe("ambiguous");
  expect(result.judgements[0].reviewRequired).toBe(true);
  expect(result.judgements[0].rationale).toContain("quotes no dossier text");
});

it("leaves a fact no claim addresses missing without inventing evidence", async () => {
  const { person, factId, dossier, sources } = semanticFixture({
    reference: "Maya led the Berlin office from 2019 to 2021.",
    claim: "Maya spoke at a conference in Lisbon.",
    passage: "Maya spoke at a conference in Lisbon.",
  });
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId,
                verdict: "missing",
                evidence: null,
                claimId: null,
                rationale: "No claim addresses the Berlin office.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0]).toMatchObject({
    verdict: "missing",
    claimId: null,
    evidenceQuote: null,
    reviewRequired: false,
  });
});

it("leaves a genuinely undetermined match for review rather than guessing", async () => {
  const claim = "Maya worked on scheduling around that time.";
  const { person, factId, dossier, sources } = semanticFixture({
    reference: "Maya designed the scheduler in 2021.",
    claim,
    passage: "Maya worked on scheduling around that time, colleagues recall.",
  });
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId,
                verdict: "ambiguous",
                evidence: claim,
                claimId: "claim-semantic",
                rationale: "The wording does not settle whether the scheduler is the same work.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0]).toMatchObject({
    verdict: "ambiguous",
    claimId: "claim-semantic",
    evidenceQuote: claim,
    reviewRequired: true,
  });
  /* The judge's own ambiguity is preserved as itself: no downgrade marker,
     so the ambiguity classifier attributes it to semantic judgement. */
  expect(result.judgements[0].rationale).not.toContain("Downgraded");
});

it.each(["", "   "])(
  "reads a blank claim id (%j) as naming no claim rather than as an unquoted rejection",
  async (blank) => {
    /* RecoverySchema permits a blank id, so the guard has to decide what one
       means. It names no claim: the fact is simply missing, and recording the
       blank would put a claim in the report that nothing resolves. */
    const { person, factId, dossier, sources } = semanticFixture({
      reference: "Maya led the Berlin office from 2019 to 2021.",
      claim: "Maya spoke at a conference in Lisbon.",
      passage: "Maya spoke at a conference in Lisbon.",
    });
    const result = await judgePerson(
      async ({ user }) =>
        user.includes('"references":')
          ? {
              judgements: [
                {
                  factId,
                  verdict: "missing",
                  evidence: null,
                  claimId: blank,
                  rationale: "No claim addresses the Berlin office.",
                },
              ],
            }
          : SUPPORT_OK,
      person,
      dossier,
      sources,
    );
    expect(result.judgements[0]).toMatchObject({
      verdict: "missing",
      claimId: null,
      evidenceQuote: null,
      reviewRequired: false,
    });
    expect(result.judgements[0].rationale).not.toContain("Downgraded");
  },
);
it("runs one corrected recovery attempt when the first omits a reference fact", async () => {
  const { person, dossier, sources } = fixture();
  let recoveryCalls = 0;
  const result = await judgePerson(
    async ({ user }) => {
      const request = JSON.parse(user) as { references?: unknown; rejectedReply?: string };
      if (!request.references) return SUPPORT_OK;
      recoveryCalls += 1;
      if (recoveryCalls === 1) {
        expect(request.rejectedReply).toBeUndefined();
        return { judgements: [] };
      }
      expect(request.rejectedReply).toContain("omitted or repeated");
      return {
        judgements: [
          {
            factId: person.facts[0].id,
            verdict: "missing",
            evidence: null,
            claimId: null,
            rationale: "No dossier claim states it.",
          },
        ],
      };
    },
    person,
    dossier,
    sources,
  );
  expect(recoveryCalls).toBe(2);
  expect(result.complete).toBe(true);
  expect(result.judgements[0]).toMatchObject({ factId: person.facts[0].id, verdict: "missing" });
});

it("runs one corrected support attempt when findings name unknown claims", async () => {
  const { person, dossier, sources } = fixture();
  let supportCalls = 0;
  const result = await judgePerson(
    async ({ user }) => {
      const request = JSON.parse(user) as { references?: unknown; rejectedReply?: string };
      if (request.references)
        return {
          judgements: [
            {
              factId: person.facts[0].id,
              verdict: "missing",
              evidence: null,
              claimId: null,
              rationale: "No dossier claim states it.",
            },
          ],
        };
      supportCalls += 1;
      if (supportCalls === 1) {
        expect(request.rejectedReply).toBeUndefined();
        return {
          ...SUPPORT_OK,
          overclaims: [
            {
              claimId: "claim-does-not-exist",
              citationIndex: null,
              statement: "Maya designed the scheduler.",
              kind: "team-output-as-personal",
              rationale: "Names a claim the dossier does not carry.",
              matchedUnjustifiedId: null,
              uncertain: false,
            },
          ],
        };
      }
      expect(request.rejectedReply).toContain("unknown claims");
      return SUPPORT_OK;
    },
    person,
    dossier,
    sources,
  );
  expect(supportCalls).toBe(2);
  expect(result.complete).toBe(true);
  expect(result.phases.support.status).toBe("completed");
  expect(result.overclaims).toEqual([]);
});

it("keeps a failed support phase when the corrected attempt is also invalid", async () => {
  const { person, dossier, sources } = fixture();
  let supportCalls = 0;
  const result = await judgePerson(
    async ({ user }) => {
      const request = JSON.parse(user) as { references?: unknown };
      if (request.references)
        return {
          judgements: [
            {
              factId: person.facts[0].id,
              verdict: "missing",
              evidence: null,
              claimId: null,
              rationale: "No dossier claim states it.",
            },
          ],
        };
      supportCalls += 1;
      return {
        ...SUPPORT_OK,
        overclaims: [
          {
            claimId: "claim-does-not-exist",
            citationIndex: null,
            statement: "Maya designed the scheduler.",
            kind: "team-output-as-personal",
            rationale: "Names a claim the dossier does not carry.",
            matchedUnjustifiedId: null,
            uncertain: false,
          },
        ],
      };
    },
    person,
    dossier,
    sources,
  );
  expect(supportCalls).toBe(2);
  expect(result.complete).toBe(false);
  expect(result.phases.support.status).toBe("failed");
  expect(result.phases.support.unresolvedFindings).toHaveLength(1);
});

it("keeps the first reply's validation failure when the correction attempt throws", async () => {
  const { person, dossier, sources } = fixture();
  let supportCalls = 0;
  const result = await judgePerson(
    async ({ user }) => {
      const request = JSON.parse(user) as { references?: unknown };
      if (request.references)
        return {
          judgements: [
            {
              factId: person.facts[0].id,
              verdict: "missing",
              evidence: null,
              claimId: null,
              rationale: "No dossier claim states it.",
            },
          ],
        };
      supportCalls += 1;
      if (supportCalls === 1)
        return {
          ...SUPPORT_OK,
          overclaims: [
            {
              claimId: "claim-does-not-exist",
              citationIndex: null,
              statement: "Maya designed the scheduler.",
              kind: "team-output-as-personal",
              rationale: "Names a claim the dossier does not carry.",
              matchedUnjustifiedId: null,
              uncertain: false,
            },
          ],
        };
      throw new Error("Controlled correction timeout");
    },
    person,
    dossier,
    sources,
  );
  expect(supportCalls).toBe(2);
  expect(result.complete).toBe(false);
  expect(result.phases.support.status).toBe("failed");
  expect(result.phases.support.failure).toContain("unknown claims");
  expect(result.phases.support.failure).not.toContain("Controlled correction timeout");
});

it("retries the recovery call once when the first reply fails to parse", async () => {
  const { person, dossier, sources } = fixture();
  let recoveryCalls = 0;
  const result = await judgePerson(
    async ({ user }) => {
      const request = JSON.parse(user) as { references?: unknown };
      if (!request.references) return SUPPORT_OK;
      recoveryCalls += 1;
      if (recoveryCalls === 1) throw new Error("The model boundary returned unusable JSON.");
      return {
        judgements: [
          {
            factId: person.facts[0].id,
            verdict: "missing",
            evidence: null,
            claimId: null,
            rationale: "No dossier claim states it.",
          },
        ],
      };
    },
    person,
    dossier,
    sources,
  );
  expect(recoveryCalls).toBe(2);
  expect(result.complete).toBe(true);
});

it("runs each judge phase exactly once when both replies are usable", async () => {
  const { person, dossier, sources } = fixture();
  let calls = 0;
  const result = await judgePerson(
    async ({ user }) => {
      calls += 1;
      return user.includes('"references":')
        ? {
            judgements: [
              {
                factId: person.facts[0].id,
                verdict: "missing",
                evidence: null,
                claimId: null,
                rationale: "No dossier claim states it.",
              },
            ],
          }
        : SUPPORT_OK;
    },
    person,
    dossier,
    sources,
  );
  expect(calls).toBe(2);
  expect(result.complete).toBe(true);
});
