import type { PersonResearchFailureCode, PersonSourceRights } from "@chief-of-staff-demo/shared";

/**
 * Creative and cultural catalogue records, read as evidence rather than as
 * catalogue hits (issue #251).
 *
 * A catalogue response carries mixed rights inside one body: waived catalogue
 * fields beside attribution-and-sharealike data, publisher prose carried
 * under no licence at all, and cover art and linked works licensed by nobody
 * in the response. What a Profile can use is the catalogue's own fields —
 * who is credited, what the entry dates, and what keeping each field group
 * obliges — kept per field group rather than labelled with one licence for
 * the whole response. The generic JSON flattener would carry a flap-copy
 * description into retained text under a permission that does not cover it,
 * or a cover URL in as if the catalogue had licensed the image.
 *
 * The attribution rule this ticket adds is stricter than participation: a
 * catalogue entry establishes a CREDIT. It does not establish that the
 * credited person authored the linked work — an edition's author list is a
 * catalogue claim, a cast credit is a casting fact — and it does not
 * establish that the credit is significant, so a rendering that lets
 * "credited" be read as "authored" manufactures exactly the overclaim the
 * benchmark's unjustified sets reject (Bong's four credited writers,
 * Adichie's edition record, Gass's Frappuccino credit). Every rendering
 * below carries that limit, and author references that arrive as unresolved
 * catalogue keys are rendered as keys, never resolved into names by guess.
 *
 * Same-name entries are held apart by the identity resolution that already
 * runs over every source (`PersonResearch.decideIdentity` in `research.ts`).
 * Nothing here repeats that resolution; this module only renders what one
 * catalogue record says, and it exposes no `namedIndividuals`: a
 * catalogue-level name is the catalogue's, not a corroborating affiliation,
 * so identity resolution reads the rendered text the way it reads any other
 * non-registry source.
 */

/** The catalogue indexes whose records this module can render. */
export const CREATIVE_RENDERERS = ["openlibrary.org", "loc.gov", "tvmaze.com"] as const;

/**
 * The sentence every rendered record carries.
 *
 * Exported so a caller can assert the limit travels with the text instead of
 * pinning the wording, and so the wording lives in one place.
 */
export const CREDIT_LIMIT =
  "Credit only: this record establishes that the person named is credited in the stated role, not that they authored the linked work and not that the credit is significant.";

/**
 * Metadata permission bases this module's renderings are retained under.
 *
 * Sibling-ticket bases join them in the shared `PersonSourceRights` enum:
 * `orcid-public-api` for #252, `nppes-public-registry` and
 * `clinicaltrials-public-api` for #250, and these three for #251.
 */
export const CREATIVE_METADATA_BASES = [
  "openlibrary-public-api",
  "loc-json-api",
  "tvmaze-free-api",
] as const;

/**
 * Materials beyond the metadata this module distinguishes. `cover-image` (a
 * portrait, thumbnail or cover the response licenses to nobody),
 * `linked-work` (a catalogue page the record names as provenance for its own
 * later read) and `description` (carried prose, such as publisher flap copy,
 * withheld for want of any rights basis) join the shared materials enum the
 * same way; every value below already has its writer here.
 */
export const CREATIVE_MATERIALS = ["cover-image", "linked-work", "description"] as const;

/** One person the record credits, in the record's own credit wording. */
interface CreditedPerson {
  name: string;
  /** How the record itself states the credit: "credited as X on Y". */
  role: string;
  identifiers: string[];
}

/** One field group and what keeping it obliges, licence plus attribution. */
interface FieldLicence {
  fields: string;
  licence: string;
  attribution: string | null;
}

/** A document, image or catalogue page a record links without granting rights over it. */
interface LinkedMaterial {
  label: string;
  url: string;
}

/** What one catalogue's record says, before it becomes retained text. */
interface RecordFacts {
  identity: [string, string][];
  dates: [string, string][];
  credited: CreditedPerson[];
  linked: LinkedMaterial[];
  fieldLicences: FieldLicence[];
  publishedAt: string | null;
  sourceVersion: string | null;
  metadata: {
    basis: (typeof CREATIVE_METADATA_BASES)[number];
    statement: string;
    documentation: string;
  };
  materials: {
    material: (typeof CREATIVE_MATERIALS)[number];
    disposition: "retained-under-declared-licence" | "withheld-no-rights-basis" | "not-retrieved";
    licence: string | null;
    reason: string;
  }[];
}

