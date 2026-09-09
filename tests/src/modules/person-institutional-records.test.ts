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
import { ResearchAttemptRecorder } from "../../../apps/server/src/person-profile/research-diagnostics.js";
import {
  readPersonSource,
  type ReaderPorts,
} from "../../../apps/server/src/person-profile/research-readers.js";
import {
  MATCH_LIMIT,
  isInstitutionalRecordRead,
  renderInstitutionalRecord,
} from "../../../apps/server/src/person-profile/institutional-records.js";
import type {
  PublicHttpFetch,
  PublicHttpResponse,
} from "../../../apps/server/src/source-adapters/http.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TRIAL_URL = "https://clinicaltrials.gov/study/NCT00949286";
const NPI_URL = "https://npiregistry.cms.hhs.gov/provider-view/1316660632";

/** One anonymous response, as the shared transport hands it to a reader. */
const answer = (
  url: string,
  status: number,
  body: string,
  contentType = "application/json",
): PublicHttpResponse => ({
  url,
  status,
  contentType,
  body,
  etag: null,
  lastModified: null,
  retryAfter: null,
});

/** A real ClinicalTrials.gov v2 study shape (NCT00949286), trimmed to the fields the renderer reads. */
function clinicalTrialsRecord(official: { name: string; affiliation: string | null }): string {
  return JSON.stringify({
    protocolSection: {
      identificationModule: {
        nctId: "NCT00949286",
        briefTitle: "Action in Diabetes and Vascular Disease Observational Study",
        officialTitle:
          "Action in Diabetes and Vascular Disease Preterax and Diamicron MR Controlled Evaluation Post Trial Observational Study",
        organization: { fullName: "The George Institute", class: "OTHER" },
      },
      statusModule: {
        overallStatus: "COMPLETED",
        startDateStruct: { date: "2010-01" },
        completionDateStruct: { date: "2014-02", type: "ACTUAL" },
        studyFirstPostDateStruct: { date: "2009-07-30", type: "ESTIMATED" },
        lastUpdatePostDateStruct: { date: "2014-05-19", type: "ESTIMATED" },
      },
      sponsorCollaboratorsModule: {
        leadSponsor: { name: "The George Institute", class: "OTHER" },
      },
      contactsLocationsModule: {
        overallOfficials: [
          {
            name: official.name,
            ...(official.affiliation ? { affiliation: official.affiliation } : {}),
            role: "PRINCIPAL_INVESTIGATOR",
          },
        ],
      },
    },
    documentSection: {
      largeDocumentModule: {
        largeDocs: [{ label: "Study Protocol", filename: "Prot_001.pdf" }],
      },
    },
  });
}

/** A real NPPES NPI Registry shape (an individual provider, NPI-1). */
const NPPES_INDIVIDUAL = JSON.stringify({
  result_count: 1,
  results: [
    {
      number: "1316660632",
      enumeration_type: "NPI-1",
      basic: {
        first_name: "MAYA",
        last_name: "CHEN",
        credential: "MD",
        status: "A",
        enumeration_date: "2022-09-21",
        certification_date: "2022-09-21",
        last_updated: "2022-09-21",
      },
      taxonomies: [
        {
          code: "207R00000X",
          desc: "Internal Medicine",
          license: "MD48213",
          primary: true,
          state: "CA",
        },
      ],
      other_names: [],
    },
  ],
});

/** A real NPPES shape for an organization (NPI-2): the named person is its authorized official, not a clinician. */
const NPPES_ORGANIZATION = JSON.stringify({
  result_count: 1,
  results: [
    {
      number: "1285692145",
      enumeration_type: "NPI-2",
      basic: {
        organization_name: "Riverside Health System",
        authorized_official_first_name: "Maya",
        authorized_official_last_name: "Chen",
        authorized_official_title_or_position: "President",
        status: "A",
        enumeration_date: "2006-05-02",
        last_updated: "2025-01-16",
      },
      taxonomies: [
        {
          code: "282N00000X",
          desc: "General Acute Care Hospital",
          license: null,
          primary: true,
          state: "CA",
        },
      ],
      other_names: [],
    },
  ],
});

