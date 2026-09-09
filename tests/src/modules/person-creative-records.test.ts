import { fromPartial } from "@total-typescript/shoehorn";
import { ResearchAttemptRecorder } from "../../../apps/server/src/person-profile/research-diagnostics.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { PersonDossier } from "@chief-of-staff-demo/shared";
import { sourceContributions } from "../../../apps/server/src/person-benchmark/source-contributions.js";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import {
  PersonResearch,
  researchAllowance,
} from "../../../apps/server/src/person-profile/research.js";
import {
  readPersonSource,
  type ReaderPorts,
  type SourceReadResult,
} from "../../../apps/server/src/person-profile/research-readers.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";
import {
  CREATIVE_MATERIALS,
  CREATIVE_RENDERERS,
  CREATIVE_METADATA_BASES,
  CREDIT_LIMIT,
  creativeNonRecordBody,
  isCreativeRecordRead,
  renderCreativeRecord,
} from "../../../apps/server/src/person-profile/creative-records.js";
import type { CreativeRecordRendering } from "../../../apps/server/src/person-profile/creative-records.js";

/**
 * Materials as the owner-extended schema reads them: until the shared
 * materials enum carries CREATIVE_MATERIALS, the closed type cannot name
 * what this module emits, so comparisons go through the widened view.
 */
const materialsOf = (rendered: CreativeRecordRendering) =>
  rendered.rights.materials as unknown as { material: string; disposition: string }[];

/**
 * Creative and cultural catalogue records as quotable evidence (issue #251).
 *
 * The failure these guard is specific: a catalogue response carries mixed
 * rights — waived catalogue fields, attribution-and-sharealike data, and
 * linked works licensed by nobody in the response — so a renderer that keeps
 * one licence for the whole response either withholds quotable fields or
 * launders unlicensed prose and images into retained evidence. And a credit
 * is not authorship: the corpus itself records the unjustified twin of every
 * catalogue fact it keeps (Bong's four credited writers, Adichie's edition
 * record, Gass's Frappuccino credit), so a rendering that lets "credited"
 * be read as "authored" manufactures exactly the overclaim the benchmark
 * rejects.
 *
 * Fixtures mirror the live response shapes probed anonymously on 2026-09-07:
 * the Americanah edition record and the Adichie author search on
 * openlibrary.org, a TVmaze person record with embedded cast credits, and a
 * loc.gov search envelope. They are trimmed to the fields the renderer reads.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A real Open Library edition shape (OL25428864M, Americanah), trimmed. */
const OL_EDITION = {
  key: "/books/OL25428864M",
  revision: 12,
  last_modified: { type: "/type/datetime", value: "2023-04-28T20:12:09.037745" },
  title: "Americanah",
  authors: [{ key: "/authors/OL1393502A" }],
  publish_date: "2013",
  publishers: ["Alfred A. Knopf"],
  number_of_pages: 477,
  isbn_13: ["9780307271082"],
  covers: [8474037],
  works: [{ key: "/works/OL16805415W" }],
  description: {
    type: "/type/text",
    value:
      "From the award-winning author of Half of a Yellow Sun, a dazzling new novel of love and race. (front flap)",
  },
};

/** A real Open Library author-search shape (Adichie), trimmed. */
const OL_AUTHOR_SEARCH = {
  numFound: 1,
  start: 0,
  numFoundExact: true,
  docs: [
    {
      alternate_names: ["Chimamanda Ngozi", "Amanda N. Adichie"],
      birth_date: "1977",
      key: "OL1393502A",
      name: "Chimamanda Ngozi Adichie",
      top_subjects: ["Fiction", "Nigeria", "Short stories"],
      top_work: "Americanah",
      type: "author",
      work_count: 67,
    },
  ],
};

