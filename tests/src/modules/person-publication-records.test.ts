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
  PARTICIPATION_LIMIT,
  isPublicationRecordRead,
  renderPublicationRecord,
} from "../../../apps/server/src/person-profile/publication-records.js";
import type {
  PublicHttpFetch,
  PublicHttpResponse,
} from "../../../apps/server/src/source-adapters/http.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const WORK_DOI = "https://doi.org/10.1126/science.1225829";
const DEPOSIT_DOI = "https://doi.org/10.5281/zenodo.31780";
const ABSTRACT = "Ditching invading DNA is what this abstract is about.";
/** The full text a record links to: named in the record, read under its own rights. */
const FULL_TEXT = "https://example.org/fulltext.pdf";

/** One anonymous response, as the shared transport hands it to a reader. */
const answer = (url: string, status: number, body: string): PublicHttpResponse => ({
  url,
  status,
  contentType: "application/json",
  body,
  etag: null,
  lastModified: null,
  retryAfter: null,
});

function crossrefWork(author: {
  given: string;
  family: string;
  affiliation: string | null;
  orcid: string | null;
}): string {
  return JSON.stringify({
    status: "ok",
    message: {
      DOI: "10.1126/science.1225829",
      type: "journal-article",
      title: ["A Programmable Dual-RNA-Guided DNA Endonuclease"],
      "container-title": ["Science"],
      publisher: "American Association for the Advancement of Science (AAAS)",
      abstract: `<jats:p>${ABSTRACT}</jats:p>`,
      issued: { "date-parts": [[2012, 8, 17]] },
      deposited: { "date-time": "2024-01-10T09:57:24Z" },
      indexed: { "date-time": "2026-09-07T03:25:13Z", version: "build-2803163510" },
      license: [
        {
          URL: "https://creativecommons.org/licenses/by/4.0/",
          "content-version": "vor",
          start: { "date-time": "2012-08-17T00:00:00Z" },
        },
      ],
      author: [
        {
          given: author.given,
          family: author.family,
          sequence: "first",
          ...(author.orcid ? { ORCID: author.orcid } : {}),
          affiliation: author.affiliation ? [{ name: author.affiliation }] : [],
        },
        { given: "Krzysztof", family: "Chylinski", sequence: "additional", affiliation: [] },
      ],
      link: [
        {
          URL: FULL_TEXT,
          "content-type": "application/pdf",
          "content-version": "vor",
        },
      ],
      URL: WORK_DOI,
    },
  });
}