/** The Angular shell NPPES's own documentation routes serve to an anonymous GET, observed live 2026-09-07. */
const APP_SHELL_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>NPPES NPI Registry</title>' +
  '<base href="/"></head><body><app-root></app-root><script src="main-V42RFARJ.js" type="module"></script></body></html>';

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
  const root = mkdtempSync(join(tmpdir(), "institutional-records-"));
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
            id: "match",
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
                id: "trial",
                title: "Action in Diabetes and Vascular Disease Observational Study",
                url: options.workUrl ?? null,
                kind: "research",
                startedAt: null,
                endedAt: null,
                claimIds: ["match"],
                contribution: { text: "Designed and ran the trial", claimIds: ["match"] },
                teamContribution: null,
                authority: [{ role: "decided", claimIds: ["match"] }],
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

test("a matched ClinicalTrials.gov record is retained with its dates, version, rights and a linked document recorded as provenance", async () => {
  const { outcome, sources, dossier } = await runResearch({
    url: TRIAL_URL,
    lookup: { fullName: "Maya Chen", currentEmployer: "Atlas Institute" },
    works: true,
    fetch: async (url) =>
      url.includes("clinicaltrials.gov/api/v2/studies")
        ? answer(
            url,
            200,
            clinicalTrialsRecord({ name: "Maya Chen", affiliation: "Atlas Institute" }),
          )
        : answer(url, 404, ""),
  });

  const record = sources[0];
  expect(record.acquisition).toBe("record-reader");
  expect(record.evidenceFamily).toBe("professional-records");
  expect(record.upstreamIndex).toBe("clinicaltrials.gov");
  expect(isInstitutionalRecordRead(record)).toBe(true);

  /* Dates and the registry's own version marker for this record. */
  expect(record.publishedAt).toBe("2009-07-30");
  expect(record.sourceVersion).toContain("2014-05-19");
  expect(record.text).toContain("NCT00949286");

  expect(record.rights?.metadata.basis).toBe("clinicaltrials-public-api");
  expect(record.rights?.materials).toContainEqual(
    expect.objectContaining({ material: "linked-document", disposition: "not-retrieved" }),
  );
  /* The protocol PDF is recorded provenance, addressed the way the registry
     itself serves provided documents and named in the retained text — but it
     is never an outbound URL. `outboundUrls` is exactly what PersonResearch
     turns into an automatically-read lead (Sourcery review, PR #295): a
     linked document must stay unread under this record's metadata-only
     permission until something reads it under its own rights. */
  expect(record.text).toContain(
    "https://clinicaltrials.gov/ProvidedDocs/86/NCT00949286/Prot_001.pdf",
  );
  expect(record.outboundUrls ?? []).not.toContain(
    "https://clinicaltrials.gov/ProvidedDocs/86/NCT00949286/Prot_001.pdf",
  );

  /* A registry match is not a demonstrated capability: the extraction path
     drops the model's contribution and authority guesses for this source. */
  expect(record.text).toContain("Maya Chen");
  expect(record.text).toContain(MATCH_LIMIT);
  expect(dossier?.claims).toHaveLength(1);
  expect(dossier?.works[0]?.contribution).toBeNull();
  expect(dossier?.works[0]?.authority).toEqual([]);
  expect(outcome.conclusion).toBe("completed");
});