/** A real TVmaze person shape (/people/14076) with embedded cast credits, trimmed. */
const TVMAZE_PERSON = {
  id: 14076,
  url: "https://www.tvmaze.com/people/14076/lena-headey",
  name: "Lena Headey",
  country: { name: "Bermuda", code: "BM", timezone: "Atlantic/Bermuda" },
  birthday: "1973-10-03",
  deathday: null,
  gender: "Female",
  image: {
    medium: "https://static.tvmaze.com/uploads/images/medium_portrait/458/1145115.jpg",
    original: "https://static.tvmaze.com/uploads/images/original_untouched/458/1145115.jpg",
  },
  updated: 1784898520,
  _links: { self: { href: "https://api.tvmaze.com/people/14076" } },
  _embedded: {
    castcredits: [
      {
        _links: {
          show: { href: "https://api.tvmaze.com/shows/82" },
          character: { href: "https://api.tvmaze.com/characters/1234" },
        },
        _embedded: {
          show: { name: "Game of Thrones" },
          character: { name: "Cersei Lannister" },
        },
      },
    ],
  },
};
/** A real TVmaze show shape (/shows/82) with embedded cast, trimmed. */
const TVMAZE_SHOW = {
  id: 82,
  url: "https://www.tvmaze.com/shows/82/game-of-thrones",
  name: "Game of Thrones",
  type: "Scripted",
  language: "English",
  premiered: "2011-04-17",
  ended: "2019-05-19",
  image: {
    medium: "https://static.tvmaze.com/uploads/images/medium_portrait/190/476117.jpg",
    original: "https://static.tvmaze.com/uploads/images/original_untouched/190/476117.jpg",
  },
  updated: 1784898520,
  _links: { self: { href: "https://api.tvmaze.com/shows/82" } },
  _embedded: {
    cast: [
      {
        person: {
          id: 14076,
          url: "https://www.tvmaze.com/people/14076/lena-headey",
          name: "Lena Headey",
          birthday: "1973-10-03",
          country: { name: "Bermuda" },
        },
        character: {
          id: 1234,
          url: "https://www.tvmaze.com/characters/1234/game-of-thrones-cersei-lannister",
          name: "Cersei Lannister",
        },
        self: false,
        voice: false,
      },
    ],
  },
};

/** A real loc.gov search shape (?fo=json), one authority result, trimmed. */
const LOC_SEARCH = {
  breadcrumbs: [{ "Library of Congress": "https://www.loc.gov" }],
  results: [
    {
      id: "http://www.loc.gov/item/n2003042876/chimamanda-ngozi-adichie/",
      title: "Chimamanda Ngozi Adichie",
      url: "https://www.loc.gov/item/n2003042876/chimamanda-ngozi-adichie/",
      date: "2025",
      subject: ["Authors", "Nigeria"],
      original_format: ["authority"],
      online_format: ["image"],
      access_restricted: false,
      digitized: true,
      image_url: "https://tile.loc.gov/image-services/iiif/abc123/full/pct:25/0/default.jpg",
      item: {
        alphabetize_by_name: ["Adichie, Chimamanda Ngozi"],
        alternative_names: ["adichie, chimamanda ngozi", "adichie, amanda n."],
      },
    },
  ],
};

test("an Open Library edition record renders bibliographic fields with per-field obligations", () => {
  const rendered = renderCreativeRecord("openlibrary.org", OL_EDITION);
  expect(rendered).not.toBeNull();
  /* Bibliographic fields the catalogue permission covers. */
  expect(rendered!.text).toContain("Title: Americanah");
  expect(rendered!.text).toContain("Publishers: Alfred A. Knopf");
  expect(rendered!.text).toContain("Publish date: 2013");
  expect(rendered!.text).toContain("Pages: 477");
  expect(rendered!.text).toContain("ISBN-13: 9780307271082");
  /* The author reference is an unresolved catalogue key, never a name. */
  expect(rendered!.text).toContain("/authors/OL1393502A");
  expect(rendered!.text).not.toContain("Chimamanda Ngozi Adichie");
  /* Per-field obligations travel in the retained text, not one record licence. */
  expect(rendered!.text).toContain("Description (publisher flap copy): withheld");
  expect(rendered!.text).toContain("Cover image: not retrieved");
  expect(rendered!.text).toContain(CREDIT_LIMIT);
  expect(rendered!.publishedAt).toBe("2013");
  expect(rendered!.sourceVersion).toContain("12");
  expect(rendered!.provenanceNote).toContain("openlibrary.org");
  /* Linked catalogue pages are provenance, never auto-followed leads. */
  expect(rendered!.outboundUrls).toEqual([]);
  expect(rendered!.text).toContain("Linked material");
  expect(rendered!.anchors.map((entry) => entry.value)).toContain("Rights");
});