export interface CreativeRecordRendering {
  text: string;
  publishedAt: string | null;
  sourceVersion: string | null;
  rights: PersonSourceRights;
  provenanceNote: string;
  anchors: { kind: "section"; value: string; offset: number }[];
  /**
   * Always empty. A cover or portrait, a flap-copy description's absence
   * aside, and every linked catalogue page are recorded provenance — named in
   * the "Linked material" text section and in `rights.materials` — never a
   * URL here: `outboundUrls` is exactly what `PersonResearch` turns into an
   * automatically-read lead, and linked catalogue material has to stay unread
   * under this record's metadata-only permission until something reads it
   * under its own rights (the same review finding as the sibling record
   * modules, PR #295).
   */
  outboundUrls: string[];
}

/**
 * Whether a retained source is a creative or cultural catalogue record.
 *
 * Both halves matter: the record reader is what produced field lines rather
 * than a page, and the upstream index is what says those lines are a
 * catalogue entry rather than a publication, registry or identity record.
 */
export function isCreativeRecordRead(read: {
  acquisition: string;
  upstreamIndex?: string | null | undefined;
}): boolean {
  return (
    read.acquisition === "record-reader" &&
    (CREATIVE_RENDERERS as readonly string[]).includes(read.upstreamIndex ?? "")
  );
}

/** Render one catalogue's record, or nothing when the body is not one. */
export function renderCreativeRecord(index: string, body: unknown): CreativeRecordRendering | null {
  const facts =
    index === "openlibrary.org"
      ? openLibraryFacts(body)
      : index === "loc.gov"
        ? libraryOfCongressFacts(body)
        : index === "tvmaze.com"
          ? tvmazeFacts(body)
          : null;
  return facts ? assemble(index, facts) : null;
}

/**
 * Whether one of this module's indexes answered with a body that, by that
 * index's own conventions, is not a record and never becomes one, and the
 * failure code its read takes.
 *
 * Deliberately narrower than "the renderer returned null": a body the
 * renderer cannot fully read stays with the generic flattener, the normal
 * retention path for records this module has not grown into (#249, #250). An
 * answer the index's own conventions define as a non-record — Open Library's
 * `notfound` envelope (observed live 2026-09-07), TVmaze's `Not Found`
 * envelope (observed live 2026-09-07), an empty result set on either search
 * shape — is refused here, and its text is never retained: such an envelope
 * can echo the requested name, and no rights basis, version or attribution
 * would cover it (review finding on issue #250, PR #295). A catalogue saying
 * it holds nothing is a fact about coverage (`resource-unavailable`); only an
 * envelope that declines to serve is `registry-error-envelope`.
 */