const DEPOSIT_RECORD = JSON.stringify({
  data: {
    id: "10.5281/zenodo.31780",
    attributes: {
      doi: "10.5281/zenodo.31780",
      titles: [{ title: "Persistent identifiers for the Atlas survey" }],
      publisher: "Zenodo",
      publicationYear: 2015,
      types: { resourceTypeGeneral: "Dataset" },
      creators: [
        {
          name: "Chen, Maya",
          givenName: "Maya",
          familyName: "Chen",
          affiliation: ["Atlas Institute"],
          nameIdentifiers: [
            {
              nameIdentifier: "https://orcid.org/0000-0002-1825-0097",
              nameIdentifierScheme: "ORCID",
            },
          ],
        },
      ],
      dates: [{ date: "2015-10-04", dateType: "Issued" }],
      descriptions: [{ description: ABSTRACT, descriptionType: "Abstract" }],
      rightsList: [
        {
          rights: "Creative Commons Attribution 4.0",
          rightsUri: "https://creativecommons.org/licenses/by/4.0",
        },
      ],
      updated: "2020-07-27T13:57:49.000Z",
      metadataVersion: 3,
      url: "https://zenodo.org/record/31780",
      contentUrl: ["https://zenodo.org/record/31780/files/atlas.csv"],
    },
  },
});

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
  /** The url a "work" the model extracts claims for; defaults to none. */
  workUrl?: string | null;
}): Promise<RunResult> {
  const root = mkdtempSync(join(tmpdir(), "publication-records-"));
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
    search: async () => [{ url: options.url, title: "Record", snippet: "" }],
    fetch: options.fetch,
    complete: async (request) => {
      const { document } = JSON.parse(request.user) as { document: { text: string } };
      /* The claim quotes the retained record verbatim, whichever line the
         renderer wrote it on: hardcoding the line would assert the wording
         instead of the behaviour. */
      const quote =
        document.text.split("\n").find((line) => line.includes("Chen")) ??
        document.text.slice(0, 40);
      return {
        fullName: null,
        employer: null,
        sourceClass: "primary-artifact",
        author: null,
        publishedAt: null,
        claims: [
          {
            id: "participation",
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
        ],
        works: options.works
          ? [
              {
                id: "endonuclease",
                title: "A Programmable Dual-RNA-Guided DNA Endonuclease",
                url: options.workUrl ?? null,
                kind: "paper",
                startedAt: null,
                endedAt: null,
                claimIds: ["participation"],
                contribution: {
                  text: "Led the design of the endonuclease",
                  claimIds: ["participation"],
                },
                teamContribution: null,
                authority: [{ role: "decided", claimIds: ["participation"] }],
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

test("a matched publication record is retained with its dates, record version and metadata rights, and its abstract is not", async () => {
  const { outcome, sources, dossier } = await runResearch({
    url: WORK_DOI,
    lookup: { fullName: "Maya Chen", currentEmployer: "Atlas Institute" },
    works: true,
    fetch: async (url) =>
      url.includes("api.crossref.org")
        ? answer(
            url,
            200,
            crossrefWork({
              given: "Maya",
              family: "Chen",
              affiliation: "Atlas Institute",
              orcid: "https://orcid.org/0000-0002-1825-0097",
            }),
          )
        : answer(url, 404, ""),
  });

  const record = sources[0];
  expect(record.acquisition).toBe("record-reader");
  expect(record.evidenceFamily).toBe("published-work");
  expect(record.upstreamIndex).toBe("crossref.org");
  expect(isPublicationRecordRead(record)).toBe(true);

  /* Dates and the upstream's own version of the record, kept because a
     record read next week is a different version of the same evidence. */
  expect(record.publishedAt).toBe("2012-08-17");
  expect(record.sourceVersion).toContain("build-2803163510");
  expect(record.text).toContain("2024-01-10T09:57:24Z");

  /* Metadata permission, the declared licence and what each covers stay
     apart: the abstract is not retained under the metadata permission. */
  expect(record.rights?.metadata.basis).toBe("crossref-rest-metadata");
  expect(record.rights?.declared).toContainEqual(
    expect.objectContaining({
      material: "full-text",
      url: "https://creativecommons.org/licenses/by/4.0/",
      appliesFrom: "2012-08-17T00:00:00Z",
    }),
  );
  expect(record.rights?.materials).toContainEqual(
    expect.objectContaining({ material: "abstract", disposition: "withheld-no-rights-basis" }),
  );
  expect(record.rights?.materials).toContainEqual(
    expect.objectContaining({ material: "full-text", disposition: "not-retrieved" }),
  );
  expect(record.text).not.toContain(ABSTRACT);
  /* The linked full text is recorded provenance — named in the retained text
     and in `rights.materials` — but it is never an outbound URL.
     `outboundUrls` is exactly what PersonResearch turns into an
     automatically-read lead (review finding on issue #249, PR #293): the full
     text must stay unread under this record's metadata permission until
     something reads it under its own rights. */
  expect(record.text).toContain(FULL_TEXT);
  expect(record.outboundUrls ?? []).not.toContain(FULL_TEXT);

  /* Participation is recorded as participation. The record names who took
     part; it does not state what any of them personally did. */
  expect(record.text).toContain("Maya Chen");
  expect(record.text).toContain(PARTICIPATION_LIMIT);
  expect(dossier?.claims).toHaveLength(1);
  expect(dossier?.works[0]?.contribution).toBeNull();
  expect(dossier?.works[0]?.authority).toEqual([]);
  expect(outcome.conclusion).toBe("completed");
});

test("a linked full text is never turned into a lead the research loop auto-fetches, even when a work claims it", async () => {
  const fetchedUrls: string[] = [];
  const { outcome, sources } = await runResearch({
    url: WORK_DOI,
    lookup: { fullName: "Maya Chen", currentEmployer: "Atlas Institute" },
    works: true,
    /* The model attributes contribution to a "work" addressed at exactly the
       record's own linked full text — the shape PersonResearch turns into a
       URL lead when it appears among a read's outboundUrls, and the shape
       `deriveLeads` re-enqueues from a published work every later round
       (review finding on issue #249, PR #293). */
    workUrl: FULL_TEXT,
    fetch: async (url) => {
      fetchedUrls.push(url);
      return url.includes("api.crossref.org")
        ? answer(
            url,
            200,
            crossrefWork({
              given: "Maya",
              family: "Chen",
              affiliation: "Atlas Institute",
              orcid: "https://orcid.org/0000-0002-1825-0097",
            }),
          )
        : answer(url, 404, "");
    },
  });

  expect(sources[0]?.outboundUrls ?? []).not.toContain(FULL_TEXT);
  expect(outcome.leads.some((lead) => lead.target === FULL_TEXT)).toBe(false);
  expect(fetchedUrls).not.toContain(FULL_TEXT);
});

test("a deposit record is read from the deposit index when the work index does not hold the DOI", async () => {
  const { outcome, sources } = await runResearch({
    url: DEPOSIT_DOI,
    lookup: { fullName: "Maya Chen", currentEmployer: "Atlas Institute" },
    fetch: async (url) =>
      url.includes("api.datacite.org")
        ? answer(url, 200, DEPOSIT_RECORD)
        : answer(url, 404, JSON.stringify({ status: "error" })),
  });

  const record = sources[0];
  expect(record.upstreamIndex).toBe("datacite.org");
  expect(record.publishedAt).toBe("2015-10-04");
  expect(record.sourceVersion).toContain("2020-07-27T13:57:49.000Z");
  expect(record.rights?.metadata.basis).toBe("datacite-data-file-cc0");
  expect(record.rights?.declared).toContainEqual(
    expect.objectContaining({ material: "deposited-resource" }),
  );
  /* The deposit declares a licence over the resource itself, so the abstract
     is retained under that licence rather than under the metadata waiver. */
  expect(record.rights?.materials).toContainEqual(
    expect.objectContaining({
      material: "abstract",
      disposition: "retained-under-declared-licence",
      licence: "Creative Commons Attribution 4.0",
    }),
  );
  expect(record.text).toContain(ABSTRACT);
  expect(record.text).toContain("0000-0002-1825-0097");

  /* The work index answering "not mine" is a recovery, not a dead end. */
  const stepped = outcome.attempts.filter(
    (attempt) => attempt.targetKind === "record" && attempt.recovery === "alternative-route",
  );
  expect(stepped.map((attempt) => attempt.observed?.status)).toEqual([404]);
  expect(stepped[0]?.stage).toBe("access");
});

test("a same-name record with no shared identity signal is not attributed to the Profile", async () => {
  const { outcome, sources, dossier } = await runResearch({
    url: WORK_DOI,
    lookup: { fullName: "Maya Chen", currentEmployer: "Atlas Institute" },
    fetch: async (url) =>
      url.includes("api.crossref.org")
        ? answer(
            url,
            200,
            crossrefWork({
              given: "Maya",
              family: "Chen",
              affiliation: "Borealis College",
              orcid: null,
            }),
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

test("a same-name record on a Profile with no other signal stays ambiguous rather than becoming fact", async () => {
  const { outcome, dossier } = await runResearch({
    url: WORK_DOI,
    lookup: { fullName: "Maya Chen" },
    fetch: async (url) =>
      url.includes("api.crossref.org")
        ? answer(
            url,
            200,
            crossrefWork({ given: "Maya", family: "Chen", affiliation: null, orcid: null }),
          )
        : answer(url, 404, ""),
  });

  expect(dossier?.claims.map((claim) => claim.matchConfidence)).toEqual(["medium"]);
  expect(outcome.attempts.map((attempt) => attempt.code)).toContain("ambiguous-attribution");
});

test("a record route that answers nothing is recorded as an unavailable route, not an absent person", async () => {
  const { outcome, sources } = await runResearch({
    url: WORK_DOI,
    lookup: { fullName: "Maya Chen", currentEmployer: "Atlas Institute" },
    fetch: async (url) => answer(url, 503, ""),
  });

  expect(sources).toEqual([]);
  const failures = outcome.attempts.filter(
    (attempt) => attempt.outcome === "failed" && attempt.targetKind === "record",
  );
  expect(failures.map((attempt) => attempt.code)).toContain("http-error");
  /* Shape only: the record route's diagnostic keeps the status and the URL it
     saw, and nothing of what came back in the body. */
  for (const attempt of failures)
    expect(Object.keys(attempt.observed ?? {}).sort()).toEqual(["finalUrl", "status"]);
  expect(
    outcome.leads.filter((lead) => lead.kind === "url").map((lead) => lead.disposition),
  ).toEqual(["inaccessible"]);
});

test("an inverted abstract index is not reconstructed into retained text", () => {
  const rendering = renderPublicationRecord("openalex.org", {
    id: "https://openalex.org/W2045435533",
    doi: "https://doi.org/10.1126/science.1225829",
    title: "A Programmable Dual-RNA-Guided DNA Endonuclease",
    type: "article",
    publication_date: "2012-06-29",
    updated_date: "2026-09-06T09:10:53.072986",
    abstract_inverted_index: { Ditching: [0], invading: [1], DNA: [2] },
    primary_location: {
      landing_page_url: "https://doi.org/10.1126/science.1225829",
      pdf_url: FULL_TEXT,
      license: "cc-by",
      source: { display_name: "Science" },
    },
    authorships: [
      {
        author_position: "first",
        author: { display_name: "Maya Chen", orcid: "https://orcid.org/0000-0002-1825-0097" },
        institutions: [{ display_name: "Atlas Institute" }],
      },
    ],
  })!;

  expect(rendering.sourceVersion).toContain("2026-09-06T09:10:53.072986");
  expect(rendering.publishedAt).toBe("2012-06-29");
  expect(rendering.rights.metadata.basis).toBe("openalex-cc0");
  expect(rendering.rights.materials).toContainEqual(
    expect.objectContaining({ material: "abstract", disposition: "withheld-no-rights-basis" }),
  );
  /* The licence is an OpenAlex identifier with no licence document behind it;
     the work's landing page is not evidence of its terms. */
  expect(rendering.rights.declared).toEqual([
    expect.objectContaining({ material: "full-text", statement: "cc-by", url: null }),
  ]);
  expect(rendering.text).toContain("https://doi.org/10.1126/science.1225829");
  expect(rendering.outboundUrls).toEqual([]);
  expect(rendering.text).not.toContain("Ditching");
  expect(rendering.text).toContain("Maya Chen");
  expect(rendering.text).toContain(PARTICIPATION_LIMIT);
});

test("a body that is not a record of the expected shape renders nothing rather than a guess", () => {
  expect(renderPublicationRecord("crossref.org", { message: "unavailable" })).toBeNull();
  expect(
    isPublicationRecordRead(
      fromPartial({ acquisition: "html-reader", upstreamIndex: "crossref.org" }),
    ),
  ).toBe(false);
  expect(
    isPublicationRecordRead(
      fromPartial({ acquisition: "record-reader", upstreamIndex: "loc.gov" }),
    ),
  ).toBe(false);
});
