import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import {
  BenchmarkReportSchema,
  type PersonDossier,
  type PersonSourceDocument,
} from "@chief-of-staff-demo/shared";
import { renderReport } from "../../../apps/server/src/person-benchmark/report.js";
import { sourceContributions } from "../../../apps/server/src/person-benchmark/source-contributions.js";

const ORCID_URL = "https://orcid.org/0000-0002-1825-0097";

function fixtureReport() {
  return BenchmarkReportSchema.parse(
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
}

it("traces a cited identity anchor to its retained record version in the source-contribution record", () => {
  const quote = "ORCID iD: 0000-0002-1825-0097";
  const anchor: PersonSourceDocument = fromPartial({
    id: "anchor-source",
    url: ORCID_URL,
    hash: "anchor-hash",
    text: `Registry identity\n${quote}\nName: Josiah Carberry`,
    evidenceFamily: "identity-affiliation",
    upstreamIndex: "orcid.org",
    sourceVersion: "orcid record last modified 2026-09-01T15:10:02.435Z",
    visibility: "public",
  });
  const dossier: PersonDossier = fromPartial({
    claims: [
      {
        id: "identity",
        status: "supported",
        citations: [{ sourceId: "anchor-source", quote }],
      },
    ],
  });

  const contributions = sourceContributions(dossier, [anchor], [], new Set());
  const identity = contributions.find((entry) => entry.family === "identity-affiliation")!;
  expect(identity.sources).toEqual([
    expect.objectContaining({
      url: ORCID_URL,
      upstreamIndex: "orcid.org",
      sourceVersion: "orcid record last modified 2026-09-01T15:10:02.435Z",
      cited: true,
    }),
  ]);
});

it("renders a retained identity anchor per person in the evaluation report, traceable to its source version", () => {
  const report = fixtureReport();
  const person = report.people[0];
  person.sourceContributions = [
    {
      family: "identity-affiliation",
      sources: [
        {
          id: "anchor-source",
          url: ORCID_URL,
          hash: "anchor-hash",
          upstreamIndex: "orcid.org",
          cited: true,
          sourceVersion: "orcid record last modified 2026-09-01T15:10:02.435Z",
        },
      ],
      claimIds: ["identity"],
      recoveredFactIds: [],
      exclusiveRecoveredFactIds: [],
    },
  ];

  const rendered = renderReport(report, []);
  expect(rendered).toContain("## Identity anchors");
  const identityLine = rendered
    .split("\n")
    .find((line) => line.includes(person.slug) && line.includes(ORCID_URL));
  expect(identityLine).toContain("orcid.org");
  expect(identityLine).toContain("orcid record last modified 2026-09-01T15:10:02.435Z");
  expect(identityLine).toContain("yes");
});

it("says plainly when a report retains no identity or affiliation registry record", () => {
  const report = fixtureReport();
  for (const person of report.people) delete person.sourceContributions;
  const rendered = renderReport(report, []);
  expect(rendered).toContain("no identity or affiliation registry record retained");
});

/* A version the route stated, a route asked that states none, and a report
   written before anyone asked are three different facts about the evidence.
   Rendering the last two alike would put a claim about the route into a report
   that never measured it (#252). */
it("keeps a stated, an absent and an unmeasured source version apart in the report", () => {
  const report = fixtureReport();
  const person = report.people[0];
  const anchor = (url: string, extra: Record<string, unknown>) => ({
    id: url,
    url,
    hash: `${url}-hash`,
    upstreamIndex: "orcid.org",
    cited: true,
    ...extra,
  });
  person.sourceContributions = [
    fromPartial({
      family: "identity-affiliation",
      sources: [
        anchor("https://orcid.org/0000-0002-1111-1111", { sourceVersion: "modified 2026-09-01" }),
        anchor("https://orcid.org/0000-0002-2222-2222", { sourceVersion: null }),
        /* No `sourceVersion` key at all: a report from before the field. */
        anchor("https://orcid.org/0000-0002-3333-3333", {}),
      ],
      claimIds: ["identity"],
      recoveredFactIds: [],
      exclusiveRecoveredFactIds: [],
    }),
  ];

  const lineFor = (needle: string): string => {
    const line = renderReport(report, [])
      .split("\n")
      .find((candidate) => candidate.includes(needle));
    if (line === undefined) throw new Error(`no report line for ${needle}`);
    return line;
  };

  expect(lineFor("0000-0002-1111-1111")).toContain("modified 2026-09-01");
  expect(lineFor("0000-0002-2222-2222")).toContain("none stated");
  expect(lineFor("0000-0002-3333-3333")).toContain("unmeasured");
  /* And the two are not each other. */
  expect(lineFor("0000-0002-2222-2222")).not.toContain("unmeasured");
  expect(lineFor("0000-0002-3333-3333")).not.toContain("none stated");
});

/* A retained document holds a version or holds none; there is no third state
   there. So a freshly written report says "states none" with null, and keeps
   absent to mean the report itself predates the field. */
it("records a document with no version as an explicit null in a new report", () => {
  const document: PersonSourceDocument = fromPartial({
    id: "no-version",
    url: "https://orcid.org/0000-0002-4444-4444",
    hash: "no-version-hash",
    text: "Registry identity",
    evidenceFamily: "identity-affiliation",
    upstreamIndex: "orcid.org",
    visibility: "public",
  });

  const contributions = sourceContributions(fromPartial({ claims: [] }), [document], [], new Set());
  const identity = contributions.find((entry) => entry.family === "identity-affiliation");
  if (!identity) throw new Error("no identity-affiliation contribution");
  /* Present and null — "asked, states none" — rather than absent, which a
     reader would take to mean this report predates version measurement. */
  expect(Object.hasOwn(identity.sources[0], "sourceVersion")).toBe(true);
  expect(identity.sources[0].sourceVersion).toBeNull();
});