export function creativeNonRecordBody(
  index: string,
  body: unknown,
): PersonResearchFailureCode | null {
  if (!(CREATIVE_RENDERERS as readonly string[]).includes(index)) return null;
  if (index === "tvmaze.com") {
    /* An empty search result set answers HTTP 200 with [] */
    if (Array.isArray(body) && body.length === 0) return "resource-unavailable";
    const envelope = record(body);
    if (envelope && typeof envelope.status === "number")
      return envelope.status === 404 ? "resource-unavailable" : "registry-error-envelope";
    return null;
  }
  const envelope = record(body);
  if (!envelope) return null;
  if (index === "openlibrary.org") {
    /* An unknown edition or work key answers HTTP 404 with
       {"error": "notfound", "key": ...}: the catalogue holds nothing under
       that key. Any other error envelope is the index declining to serve. */
    if (typeof envelope.error === "string")
      return envelope.error === "notfound" ? "resource-unavailable" : "registry-error-envelope";
    /* A search that matched nothing answers 200 with an empty document set. */
    if (Array.isArray(envelope.docs) && envelope.docs.length === 0) return "resource-unavailable";
    return null;
  }
  if (index === "loc.gov") {
    if (Array.isArray(envelope.results))
      return envelope.results.length === 0 ? "resource-unavailable" : null;
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Assembly                                                             */
/* ------------------------------------------------------------------ */

function assemble(index: string, facts: RecordFacts): CreativeRecordRendering {
  const rights: PersonSourceRights = {
    metadata: facts.metadata,
    declared: [],
    materials: facts.materials,
  };

  const sections: [string, string[]][] = [
    ["Record identity", facts.identity.map(([label, value]) => `${label}: ${value}`)],
    ...(facts.dates.length > 0
      ? ([["Dates", facts.dates.map(([label, value]) => `${label}: ${value}`)]] as [
          string,
          string[],
        ][])
      : []),
    [
      "Credit",
      [
        ...(facts.credited.length > 0
          ? facts.credited.map(
              (entry) =>
                `${entry.name} — ${entry.role}; ${
                  entry.identifiers.length
                    ? entry.identifiers.join(", ")
                    : "no identifier in this record"
                }`,
            )
          : ["No named credit role in this record."]),
        CREDIT_LIMIT,
      ],
    ],
    [
      "Rights",
      [
        `Metadata: ${rights.metadata.statement} (${rights.metadata.documentation})`,
        ...facts.fieldLicences.map(
          (entry) =>
            `${entry.fields}: ${entry.licence}${
              entry.attribution ? ` — attribution: ${entry.attribution}` : ""
            }`,
        ),
        ...rights.materials.map(
          (entry) => `${entry.material}: ${entry.disposition} — ${entry.reason}`,
        ),
      ],
    ],
    ...(facts.linked.length > 0
      ? ([["Linked material", facts.linked.map((entry) => `${entry.label}: ${entry.url}`)]] as [
          string,
          string[],
        ][])
      : []),
  ];

  const anchors: CreativeRecordRendering["anchors"] = [];
  let text = "";
  for (const [name, lines] of sections) {
    anchors.push({ kind: "section", value: name, offset: text.length });
    text += `${name}\n${lines.join("\n")}\n\n`;
  }

  return {
    text: text.trimEnd(),
    publishedAt: facts.publishedAt,
    sourceVersion: facts.sourceVersion,
    rights,
    provenanceNote: `Creative or cultural catalogue record from ${index}, rendered from its catalogue fields. ${CREDIT_LIMIT}`,
    anchors,
    /* Linked catalogue pages, covers and portraits are recorded above, in
       "Linked material" and in `rights.materials`; none becomes an outbound
       URL. `outboundUrls` is what PersonResearch turns into a URL lead it
       reads automatically, and catalogue material must stay unread under this
       record's metadata-only permission (the same review finding as the
       sibling record modules, PR #295). */
    outboundUrls: [],
  };
}

/* ------------------------------------------------------------------ */
/* Field reading                                                        */
/* ------------------------------------------------------------------ */

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown, limit = 400): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed.slice(0, limit) : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pairs(entries: [string, string | null][]): [string, string][] {
  return entries.flatMap(([label, value]) => (value ? [[label, value] as [string, string]] : []));
}

/** Carried prose: a bare string or Open Library's typed-text wrapper. */
function prose(value: unknown, limit = 2000): string | null {
  if (typeof value === "string") return str(value, limit);
  return str(record(value)?.value, limit);
}

/**
 * Open Library: an author-search response (a `docs` set whose first hit keys
 * an author entity) or one edition or work record (a titled object keyed
 * under `/books/` or `/works/`).
 *
 * Observed live 2026-09-07: the Americanah edition record carries
 * bibliographic fields, author references as bare catalogue keys, flap-copy
 * prose and a cover id; the author search carries the name, birth date, top
 * work and the catalogue's own work count. An edition never names its
 * authors in the response, so its keys stay keys.
 */
function openLibraryFacts(body: unknown): RecordFacts | null {
  const envelope = record(body);
  if (!envelope) return null;
  if (Array.isArray(envelope.docs)) {
    const first = record(envelope.docs[0]);
    const name = str(first?.name, 200);
    const key = str(first?.key, 40);
    if (!first || !name || !key) return null;
    const topWork = str(first.top_work, 300);
    const workCount = num(first.work_count);
    const authorPage = key.startsWith("/")
      ? `https://openlibrary.org${key}`
      : `https://openlibrary.org/authors/${key}`;
    return {
      identity: pairs([
        ["Index", "openlibrary.org"],
        ["Record", key],
        ["Name", name],
        ["Birth date", str(first.birth_date, 40)],
        ["Top work", topWork],
        ["Catalogue works", workCount === null ? null : String(workCount)],
        [
          "Top subjects",
          list(first.top_subjects)
            .filter((entry) => typeof entry === "string")
            .slice(0, 5)
            .join("; ") || null,
        ],
      ]),
      dates: [],
      credited: [
        {
          name,
          role: `credited in the catalogue as author entry ${key}${
            topWork ? `; top work ${topWork}` : ""
          }${workCount === null ? "" : ` across ${String(workCount)} catalogue works`}`,
          identifiers: [key],
        },
      ],
      linked: [{ label: "Author page", url: authorPage }],
      fieldLicences: [
        {
          fields: "Catalogue fields (names, dates, work counts, subjects)",
          licence: "retained under the public API permission above",
          attribution: null,
        },
      ],
      publishedAt: null,
      sourceVersion: null,
      metadata: {
        basis: "openlibrary-public-api",
        statement:
          "Open Library's public API serves catalogue metadata to anonymous callers within its documented rate limits. The bibliographic and community fields above are retained under that permission, which states no licence over carried prose or images.",
        documentation: "https://openlibrary.org/developers/api",
      },
      materials: [
        {
          material: "linked-work",
          disposition: "not-retrieved",
          licence: null,
          reason:
            "The linked author page stays a lead to be read as its own record under the same permission, not a URL this read follows.",
        },
      ],
    };
  }
  const key = str(envelope.key, 60);
  const title = str(envelope.title, 400);
  if (!title || !key || /^\/(books|works)\//.test(key) === false) return null;
  const authorKeys = list(envelope.authors).flatMap((entry) => {
    const direct = str(record(entry)?.key, 60);
    if (direct) return [direct];
    const nested = str(record(record(entry)?.author)?.key, 60);
    return nested ? [nested] : [];
  });
  const workKeys = list(envelope.works)
    .map((entry) => str(record(entry)?.key, 60))
    .flatMap((entry) => (entry ? [entry] : []));
  const coverIds = list(envelope.covers).filter(
    (entry): entry is number => typeof entry === "number",
  );
  const description = prose(envelope.description);
  const isbn = str(list(envelope.isbn_13)[0], 40) ?? str(list(envelope.isbn)[0], 40);
  const pages = num(envelope.number_of_pages);
  const linked: LinkedMaterial[] = [
    ...workKeys.map((work) => ({
      label: "Linked work",
      url: `https://openlibrary.org${work}`,
    })),
    ...authorKeys.map((author) => ({
      label: "Linked author page",
      url: author.startsWith("/") ? `https://openlibrary.org${author}` : author,
    })),
  ];
  if (coverIds.length > 0)
    linked.push({
      label: "Cover image (not retrieved)",
      url: `https://covers.openlibrary.org/b/id/${String(coverIds[0])}-L.jpg`,
    });
  const revision = num(envelope.revision);
  const modified = str(record(envelope.last_modified)?.value, 60);
  return {
    identity: pairs([
      ["Index", "openlibrary.org"],
      ["Record", key],
      ["Title", title],
      [
        "Publishers",
        list(envelope.publishers)
          .filter((entry) => typeof entry === "string")
          .join("; ") || null,
      ],
      ["Publish date", str(envelope.publish_date, 40)],
      ["Pages", pages === null ? null : String(pages)],
      ["ISBN-13", isbn],
      ["Work", workKeys[0] ?? null],
      ["Author references (unresolved catalogue keys, not names)", authorKeys.join(", ") || null],
    ]),
    dates: pairs([["Published", str(envelope.publish_date, 40)]]),
    credited: [],
    linked,
    fieldLicences: [
      {
        fields: "Bibliographic fields (title, publishers, dates, pages, identifiers)",
        licence: "retained under the public API permission above",
        attribution: null,
      },
      ...(description
        ? ([
            {
              fields: "Description (publisher flap copy)",
              licence: "withheld — creative text the response licenses to nobody",
              attribution: null,
            },
          ] as FieldLicence[])
        : []),
      ...(coverIds.length > 0
        ? ([
            {
              fields: "Cover image",
              licence: "not retrieved — the response states no licence over the image",
              attribution: null,
            },
          ] as FieldLicence[])
        : []),
    ],
    publishedAt: str(envelope.publish_date, 40),
    sourceVersion:
      revision === null
        ? null
        : `openlibrary-revision-${String(revision)}${modified ? ` (${modified})` : ""}`,
    metadata: {
      basis: "openlibrary-public-api",
      statement:
        "Open Library's public API serves catalogue metadata to anonymous callers within its documented rate limits. The bibliographic fields above are retained under that permission, which states no licence over carried prose or images.",
      documentation: "https://openlibrary.org/developers/api",
    },
    materials: [
      ...(description
        ? ([
            {
              material: "description",
              disposition: "withheld-no-rights-basis",
              licence: null,
              reason:
                "Publisher-supplied flap copy travels in the response under no stated licence; the catalogue's API permission covers metadata, not prose, so it is named here and never quoted.",
            },
          ] as RecordFacts["materials"])
        : []),
      ...(coverIds.length > 0
        ? ([
            {
              material: "cover-image",
              disposition: "not-retrieved",
              licence: null,
              reason:
                "Cover art travels in the response as an id under no stated licence of its own; it is named here as provenance, never fetched.",
            },
          ] as RecordFacts["materials"])
        : []),
      ...(linked.some((entry) => entry.label.startsWith("Linked"))
        ? ([
            {
              material: "linked-work",
              disposition: "not-retrieved",
              licence: null,
              reason:
                "Linked work and author pages stay leads to be read as their own records under the same permission, not URLs this read follows.",
            },
          ] as RecordFacts["materials"])
        : []),
    ],
  };
}

/**
 * Library of Congress: a `?fo=json` search response, read at its first
 * result. The search envelope is what the record route fetches, so the entry
 * — title, formats, access flag, thumbnail and item-page link — is the
 * record; the full item page behind the link is a later read, not this one.
 *
 * Observed live 2026-09-07: entries carry an access flag, an optional
 * thumbnail URL and an item-page link, and no per-entry licence string — the
 * item's own rights live on the item page this read does not fetch.
 */
function libraryOfCongressFacts(body: unknown): RecordFacts | null {
  const envelope = record(body);
  const results = list(envelope?.results);
  const first = record(results[0]);
  const title = str(first?.title, 400);
  const url = str(first?.url, 600);
  if (!first || !title || !url) return null;
  const image = str(first.image_url, 600);
  const access =
    first.access_restricted === true
      ? "access-restricted"
      : first.access_restricted === false
        ? "not access-restricted"
        : null;
  const linked: LinkedMaterial[] = [{ label: "Full item page (not retrieved)", url }];
  if (image) linked.push({ label: "Thumbnail image (not retrieved)", url: image });
  return {
    identity: pairs([
      ["Index", "loc.gov"],
      ["Entry", title],
      ["Item page", url],
      ["Identifier", str(first.id, 300)],
      ["Date", str(first.date, 60)],
      [
        "Subjects",
        list(first.subject)
          .filter((entry) => typeof entry === "string")
          .slice(0, 5)
          .join("; ") || null,
      ],
      [
        "Formats",
        list(first.original_format)
          .filter((entry) => typeof entry === "string")
          .join("; ") || null,
      ],
      ["Access", access],
    ]),
    dates: pairs([["Entry date", str(first.date, 60)]]),
    credited: [],
    linked,
    fieldLicences: [
      {
        fields: "Descriptive fields (title, subjects, formats, dates, access flag)",
        licence: "retained under the public JSON permission above",
        attribution: null,
      },
      ...(image
        ? ([
            {
              fields: "Thumbnail image",
              licence: "not retrieved — the search record states no licence over the image",
              attribution: null,
            },
          ] as FieldLicence[])
        : []),
      {
        fields: "Full item page",
        licence:
          "not retrieved — the item's own rights live on the item page this read does not fetch",
        attribution: null,
      },
    ],
    publishedAt: null,
    sourceVersion: null,
    metadata: {
      basis: "loc-json-api",
      statement:
        "loc.gov serves collection metadata as JSON to anonymous callers with no key, within rate limits. The descriptive fields above are retained under that permission; the Library notes its site text is U.S. Government Work, and rights in the underlying collection item are the item's own, not established by this search record.",
      documentation: "https://www.loc.gov/apis/json-and-yaml/",
    },
    materials: [
      ...(image
        ? ([
            {
              material: "cover-image",
              disposition: "not-retrieved",
              licence: null,
              reason:
                "The thumbnail travels in the search record under no stated licence of its own; it is named here as provenance, never fetched.",
            },
          ] as RecordFacts["materials"])
        : []),
      {
        material: "linked-work",
        disposition: "not-retrieved",
        licence: null,
        reason:
          "The full item page stays a lead to be read as its own record under the same permission, not a URL this read follows.",
      },
    ],
  };
}

/**
 * TVmaze: one person record, unwrapped from a people-search hit when needed,
 * with the cast credits an `embed=castcredits` read carries beside it.
 *
 * Observed live 2026-09-07: the API is keyless and its data is CC BY-SA 4.0
 * (attribution plus sharealike — the obligation travels in the retained
 * Rights section, credited to TVmaze via the catalogue page named above);
 * the portrait is hotlinkable per the docs but the response states no
 * licence over the image itself. A credit names a show and a character; it
 * never says what performing the role meant.
 */
function tvmazeFacts(body: unknown): RecordFacts | null {
  const unwrapped = Array.isArray(body)
    ? (record(record(body[0])?.person) ?? record(body[0]))
    : record(body);
  if (!unwrapped) return null;
  const envelope = unwrapped;
  const embeddedCast = list(record(envelope._embedded)?.cast);
  const page = str(envelope.url, 600);
  const selfHref = str(record(record(envelope._links)?.self)?.href, 600);
  const isShow = Boolean(
    embeddedCast.length > 0 || page?.includes("/shows/") || selfHref?.includes("/shows/"),
  );
  if (isShow) return tvmazeShowFacts(envelope, embeddedCast);
  return tvmazePersonFacts(envelope);
}

function tvmazeShowFacts(
  show: Record<string, unknown>,
  embeddedCast: unknown[],
): RecordFacts | null {
  const id = num(show.id);
  const name = str(show.name, 300);
  const page = str(show.url, 600);
  if (id === null || !name || !page || page.includes("tvmaze.com") === false) return null;
  const cast = embeddedCast.flatMap((entry) => {
    const raw = record(entry);
    const person = record(raw?.person);
    const character = record(raw?.character);
    const personName = str(person?.name, 200);
    const personUrl = str(person?.url, 600);
    const characterName = str(character?.name, 300);
    const characterUrl = str(character?.url, 600);
    if (!personName) return [];
    return [
      {
        personName,
        personUrl,
        characterName: characterName ?? "an unnamed role",
        characterUrl,
      },
    ];
  });
  const image = str(record(show.image)?.original, 600) ?? str(record(show.image)?.medium, 600);
  const linked: LinkedMaterial[] = [];
  for (const member of cast) {
    if (member.personUrl)
      linked.push({ label: `Credited person: ${member.personName}`, url: member.personUrl });
    if (member.characterUrl)
      linked.push({
        label: `Credited character: ${member.characterName}`,
        url: member.characterUrl,
      });
  }
  if (image) linked.push({ label: "Show image (not retrieved)", url: image });
  const updated = num(show.updated);
  return {
    identity: pairs([
      ["Index", "tvmaze.com"],
      ["Record", String(id)],
      ["Show", name],
      ["TVmaze page", page],
      ["Type", str(show.type, 80)],
      ["Language", str(show.language, 60)],
      ["Premiered", str(show.premiered, 40)],
      ["Ended", str(show.ended, 40)],
    ]),
    dates: pairs([
      ["Premiered", str(show.premiered, 40)],
      ["Ended", str(show.ended, 40)],
    ]),
    credited:
      cast.length > 0
        ? cast.map((member) => ({
            name: member.personName,
            role: `credited as ${member.characterName} on ${name}`,
            identifiers: member.personUrl ? [member.personUrl] : [page],
          }))
        : [
            {
              name,
              role: "catalogue show entry (no cast in this response)",
              identifiers: [page],
            },
          ],
    linked,
    fieldLicences: [
      {
        fields: "Catalogue fields (biography, credits, schedules)",
        licence: "retained under the CC BY-SA 4.0 permission above, with credit to TVmaze",
        attribution: "TVmaze, via the catalogue page named above",
      },
      ...(image
        ? ([
            {
              fields: "Show image",
              licence: "not retrieved — the response states no licence over the image itself",
              attribution: null,
            },
          ] as FieldLicence[])
        : []),
    ],
    publishedAt: null,
    sourceVersion: updated === null ? null : `tvmaze-updated-${String(updated)}`,
    metadata: {
      basis: "tvmaze-free-api",
      statement:
        "TVmaze API data is CC BY-SA 4.0: the catalogue fields above are retained with credit to TVmaze, and any reuse of them must share alike. Portrait and show images travel in the response under no stated licence of their own.",
      documentation: "https://www.tvmaze.com/api",
    },
    materials: [
      ...(image
        ? ([
            {
              material: "cover-image",
              disposition: "not-retrieved",
              licence: null,
              reason:
                "The show image travels in the response under no stated licence of its own; it is named here as provenance, never fetched.",
            },
          ] as RecordFacts["materials"])
        : []),
      ...(cast.length > 0
        ? ([
            {
              material: "linked-work",
              disposition: "not-retrieved",
              licence: null,
              reason:
                "Credited people and characters stay leads to be read as their own records under the same permission, not URLs this read follows.",
            },
          ] as RecordFacts["materials"])
        : []),
    ],
  };
}

function tvmazePersonFacts(envelope: Record<string, unknown>): RecordFacts | null {
  const person = record(envelope.person) ?? envelope;
  const id = num(person.id);
  const name = str(person.name, 200);
  const page = str(person.url, 600);
  if (id === null || !name || !page || page.includes("tvmaze.com") === false) return null;
  const credits = list(record(person._embedded)?.castcredits).flatMap((entry) => {
    const links = record(record(entry)?._links);
    const embedded = record(record(entry)?._embedded);
    const show = str(record(embedded?.show)?.name, 300);
    const character = str(record(embedded?.character)?.name, 300);
    if (!show && !character) return [];
    return [
      {
        show: show ?? "an unnamed show",
        character: character ?? "an unnamed role",
        showHref: str(record(links?.show)?.href, 600),
        characterHref: str(record(links?.character)?.href, 600),
      },
    ];
  });
  const image = str(record(person.image)?.original, 600) ?? str(record(person.image)?.medium, 600);
  const linked: LinkedMaterial[] = [];
  for (const credit of credits) {
    if (credit.showHref)
      linked.push({ label: `Credited show: ${credit.show}`, url: credit.showHref });
    if (credit.characterHref)
      linked.push({ label: `Credited character: ${credit.character}`, url: credit.characterHref });
  }
  if (image) linked.push({ label: "Portrait image (not retrieved)", url: image });
  const country = str(record(person.country)?.name, 120);
  const updated = num(person.updated);
  return {
    identity: pairs([
      ["Index", "tvmaze.com"],
      ["Record", String(id)],
      ["Name", name],
      ["TVmaze page", page],
      ["Birthday", str(person.birthday, 40)],
      ["Country", country],
      ["Gender", str(person.gender, 40)],
    ]),
    dates: pairs([
      ["Born", str(person.birthday, 40)],
      ["Died", str(person.deathday, 40)],
    ]),
    credited:
      credits.length > 0
        ? credits.map((credit) => ({
            name,
            role: `credited as ${credit.character} on ${credit.show}`,
            identifiers: [page],
          }))
        : [
            {
              name,
              role: "catalogue person entry (no credits in this response)",
              identifiers: [page],
            },
          ],
    linked,
    fieldLicences: [
      {
        fields: "Catalogue fields (biography, credits, schedules)",
        licence: "retained under the CC BY-SA 4.0 permission above, with credit to TVmaze",
        attribution: "TVmaze, via the catalogue page named above",
      },
      ...(image
        ? ([
            {
              fields: "Portrait image",
              licence: "not retrieved — the response states no licence over the image itself",
              attribution: null,
            },
          ] as FieldLicence[])
        : []),
    ],
    publishedAt: null,
    sourceVersion: updated === null ? null : `tvmaze-updated-${String(updated)}`,
    metadata: {
      basis: "tvmaze-free-api",
      statement:
        "TVmaze API data is CC BY-SA 4.0: the catalogue fields above are retained with credit to TVmaze, and any reuse of them must share alike. Portrait and show images travel in the response under no stated licence of their own.",
      documentation: "https://www.tvmaze.com/api",
    },
    materials: [
      ...(image
        ? ([
            {
              material: "cover-image",
              disposition: "not-retrieved",
              licence: null,
              reason:
                "The portrait travels in the response under no stated licence of its own; it is named here as provenance, never fetched.",
            },
          ] as RecordFacts["materials"])
        : []),
      ...(credits.length > 0
        ? ([
            {
              material: "linked-work",
              disposition: "not-retrieved",
              licence: null,
              reason:
                "Credited shows and characters stay leads to be read as their own records under the same permission, not URLs this read follows.",
            },
          ] as RecordFacts["materials"])
        : []),
    ],
  };
}
