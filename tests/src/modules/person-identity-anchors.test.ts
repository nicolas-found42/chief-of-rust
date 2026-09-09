import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import type {
  PersonProfileCreateInput,
  PersonResearchOperationOutcome,
  PersonSourceDocument,
} from "@chief-of-staff-demo/shared";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import {
  PersonResearch,
  researchAllowance,
} from "../../../apps/server/src/person-profile/research.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";
import {
  REGISTRY_MEMBERSHIP_LIMIT,
  isIdentityAnchorRead,
  renderIdentityAnchor,
} from "../../../apps/server/src/person-profile/identity-anchors.js";
import type {
  PublicHttpFetch,
  PublicHttpResponse,
} from "../../../apps/server/src/source-adapters/http.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ORCID_ID = "0000-0002-1825-0097";
const ORCID_URL = `https://orcid.org/${ORCID_ID}`;
const WORK_DOI_URL = "https://doi.org/10.5555/12345680";
const WORK_TITLE = "A Methodology for the Emulation of Architecture";

const answer = (url: string, status: number, body: string): PublicHttpResponse => ({
  url,
  status,
  contentType: "application/json",
  body,
  etag: null,
  lastModified: null,
  retryAfter: null,
});

function orcidRecord(options: {
  given: string;
  family: string;
  employer: string | null;
  lastModifiedMs?: number;
}): string {
  return JSON.stringify({
    "orcid-identifier": { uri: ORCID_URL, path: ORCID_ID, host: "orcid.org" },
    history: {
      "last-modified-date": { value: options.lastModifiedMs ?? 1788275402435 },
    },
    person: {
      name: {
        "given-names": { value: options.given },
        "family-name": { value: options.family },
      },
      "other-names": {
        "other-name": [{ content: `${options.given[0]}. ${options.family}` }],
      },
      "external-identifiers": {
        "external-identifier": [
          {
            "external-id-type": "Scopus Author ID",
            "external-id-value": "7007156898",
            "external-id-url": {
              value: "https://www.scopus.com/authid/detail.url?authorId=7007156898",
            },
          },
        ],
      },
    },
    "activities-summary": {
      employments: options.employer
        ? {
            "affiliation-group": [
              {
                summaries: [
                  {
                    "employment-summary": {
                      organization: { name: options.employer },
                      "role-title": "Professor",
                      "department-name": "Psychoceramics",
                      "start-date": { year: { value: "1930" } },
                      "end-date": null,
                    },
                  },
                ],
              },
            ],
          }
        : { "affiliation-group": [] },
      educations: { "affiliation-group": [] },
      works: {
        group: [
          {
            "work-summary": [
              {
                title: { title: { value: WORK_TITLE } },
                type: "journal-article",
                "external-ids": {
                  "external-id": [
                    { "external-id-type": "doi", "external-id-value": "10.5555/12345680" },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
  });
}

interface RunResult {
  outcome: PersonResearchOperationOutcome;
  sources: PersonSourceDocument[];
  dossier: ReturnType<PersonDossierStore["get"]>;
}

/**
 * One operation over one record URL, with the production reader in the loop:
 * only the transport and the model boundary are replaced.
 */
async function runResearch(options: {
  url: string;
  fetch: PublicHttpFetch;
  lookup: PersonProfileCreateInput;
  works?: boolean;
}): Promise<RunResult> {
  const root = mkdtempSync(join(tmpdir(), "identity-anchors-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const profile = people.create(options.lookup);
  const dossiers = new PersonDossierStore(root);
  const research = new PersonResearch({
    people,
    dossiers,
    search: async () => [{ url: options.url, title: "Registry record", snippet: "" }],
    fetch: options.fetch,
    complete: async (request) => {
      const { document } = JSON.parse(request.user) as { document: { text: string } };
      const quote =
        document.text.split("\n").find((line) => line.includes("Carberry")) ??
        document.text.slice(0, 40);
      return {
        fullName: null,
        employer: null,
        sourceClass: "primary-artifact",
        author: null,
        publishedAt: null,
        claims: [
          {
            id: "identity",
            section: "overview",
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
        ],
        works: options.works
          ? [
              {
                id: "the-work",
                title: WORK_TITLE,
                url: null,
                kind: "paper",
                startedAt: null,
                endedAt: null,
                claimIds: ["identity"],
                contribution: {
                  text: "Personally designed the emulation methodology.",
                  claimIds: ["identity"],
                },
                teamContribution: null,
                authority: [{ role: "decided", claimIds: ["identity"] }],
                scale: [],
                constraints: [],
                outcomes: [],
              },
            ]
          : [],
        expertise: [],
        connections: [],
        sections: [],
      };
    },
  });
  const result = await research.run(
    profile,
    researchAllowance({ maxModelCalls: 3, maxMilliseconds: 20_000, quietRounds: 1 }),
  );
  const dossier = dossiers.get(profile.id);
  const sources = (dossier?.sourceIds ?? []).flatMap((id) => {
    const source = dossiers.source(profile.id, id);
    return source ? [source] : [];
  });
  return { outcome: result.operation, sources, dossier };
}

test("a confirmed identity anchor is retained with its record version, and registry membership does not attribute the linked work", async () => {
  const { outcome, sources, dossier } = await runResearch({
    url: ORCID_URL,
    lookup: { fullName: "Josiah Carberry", profileUrls: [ORCID_URL] },
    works: true,
    fetch: async (url) =>
      url.includes("pub.orcid.org")
        ? answer(url, 200, orcidRecord({ given: "Josiah", family: "Carberry", employer: null }))
        : answer(url, 404, ""),
  });

  const record = sources[0];
  expect(record.acquisition).toBe("record-reader");
  expect(record.evidenceFamily).toBe("identity-affiliation");
  expect(record.upstreamIndex).toBe("orcid.org");
  expect(isIdentityAnchorRead(fromPartial(record))).toBe(true);

  /* The record's own version is retained, so a claim can be traced to which
     version of the registry entry it rests on. */
  expect(record.sourceVersion).toBeTruthy();
  expect(record.rights?.metadata.basis).toBe("orcid-public-api");

  expect(record.text).toContain(ORCID_ID);
  expect(record.text).toContain("Josiah Carberry");
  expect(record.text).toContain(REGISTRY_MEMBERSHIP_LIMIT);
  /* The record lists a linked work. Registry membership establishes the
     identity, not the work; the title never becomes retained fact text. */
  expect(record.text).not.toContain(WORK_TITLE);
  expect(record.outboundUrls).toContain(WORK_DOI_URL);

  /* The identity anchor matched via the Profile's own confirmed ORCID URL. */
  expect(dossier?.claims.map((claim) => claim.matchConfidence)).toEqual(["high"]);
  /* A Work Record grounded only in this registry record keeps no personal
     contribution or decision authority — participation is not accomplishment. */
  expect(dossier?.works[0]?.contribution).toBeNull();
  expect(dossier?.works[0]?.authority).toEqual([]);
  expect(outcome.conclusion).toBe("completed");
});

test("a same-name registry record on a Profile with no other signal stays ambiguous rather than becoming fact", async () => {
  const { outcome, dossier } = await runResearch({
    url: ORCID_URL,
    lookup: { fullName: "Josiah Carberry" },
    fetch: async (url) =>
      url.includes("pub.orcid.org")
        ? answer(url, 200, orcidRecord({ given: "Josiah", family: "Carberry", employer: null }))
        : answer(url, 404, ""),
  });

  expect(dossier?.claims.map((claim) => claim.matchConfidence)).toEqual(["medium"]);
  expect(outcome.attempts.map((attempt) => attempt.code)).toContain("ambiguous-attribution");
});

test("a same-name registry record whose affiliation conflicts is not attributed to the Profile", async () => {
  const { outcome, sources, dossier } = await runResearch({
    url: ORCID_URL,
    lookup: { fullName: "Josiah Carberry", currentEmployer: "Atlas Institute" },
    fetch: async (url) =>
      url.includes("pub.orcid.org")
        ? answer(
            url,
            200,
            orcidRecord({ given: "Josiah", family: "Carberry", employer: "Wesleyan University" }),
          )
        : answer(url, 404, ""),
  });

  expect(dossier?.claims ?? []).toEqual([]);
  expect(sources).toEqual([]);
  expect(outcome.attempts.map((attempt) => attempt.code)).toContain("identity-unmatched");
  expect(
    outcome.leads.filter((lead) => lead.kind === "url").map((lead) => lead.disposition),
  ).toEqual(["rejected"]);
});

test("a body that is not a record of the expected shape renders nothing rather than a guess", () => {
  expect(renderIdentityAnchor("orcid.org", { error: "not found" })).toBeNull();
  expect(
    isIdentityAnchorRead(fromPartial({ acquisition: "html-reader", upstreamIndex: "orcid.org" })),
  ).toBe(false);
  expect(
    isIdentityAnchorRead(fromPartial({ acquisition: "record-reader", upstreamIndex: "loc.gov" })),
  ).toBe(false);
});