test("a linked trial document is never turned into a lead the research loop auto-fetches, even when a work claims it", async () => {
  const protocolUrl = "https://clinicaltrials.gov/ProvidedDocs/86/NCT00949286/Prot_001.pdf";
  const fetchedUrls: string[] = [];
  const { outcome, sources } = await runResearch({
    url: TRIAL_URL,
    lookup: { fullName: "Maya Chen", currentEmployer: "Atlas Institute" },
    works: true,
    /* The model attributes contribution to a "work" addressed at exactly the
       registry's own linked-document URL — the shape PersonResearch turns
       into a URL lead at #250's review (Sourcery, PR #295) when it appears
       among a read's outboundUrls. */
    workUrl: protocolUrl,
    fetch: async (url) => {
      fetchedUrls.push(url);
      return url.includes("clinicaltrials.gov/api/v2/studies")
        ? answer(
            url,
            200,
            clinicalTrialsRecord({ name: "Maya Chen", affiliation: "Atlas Institute" }),
          )
        : answer(url, 404, "");
    },
  });

  expect(sources[0]?.outboundUrls ?? []).not.toContain(protocolUrl);
  expect(outcome.leads.some((lead) => lead.target === protocolUrl)).toBe(false);
  expect(fetchedUrls).not.toContain(protocolUrl);
});

test("a matched NPPES individual record carries the NPI and taxonomy, but a coincidental taxonomy match does not confirm identity", async () => {
  /* The Profile's employer here is deliberately set to the record's taxonomy
     description. An NPPES individual (NPI-1) registration states a
     provider's specialty and practice address, never an employer, so this
     is not a real corroborating signal — it is a same-name collision with
     nothing to corroborate against.
     Previously this test asserted a full ("high" confidence) match, on the
     theory that the taxonomy description corroborated the Profile's
     employer. That was wrong: it made "Internal Medicine" (a specialty)
     stand in for an employer, so any Profile whose employer happened to
     equal a medical specialty would be confidently — and wrongly —
     attributed to any same-name NPI record bearing that specialty
     (review finding, PR #295). With no genuine affiliation evidence either
     way, identity stays unresolved: the record is still retained, but only
     at reduced ("ambiguous-attribution") confidence. */
  const { sources, dossier, outcome } = await runResearch({
    url: NPI_URL,
    lookup: { fullName: "Maya Chen", currentEmployer: "Internal Medicine" },
    works: true,
    fetch: async (url) =>
      url.includes("npiregistry.cms.hhs.gov")
        ? answer(url, 200, NPPES_INDIVIDUAL)
        : answer(url, 404, ""),
  });

  const record = sources[0];
  expect(record.upstreamIndex).toBe("npiregistry.cms.hhs.gov");
  expect(record.rights?.metadata.basis).toBe("nppes-public-registry");
  expect(record.text).toContain("NPI 1316660632");
  expect(record.text).toContain("Internal Medicine");
  expect(record.text).toContain(MATCH_LIMIT);
  expect(dossier?.works[0]?.contribution).toBeNull();
  expect(dossier?.works[0]?.authority).toEqual([]);
  expect(dossier?.claims.map((claim) => claim.matchConfidence)).toEqual(["medium"]);
  expect(outcome.attempts.map((attempt) => attempt.code)).toContain("ambiguous-attribution");
});

test("an organizational NPPES record whose organization name equals the Profile's employer does not confirm identity", async () => {
  /* The named individual on an NPI-2 registration is the organization's
     authorized official — a registration contact, not an employee whose
     employer the record states. The organization's own name is a
     record-level fact, never the official's affiliation, so a Profile whose
     employer happens to equal the organization's name is a same-name
     collision, not a corroborated match: the record is retained, but only
     at reduced ("ambiguous-attribution") confidence, exactly as the NPI-1
     case above. */
  const { sources, dossier, outcome } = await runResearch({
    url: NPI_URL,
    lookup: { fullName: "Maya Chen", currentEmployer: "Riverside Health System" },
    fetch: async (url) =>
      url.includes("npiregistry.cms.hhs.gov")
        ? answer(url, 200, NPPES_ORGANIZATION)
        : answer(url, 404, ""),
  });

  const record = sources[0];
  expect(record).toBeDefined();
  expect(record.text).toContain("Riverside Health System");
  expect(dossier?.claims.map((claim) => claim.matchConfidence)).toEqual(["medium"]);
  expect(outcome.attempts.map((attempt) => attempt.code)).toContain("ambiguous-attribution");
});