test("the edition's structured rights keep each field group's licence apart", () => {
  const rendered = renderCreativeRecord("openlibrary.org", OL_EDITION)!;
  expect(rendered.rights.metadata.basis).toBe("openlibrary-public-api");
  expect(rendered.rights.metadata.documentation).toContain("openlibrary.org/developers/api");
  expect(rendered.rights.declared).toEqual([]);
  const materials = Object.fromEntries(
    rendered.rights.materials.map((entry) => [entry.material, entry]),
  );
  /* Publisher flap copy travels in the response under no stated licence. */
  expect(materials["description"].disposition).toBe("withheld-no-rights-basis");
  expect(materials["description"].licence).toBeNull();
  /* The cover is third-party art the response licenses to nobody. */
  expect(materials["cover-image"].disposition).toBe("not-retrieved");
  expect(materials["cover-image"].licence).toBeNull();
  /* The linked work and author pages stay leads under their own reads. */
  expect(materials["linked-work"].disposition).toBe("not-retrieved");
  /* Every emitted basis and material is one the integration owner's schema
     extension carries (CREATIVE_METADATA_BASES / CREATIVE_MATERIALS): a new
     value here without its writer there breaks the dossier store's parse. */
  expect(CREATIVE_METADATA_BASES).toContain(rendered.rights.metadata.basis);
  for (const entry of rendered.rights.materials)
    expect(CREATIVE_MATERIALS).toContain(entry.material);
});
test("an Open Library author search asserts a catalogue credit, not authorship", () => {
  const rendered = renderCreativeRecord("openlibrary.org", OL_AUTHOR_SEARCH)!;
  expect(rendered.text).toContain("Chimamanda Ngozi Adichie");
  expect(rendered.text).toContain("Americanah");
  expect(rendered.text).toContain("67");
  expect(rendered.text).toContain(CREDIT_LIMIT);
  /* Credit wording only: the record keys an author entity, it never says who
     wrote what, and the renderer must not upgrade it either. */
  expect(rendered.text).toContain("credited in the catalogue as");
  const withoutLimit = rendered.text.replaceAll(CREDIT_LIMIT, "");
  expect(withoutLimit).not.toContain("authored");
  expect(withoutLimit).not.toContain("wrote");
  expect(
    isCreativeRecordRead({ acquisition: "record-reader", upstreamIndex: "openlibrary.org" }),
  ).toBe(true);
  expect(isCreativeRecordRead({ acquisition: "record-reader", upstreamIndex: "loc.gov" })).toBe(
    true,
  );
  expect(
    isCreativeRecordRead({ acquisition: "html-reader", upstreamIndex: "openlibrary.org" }),
  ).toBe(false);
});