test("an organizational NPPES record names its authorized official, not a clinician", () => {
  const rendering = renderInstitutionalRecord(
    "npiregistry.cms.hhs.gov",
    JSON.parse(NPPES_ORGANIZATION),
  );
  expect(rendering).not.toBeNull();
  expect(rendering!.text).toContain("Maya Chen");
  expect(rendering!.text).toContain("Authorized official");
  expect(rendering!.text).toContain("Riverside Health System");
  expect(rendering!.text).toContain(MATCH_LIMIT);
  /* The organization's scale never becomes the named official's title in the
     rendered role line: the record calls her an authorized official, not a
     physician or hospital administrator with clinical authority. */
  expect(rendering!.text).not.toMatch(/Maya Chen.*(physician|clinician|doctor)/i);
});

test("a same-name record with no shared identity signal is not attributed to the Profile", async () => {
  const { outcome, sources, dossier } = await runResearch({
    url: TRIAL_URL,
    lookup: { fullName: "Maya Chen", currentEmployer: "Atlas Institute" },
    fetch: async (url) =>
      url.includes("clinicaltrials.gov/api/v2/studies")
        ? answer(
            url,
            200,
            clinicalTrialsRecord({ name: "Maya Chen", affiliation: "Borealis College" }),
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

test("a same-name record whose sponsor matches the Profile's employer is not attributed when the named individual's own affiliation conflicts", async () => {
  /* The trial's lead sponsor and responsible organization are both "The
     George Institute" in `clinicalTrialsRecord`'s fixture — a record-level
     field, never the named investigator's own affiliation. A Profile whose
     employer happens to equal that sponsor must not be corroborated by it:
     the named "Maya Chen" here is affiliated with a conflicting institution,
     so this is a namesake, not a match (#250 review, Sourcery PR #295). */
  const { outcome, sources, dossier } = await runResearch({
    url: TRIAL_URL,
    lookup: { fullName: "Maya Chen", currentEmployer: "The George Institute" },
    fetch: async (url) =>
      url.includes("clinicaltrials.gov/api/v2/studies")
        ? answer(
            url,
            200,
            clinicalTrialsRecord({ name: "Maya Chen", affiliation: "Borealis College" }),
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
    url: TRIAL_URL,
    lookup: { fullName: "Maya Chen" },
    fetch: async (url) =>
      url.includes("clinicaltrials.gov/api/v2/studies")
        ? answer(url, 200, clinicalTrialsRecord({ name: "Maya Chen", affiliation: null }))
        : answer(url, 404, ""),
  });

  expect(dossier?.claims.map((claim) => claim.matchConfidence)).toEqual(["medium"]);
  expect(outcome.attempts.map((attempt) => attempt.code)).toContain("ambiguous-attribution");
});

test("a registry's punctuation in the named individual's name still reaches the match decision", async () => {
  const { dossier } = await runResearch({
    url: TRIAL_URL,
    lookup: { fullName: "Maya Chen", currentEmployer: "Atlas Institute" },
    fetch: async (url) =>
      url.includes("clinicaltrials.gov/api/v2/studies")
        ? answer(
            url,
            200,
            clinicalTrialsRecord({ name: "Maya Chen.", affiliation: "Atlas Institute" }),
          )
        : answer(url, 404, ""),
  });

  /* Matched, not merely ambiguous: the individual's own affiliation
     corroborates the Profile's employer, so the claim is high-confidence. */
  expect((dossier?.claims ?? []).map((claim) => claim.matchConfidence)).toEqual(["high"]);
});

test("a registry's repeated whitespace in the named individual's name still reaches the match decision", async () => {
  const { dossier } = await runResearch({
    url: TRIAL_URL,
    lookup: { fullName: "Maya Chen", currentEmployer: "Atlas Institute" },
    fetch: async (url) =>
      url.includes("clinicaltrials.gov/api/v2/studies")
        ? answer(
            url,
            200,
            clinicalTrialsRecord({ name: "Maya  Chen", affiliation: "Atlas Institute" }),
          )
        : answer(url, 404, ""),
  });

  /* Matched, not merely ambiguous: the individual's own affiliation
     corroborates the Profile's employer, so the claim is high-confidence. */
  expect((dossier?.claims ?? []).map((claim) => claim.matchConfidence)).toEqual(["high"]);
});

test("an apostrophe the registry spells as a separator still matches the Profile", async () => {
  const { dossier } = await runResearch({
    url: TRIAL_URL,
    lookup: { fullName: "Maya O'Neil", currentEmployer: "Atlas Institute" },
    fetch: async (url) =>
      url.includes("clinicaltrials.gov/api/v2/studies")
        ? answer(
            url,
            200,
            clinicalTrialsRecord({ name: "Maya O Neil", affiliation: "Atlas Institute" }),
          )
        : answer(url, 404, ""),
  });

  /* Matched, not merely ambiguous: punctuation folds to a separator
     consistently on both sides, so the individual's own affiliation
     corroborates the Profile's employer at high confidence. */
  expect((dossier?.claims ?? []).map((claim) => claim.matchConfidence)).toEqual(["high"]);
});

test("a record-level mention of the Profile's name without a structured individual match is not attributed", async () => {
  /* The trial's title and sponsor organisation carry "Maya Chen" (a
     founder-named institute), but the record's one structured official is a
     different person. The named-individual structure is the authority on who
     is in the record: a name occurring only in record-level fields is not a
     same-name match, so the record must be rejected instead of attributed as
     merely ambiguous (#250 review, Sourcery PR #295). */
  const { outcome, sources, dossier } = await runResearch({
    url: TRIAL_URL,
    lookup: { fullName: "Maya Chen" },
    fetch: async (url) =>
      url.includes("clinicaltrials.gov/api/v2/studies")
        ? answer(
            url,
            200,
            clinicalTrialsRecord({ name: "Rosa Park", affiliation: null }).replaceAll(
              "The George Institute",
              "Maya Chen Institute",
            ),
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

test("a record route serving its own application shell instead of data contributes no institutional fact", async () => {
  const { outcome, sources, dossier } = await runResearch({
    url: NPI_URL,
    lookup: { fullName: "Maya Chen", currentEmployer: "Internal Medicine" },
    fetch: async (url) =>
      url.includes("npiregistry.cms.hhs.gov")
        ? answer(url, 200, APP_SHELL_HTML, "text/html")
        : answer(url, 404, ""),
  });

  expect(sources).toEqual([]);
  expect(dossier?.claims ?? []).toEqual([]);
  const failures = outcome.attempts.filter(
    (attempt) => attempt.outcome === "failed" && attempt.targetKind === "record",
  );
  expect(failures.map((attempt) => attempt.code)).toContain("parser-failed");
  expect(
    outcome.leads.filter((lead) => lead.kind === "url").map((lead) => lead.disposition),
  ).toEqual(["inaccessible"]);
});

test("a body that is not a record of the expected shape renders nothing rather than a guess", () => {
  expect(
    renderInstitutionalRecord("npiregistry.cms.hhs.gov", { result_count: 0, results: [] }),
  ).toBeNull();
  expect(renderInstitutionalRecord("clinicaltrials.gov", { protocolSection: {} })).toBeNull();
  expect(
    isInstitutionalRecordRead(
      fromPartial({ acquisition: "html-reader", upstreamIndex: "npiregistry.cms.hhs.gov" }),
    ),
  ).toBe(false);
  expect(
    isInstitutionalRecordRead(
      fromPartial({ acquisition: "record-reader", upstreamIndex: "loc.gov" }),
    ),
  ).toBe(false);
});
/**
 * The failure this guards (review finding on issue #250, PR #295): a
 * registry endpoint answering HTTP 2xx with its own error or refusal
 * envelope — or with its empty result set — must never be retained as
 * record text. The envelope can echo the requested name, and text retained
 * without the record renderer's rights basis, version and attribution
 * limit would outlive the read that produced it.
 */
const ports = (recorder: ResearchAttemptRecorder, fetch: ReaderPorts["fetch"]): ReaderPorts =>
  fromPartial({ fetch, recorder, timeoutMs: 1000 });

test("a registry error envelope that names the Profile is failed, never retained as record text", async () => {
  const recorder = new ResearchAttemptRecorder("operation-refusal");
  const body = JSON.stringify({
    error: "invalid_request",
    error_description: "No provider record matches Maya Chen (NPI 1316660632).",
  });
  const result = await readPersonSource(
    NPI_URL,
    "",
    ports(recorder, async () => answer(NPI_URL, 200, body)),
  );
  /* NPPES's own documented refusal spells the key capitalized: observed live
     2026-09-07 as {"Errors":[{"description":"No valid search criteria
     provided","field":"generic","number":"04"}]}. */
  const capitalized = await readPersonSource(
    NPI_URL,
    "",
    ports(recorder, async () =>
      answer(
        NPI_URL,
        200,
        JSON.stringify({ Errors: [{ description: "No provider matches Maya Chen." }] }),
      ),
    ),
  );
  expect(capitalized.access).toBe("failed");
  expect(capitalized.text).toBe("");

  expect(result.access).toBe("failed");
  expect(result.text).toBe("");
  const refusal = recorder
    .failures()
    .find((attempt) => attempt.code === "registry-error-envelope")!;
  expect([refusal.stage, refusal.collector, refusal.cause]).toEqual([
    "access",
    "record-reader",
    "observed",
  ]);
  /* Shape only: the refusal's own text — which can echo the requested name —
     is hashed, never excerpted. */
  expect(refusal.observed?.excerpt).toBeUndefined();
  expect(refusal.observed?.bytes).toBe(body.length);
});

test("a ClinicalTrials.gov error envelope is failed rather than flattened into record text", async () => {
  const recorder = new ResearchAttemptRecorder("operation-trial-refusal");
  const result = await readPersonSource(
    TRIAL_URL,
    "",
    ports(recorder, async () =>
      answer(TRIAL_URL, 200, JSON.stringify({ error: { message: "No study matches." } })),
    ),
  );

  expect(result.access).toBe("failed");
  expect(
    recorder.failures().find((attempt) => attempt.code === "registry-error-envelope"),
  ).toBeTruthy();
});

test("an NPPES answer of no records is a coverage fact, not retained record text", async () => {
  const recorder = new ResearchAttemptRecorder("operation-empty");
  const body = JSON.stringify({ result_count: 0, results: [] });
  const result = await readPersonSource(
    NPI_URL,
    "",
    ports(recorder, async () => answer(NPI_URL, 200, body)),
  );

  expect(result.access).toBe("failed");
  expect(result.text).toBe("");
  const coverage = recorder.failures().find((attempt) => attempt.code === "resource-unavailable")!;
  expect(coverage.collector).toBe("record-reader");
  expect(coverage.reason).toContain("no record");
});

test("a linked document's provenance URL encodes the registry's filename", () => {
  const body = JSON.parse(clinicalTrialsRecord({ name: "Maya Chen", affiliation: null })) as {
    documentSection: { largeDocumentModule: { largeDocs: { label: string; filename: string }[] } };
  };
  body.documentSection.largeDocumentModule.largeDocs = [
    { label: "Study Protocol", filename: "Protocol Schedule v2.pdf" },
  ];
  const rendering = renderInstitutionalRecord("clinicaltrials.gov", body)!;
  expect(rendering.text).toContain(
    "https://clinicaltrials.gov/ProvidedDocs/86/NCT00949286/Protocol%20Schedule%20v2.pdf",
  );
});