test("a TVmaze person record credits cast roles under CC BY-SA with the portrait withheld", () => {
  const rendered = renderCreativeRecord("tvmaze.com", TVMAZE_PERSON)!;
  expect(rendered.text).toContain("Lena Headey");
  expect(rendered.text).toContain("credited as Cersei Lannister on Game of Thrones");
  expect(rendered.text).toContain("1973-10-03");
  expect(rendered.text).toContain(CREDIT_LIMIT);
  /* The catalogue data is attribution-and-sharealike: the obligation names
     TVmaze and travels with the retained fields. */
  expect(rendered.rights.metadata.basis).toBe("tvmaze-free-api");
  expect(rendered.rights.metadata.statement).toContain("CC BY-SA");
  expect(rendered.rights.metadata.statement).toContain("TVmaze");
  expect(rendered.text).toContain("CC BY-SA");
  /* The portrait is hotlinkable per the docs but licensed by nobody in the
     response: named, never fetched. */
  expect(materialsOf(rendered).find((entry) => entry.material === "cover-image")?.disposition).toBe(
    "not-retrieved",
  );
  expect(rendered.outboundUrls).toEqual([]);
  expect(rendered.sourceVersion).toContain("1784898520");
});
test("a TVmaze show record with embedded cast parses cast members under CC BY-SA", () => {
  const rendered = renderCreativeRecord("tvmaze.com", TVMAZE_SHOW)!;
  expect(rendered).not.toBeNull();
  expect(rendered.text).toContain("Show: Game of Thrones");
  expect(rendered.text).toContain("Lena Headey — credited as Cersei Lannister on Game of Thrones");
  expect(rendered.text).toContain("https://www.tvmaze.com/people/14076/lena-headey");
  expect(rendered.text).toContain(CREDIT_LIMIT);
  expect(rendered.rights.metadata.basis).toBe("tvmaze-free-api");
  expect(rendered.rights.metadata.statement).toContain("CC BY-SA");
  expect(rendered.rights.metadata.statement).toContain("TVmaze");
  expect(materialsOf(rendered).find((entry) => entry.material === "cover-image")?.disposition).toBe(
    "not-retrieved",
  );
  expect(materialsOf(rendered).find((entry) => entry.material === "linked-work")?.disposition).toBe(
    "not-retrieved",
  );
});

test("a Library of Congress search result renders the entry with its access flag", () => {
  const rendered = renderCreativeRecord("loc.gov", LOC_SEARCH)!;
  expect(rendered.text).toContain("Chimamanda Ngozi Adichie");
  expect(rendered.text).toContain("https://www.loc.gov/item/n2003042876/chimamanda-ngozi-adichie/");
  expect(rendered.text).toContain("not access-restricted");
  expect(rendered.text).toContain(CREDIT_LIMIT);
  expect(rendered.rights.metadata.basis).toBe("loc-json-api");
  expect(rendered.rights.metadata.documentation).toContain("loc.gov/apis/json-and-yaml");
  expect(materialsOf(rendered).find((entry) => entry.material === "cover-image")?.disposition).toBe(
    "not-retrieved",
  );
  expect(materialsOf(rendered).find((entry) => entry.material === "linked-work")?.disposition).toBe(
    "not-retrieved",
  );
  expect(rendered.outboundUrls).toEqual([]);
});

test("no catalogue rendering states authorship or the significance of a credit", () => {
  const renderings = [
    renderCreativeRecord("openlibrary.org", OL_EDITION)!,
    renderCreativeRecord("openlibrary.org", OL_AUTHOR_SEARCH)!,
    renderCreativeRecord("tvmaze.com", TVMAZE_PERSON)!,
    renderCreativeRecord("loc.gov", LOC_SEARCH)!,
  ];
  for (const rendered of renderings) {
    expect(rendered.text).toContain(CREDIT_LIMIT);
    /* The limit sentence itself names what the record must not be read as;
       everywhere else, no authorship or significance upgrade may appear. */
    const withoutLimit = rendered.text.replaceAll(CREDIT_LIMIT, "");
    expect(withoutLimit).not.toMatch(/authored|wrote the|significant|important work/i);
  }
});

test("a body that is not a catalogue record of the expected shape renders nothing", () => {
  expect(renderCreativeRecord("openlibrary.org", { hello: "world" })).toBeNull();
  expect(renderCreativeRecord("tvmaze.com", [{ score: 1 }])).toBeNull();
  expect(renderCreativeRecord("loc.gov", { results: "many" })).toBeNull();
  expect(renderCreativeRecord("openlibrary.org", null)).toBeNull();
});

test("an Open Library notfound envelope is a coverage fact, never retained text", () => {
  /* Observed live 2026-09-07: an unknown edition key answers HTTP 404 with
     {"error": "notfound", "key": ...}. */
  expect(
    creativeNonRecordBody("openlibrary.org", { error: "notfound", key: "/books/OL00000000M" }),
  ).toBe("resource-unavailable");
  expect(renderCreativeRecord("openlibrary.org", { error: "notfound" })).toBeNull();
  /* An empty author search is the same coverage fact in the search shape. */
  expect(creativeNonRecordBody("openlibrary.org", { numFound: 0, start: 0, docs: [] })).toBe(
    "resource-unavailable",
  );
  expect(creativeNonRecordBody("openlibrary.org", OL_EDITION)).toBeNull();
});

test("a TVmaze Not Found envelope contributes no creative fact", () => {
  /* Observed live 2026-09-07: an unknown person id answers HTTP 404 with
     {"name": "Not Found", "message": "", "code": 0, "status": 404}. A person
     record also carries `name`, so the numeric `status` is what tells the
     envelope apart — matching on `name` alone would refuse every person. */
  expect(
    creativeNonRecordBody("tvmaze.com", { name: "Not Found", message: "", code: 0, status: 404 }),
  ).toBe("resource-unavailable");
  expect(renderCreativeRecord("tvmaze.com", { name: "Not Found", status: 404 })).toBeNull();
  expect(creativeNonRecordBody("tvmaze.com", TVMAZE_PERSON)).toBeNull();
  expect(creativeNonRecordBody("tvmaze.com", [])).toBe("resource-unavailable");
  expect(renderCreativeRecord("tvmaze.com", [])).toBeNull();
});

test("a TVmaze people-search response unwraps the hit under CC BY-SA", () => {
  const searchHit = [{ score: 0.95, person: TVMAZE_PERSON }];
  const rendered = renderCreativeRecord("tvmaze.com", searchHit)!;
  expect(rendered).not.toBeNull();
  expect(rendered.text).toContain("Lena Headey");
  expect(rendered.text).toContain("credited as Cersei Lannister on Game of Thrones");
  expect(rendered.rights.metadata.basis).toBe("tvmaze-free-api");
});

test("an empty LOC result set is a coverage fact, never retained text", () => {
  expect(
    creativeNonRecordBody("loc.gov", {
      breadcrumbs: [],
      results: [],
      facet_trail: [],
    }),
  ).toBe("resource-unavailable");
  expect(renderCreativeRecord("loc.gov", { results: [] })).toBeNull();
  expect(creativeNonRecordBody("loc.gov", LOC_SEARCH)).toBeNull();
});

test("a key-gated catalogue has no renderer and contributes no creative fact", () => {
  /* Europeana's REST API answered an anonymous search with HTTP 401
     {"success": false, "error": "Unauthorized"} on 2026-09-07: every call
     needs a personal wskey, which #228 excludes even where the tier is free.
     The route stays excluded and is not counted as expansion, so no renderer
     may claim its responses. */
  expect(CREATIVE_RENDERERS).not.toContain("api.europeana.eu");
  expect(
    renderCreativeRecord("api.europeana.eu", { success: false, error: "Unauthorized" }),
  ).toBeNull();
  expect(
    creativeNonRecordBody("api.europeana.eu", { success: false, error: "Unauthorized" }),
  ).toBeNull();
});

/** The Open Library author-search URL the catalogue read stands in for. */
const OL_AUTHOR_URL = "https://openlibrary.org/search/authors.json?q=Chimamanda%20Ngozi%20Adichie";

/**
 * The future renderJson branch for creative indexes, against the production
 * research loop: transport is mocked at the catalogue endpoint and the
 * rendering above supplies text, anchors, provenance and version exactly as
 * the wired branch will. Structured rights travel as null here — not as a
 * claim about the route, but because the three new metadata bases still need
 * the integration owner's shared-schema extension before the dossier store's
 * strict parse accepts them; the per-field obligations below are asserted on
 * the retained text that carries them today.
 */
const wiredCreativeRead = (body: unknown, index: string, finalUrl: string): SourceReadResult => {
  const rendered = renderCreativeRecord(index, body);
  if (!rendered) throw new Error(`fixture must render as a ${index} catalogue record`);
  return {
    text: rendered.text,
    capturedAt: null,
    completeness: "full",
    access: "retrieved",
    outboundUrls: rendered.outboundUrls,
    family: "creative-records",
    route: "record-reader",
    upstreamIndex: index,
    publishedAt: rendered.publishedAt,
    author: null,
    anchors: rendered.anchors,
    provenanceNote: rendered.provenanceNote,
    sourceVersion: rendered.sourceVersion,
    rights: rendered.rights,
    finalUrl,
  };
};

test("a retained catalogue record grounds an exclusive creative-records contribution", async () => {
  const root = mkdtempSync(join(tmpdir(), "creative-records-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const profile = people.create({ fullName: "Chimamanda Ngozi Adichie" });
  const dossiers = new PersonDossierStore(root);
  const quote = "Top work: Americanah";
  const credit = "Catalogue credit: Chimamanda Ngozi Adichie — catalogue author entry OL1393502A";
  const readSource = async (url: string): Promise<SourceReadResult> =>
    wiredCreativeRead(OL_AUTHOR_SEARCH, "openlibrary.org", url);
  const research = new PersonResearch({
    people,
    dossiers,
    search: async () => [
      { url: OL_AUTHOR_URL, title: "Chimamanda Ngozi Adichie — Open Library", snippet: "" },
    ],
    readSource,
    complete: async () => ({
      fullName: null,
      employer: null,
      sourceClass: "primary-artifact",
      author: null,
      publishedAt: null,
      claims: [
        {
          id: "catalogue-credit",
          section: "work",
          /* A credit, quoted and stated as one: the author search keys an
             author entity with a top work, so the claim credits the catalogue
             entry rather than asserting she authored anything. */
          statement: credit,
          status: "supported",
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: null,
          effectiveTo: null,
          citations: [
            { sourceId: "source", quote },
            { sourceId: "source", quote: "Name: Chimamanda Ngozi Adichie" },
          ],
          supports: [],
          supersedes: [],
          changeReason: null,
        },
      ],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
  });

  const result = await research.run(
    profile,
    researchAllowance({ maxModelCalls: 3, maxMilliseconds: 20_000 }),
  );
  const dossier = dossiers.get(profile.id)!;

  /* The extraction path rekeys model-local ids, so the claim is found by its
     credit statement, not by the id the model used. */
  const claim = dossier.claims.find((entry) => entry.statement === credit)!;
  const source = dossiers.source(profile.id, claim.citations[0].sourceId)!;
  /* Retained evidence keeps the per-field obligations, not one record licence. */
  expect(source.evidenceFamily).toBe("creative-records");
  expect(source.text).toContain("Catalogue fields (names, dates, work counts, subjects)");
  expect(source.text).toContain("Linked material");
  expect(source.text).toContain(CREDIT_LIMIT);
  /* The creative-records coverage area is satisfied by the retained source. */
  const area = result.operation.coverage.find((entry) => entry.key === "creative-records")!;
  expect(area.kind).toBe("source-family");
  expect(area.state).toBe("satisfied");
  expect(area.sources).toBeGreaterThanOrEqual(1);
  /* Exclusive contribution: the catalogue fact is recovered here and cited
     from this family alone. */
  const contributions = sourceContributions(
    dossier,
    [source],
    [
      {
        factId: "catalogue",
        verdict: "recovered",
        referenceQuote: "docs[0].top_work: Americanah",
        evidenceQuote: quote,
        claimId: claim.id,
        rationale: "The retained author record names the top work the reference cites.",
        reviewRequired: false,
      },
    ],
    new Set(),
  );
  const creative = contributions.find((entry) => entry.family === "creative-records")!;
  expect(creative.sources).toEqual([
    expect.objectContaining({ url: OL_AUTHOR_URL, upstreamIndex: "openlibrary.org", cited: true }),
  ]);
  expect(creative.recoveredFactIds).toEqual(["catalogue"]);
  expect(creative.exclusiveRecoveredFactIds).toEqual(["catalogue"]);
});

test("a catalogue refusal envelope fails the read and retains no source", async () => {
  const root = mkdtempSync(join(tmpdir(), "creative-records-refusal-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const profile = people.create({ fullName: "Chimamanda Ngozi Adichie" });
  const dossiers = new PersonDossierStore(root);
  const envelope = { error: "notfound", key: "/books/OL00000000M" };
  const readSource = async (
    url: string,
    snippet: string,
    ports: ReaderPorts,
  ): Promise<SourceReadResult> => {
    /* The snippet is deliberately unused: see the empty-text note below. */
    void snippet;
    /* The wired branch's refusal path: the envelope's own code, shape-only
       observation (an envelope can echo the requested name), no retained
       text — mirroring the institutional envelope handling. */
    const code = creativeNonRecordBody("openlibrary.org", envelope)!;
    const attemptOf = ports.recorder.correlate(url);
    ports.recorder.record({
      stage: "access",
      code,
      outcome: "failed",
      recovery: "stopped",
      cause: "observed",
      target: url,
      targetKind: "record",
      collector: "record-reader",
      reason: "The openlibrary.org record endpoint answered: no record for this identifier.",
      attemptOf,
      observed: { finalUrl: url },
      impact: "The catalogue holds no record for this identifier.",
      remediation: `Reproduce with: curl -sS '${url}'`,
    });
    return {
      /* Deliberately no snippet (wayback precedent,
         research-readers.ts readArchivedCapture): the only text in hand is
         the envelope's, which can echo the requested name, so a failed
         catalogue read contributes nothing retainable. */
      text: "",
      capturedAt: null,
      completeness: "unavailable",
      access: "failed",
      outboundUrls: [],
      family: "creative-records",
      route: "record-reader",
      upstreamIndex: "openlibrary.org",
      publishedAt: null,
      author: null,
      anchors: [],
      provenanceNote: null,
      sourceVersion: null,
      rights: null,
      finalUrl: url,
    };
  };
  const research = new PersonResearch({
    people,
    dossiers,
    search: async () => [
      { url: "https://openlibrary.org/books/OL00000000M", title: "Missing", snippet: "" },
    ],
    readSource,
    complete: async () => ({
      fullName: null,
      employer: null,
      sourceClass: "primary-artifact",
      author: null,
      publishedAt: null,
      claims: [],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
  });

  const result = await research.run(
    profile,
    researchAllowance({ maxModelCalls: 3, maxMilliseconds: 20_000 }),
  );

  expect(result.operation.attempts.some((entry) => entry.code === "resource-unavailable")).toBe(
    true,
  );
  expect(dossiers.get(profile.id)?.sourceIds ?? []).toEqual([]);
  const dossier: PersonDossier | null = dossiers.get(profile.id);
  expect(dossier?.claims ?? []).toEqual([]);
});
test("a 404 JSON response from a creative record endpoint returns an empty failed read", async () => {
  const recorder = new ResearchAttemptRecorder("operation-creative-refusal-404");
  const result = await readPersonSource(
    "https://openlibrary.org/works/OL12345W",
    "some snippet text that should not be kept",
    fromPartial<ReaderPorts>({
      fetch: async (url: string) => ({
        url,
        status: 404,
        contentType: "application/json",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: JSON.stringify({ error: "notfound", key: "/works/OL12345W" }),
      }),
      recorder,
      timeoutMs: 1000,
    }),
  );

  expect(result.access).toBe("failed");
  expect(result.text).toBe("");
  expect(result.completeness).toBe("unavailable");
  const failures = recorder.failures();
  expect(failures.length).toBeGreaterThan(0);
  expect(failures[0]).toMatchObject({
    collector: "record-reader",
    code: "resource-unavailable",
    outcome: "failed",
  });
});
