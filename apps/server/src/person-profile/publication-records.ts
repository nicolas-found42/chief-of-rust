import type { PersonSourceRights } from "@chief-of-staff-demo/shared";

/**
 * Publication and deposit records, read as evidence rather than as catalogue
 * hits (issue #249).
 *
 * Locating a DOI proves an index answered. What a Profile can use is a
 * quotable record that keeps three things the generic JSON flattener loses:
 * the record's dates and the upstream's own version of it, the permission each
 * material was retained under, and the fact that being named in a record is
 * participation and nothing more. Two limits are structural rather than
 * cautious phrasing, and both are enforced below:
 *
 * - A metadata permission covers the metadata. An abstract travelling inside
 *   the same response, and the full text the record links to, need their own
 *   rights basis, so an abstract is retained only where the record declares a
 *   licence over the deposited resource itself, and linked full text is never
 *   fetched under the metadata permission — the record names it as provenance
 *   for a later read under its own rights, never as a URL this loop follows.
 * - A person's appearance in a record establishes that they took part in the
 *   work. It does not establish what they personally did, so the rendering
 *   says so and the extraction path drops personal-scope fields that rest on
 *   a record alone.
 */

/** The indexes whose records this module can render. */
const RENDERERS = ["crossref.org", "datacite.org", "openalex.org"] as const;

/**
 * The sentence every rendered record carries.
 *
 * It is exported so a caller can assert the limit travels with the text
 * instead of pinning the wording, and so the wording lives in one place.
 */
export const PARTICIPATION_LIMIT =
  "Participation only: this record establishes that the people named took part in the work it describes, not the scope of any individual's contribution.";

/** One person named in a record, with whatever the record uses to identify them. */
interface Participant {
  name: string;
  /** Where the record places them, as the record itself counts: "author 1 of 9". */
  position: string;
  identifiers: string[];
  affiliations: string[];
}

/** What one index's record says, before it becomes retained text. */
interface RecordFacts {
  identity: [string, string][];
  dates: [string, string][];
  participants: Participant[];
  abstract: string | null;
  /** Why an abstract could not be quoted at all, when the format hides it. */
  abstractNote: string | null;
  declared: PersonSourceRights["declared"];
  linked: string[];
  publishedAt: string | null;
  sourceVersion: string | null;
  metadata: PersonSourceRights["metadata"];
}

export interface PublicationRecordRendering {
  text: string;
  publishedAt: string | null;
  sourceVersion: string | null;
  rights: PersonSourceRights;
  provenanceNote: string;
  anchors: { kind: "section"; value: string; offset: number }[];
  /**
   * Always empty. The full text and landing pages a record links to are
   * recorded provenance — named in the "Linked material" text section and in
   * `rights.materials` — never a URL here: `outboundUrls` is exactly what
   * `PersonResearch` turns into an automatically-read lead (once directly,
   * for a feed, and once when a model attributes a "work" to one of them),
   * and linked full text has to stay unread under this record's metadata
   * permission until something reads it under its own rights (#249; the same
   * review finding as the sibling record module, PR #295).
   */
  outboundUrls: string[];
}

/**
 * Whether a retained source is a publication or deposit record.
 *
 * Both halves matter: the record reader is what produced field lines rather
 * than a page, and the upstream index is what says those lines are a
 * publication or deposit record rather than a museum or registry record.
 */
export function isPublicationRecordRead(read: {
  acquisition: string;
  upstreamIndex?: string | null | undefined;
}): boolean {
  return (
    read.acquisition === "record-reader" &&
    RENDERERS.includes((read.upstreamIndex ?? "") as (typeof RENDERERS)[number])
  );
}

/** Render one index's record, or nothing when the body is not one. */
export function renderPublicationRecord(
  index: string,
  body: unknown,
): PublicationRecordRendering | null {
  const facts =
    index === "crossref.org"
      ? crossrefFacts(body)
      : index === "datacite.org"
        ? dataciteFacts(body)
        : index === "openalex.org"
          ? openalexFacts(body)
          : null;
  return facts ? assemble(index, facts) : null;
}

/* ------------------------------------------------------------------ */
/* Assembly                                                             */
/* ------------------------------------------------------------------ */

function assemble(index: string, facts: RecordFacts): PublicationRecordRendering {
  /* A licence over the deposited resource is the only basis in a record for
     quoting its abstract: a licence over the version of record covers the
     published article, and the index's metadata permission covers neither. */
  const resourceLicence = facts.declared.find(
    (entry) => entry.material === "deposited-resource",
  )?.statement;
  const materials: PersonSourceRights["materials"] = [];
  if (facts.abstract !== null || facts.abstractNote !== null)
    materials.push(
      facts.abstract !== null && resourceLicence
        ? {
            material: "abstract",
            disposition: "retained-under-declared-licence",
            licence: resourceLicence,
            reason: "The record declares this licence over the deposited resource itself.",
          }
        : {
            material: "abstract",
            disposition: "withheld-no-rights-basis",
            licence: null,
            reason:
              facts.abstractNote ??
              "The index's metadata permission does not extend to the abstract, and the record declares no licence over the resource.",
          },
    );
  if (facts.linked.length > 0)
    materials.push({
      material: "full-text",
      disposition: "not-retrieved",
      licence: facts.declared.find((entry) => entry.material === "full-text")?.statement ?? null,
      reason:
        "Linked full text is not retrieved under a metadata permission; it is named here as provenance for a later read under its own rights, not offered as a URL to follow.",
    });
  const rights: PersonSourceRights = {
    metadata: facts.metadata,
    declared: facts.declared,
    materials,
  };

  const sections: [string, string[]][] = [
    ["Record identity", facts.identity.map(([label, value]) => `${label}: ${value}`)],
    ["Dates", facts.dates.map(([label, value]) => `${label}: ${value}`)],
    [
      "Participation",
      [
        ...facts.participants.map(
          (participant) =>
            `${participant.name} — ${participant.position}; ${
              participant.identifiers.length
                ? participant.identifiers.join(", ")
                : "no identifier in this record"
            }; ${
              participant.affiliations.length
                ? participant.affiliations.join("; ")
                : "no affiliation in this record"
            }`,
        ),
        PARTICIPATION_LIMIT,
      ],
    ],
    [
      "Rights",
      [
        `Metadata: ${rights.metadata.statement} (${rights.metadata.documentation})`,
        ...rights.declared.map(
          (entry) =>
            `Declared licence for the ${entry.material}: ${entry.statement}${
              entry.url ? ` (${entry.url})` : ""
            }${entry.appliesFrom ? `, from ${entry.appliesFrom}` : ""}`,
        ),
        ...rights.materials.map(
          (entry) => `${entry.material}: ${entry.disposition} — ${entry.reason}`,
        ),
      ],
    ],
    ...(facts.abstract !== null && resourceLicence
      ? ([["Abstract", [facts.abstract]]] as [string, string[]][])
      : []),
    ...(facts.linked.length > 0
      ? ([["Linked material", facts.linked]] as [string, string[]][])
      : []),
  ];

  const anchors: PublicationRecordRendering["anchors"] = [];
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
    provenanceNote: `Publication or deposit record from ${index}, rendered from its metadata fields. ${PARTICIPATION_LIMIT}`,
    anchors,
    /* A linked resource is recorded above, in "Linked material" and in
       `rights.materials`; it never becomes an outbound URL. `outboundUrls` is
       what PersonResearch turns into a URL lead it reads automatically, and
       full text or a landing page must stay unread under this record's
       metadata permission (#249; the same review finding as the sibling
       record module, PR #295). */
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

function pairs(entries: [string, string | null][]): [string, string][] {
  return entries.flatMap(([label, value]) => (value ? [[label, value] as [string, string]] : []));
}

/** A Crossref date-parts triple as an ISO day, when the record gives one. */
function dateParts(value: unknown): string | null {
  const parts = list(record(value)?.["date-parts"])[0];
  const numbers = list(parts).filter((part): part is number => typeof part === "number");
  if (numbers.length === 0) return null;
  const [year, month, day] = numbers;
  return [
    String(year).padStart(4, "0"),
    ...(month === undefined ? [] : [String(month).padStart(2, "0")]),
    ...(day === undefined ? [] : [String(day).padStart(2, "0")]),
  ].join("-");
}

/** JATS markup travels in Crossref abstracts; the text is what a reader quotes. */
function plain(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function crossrefFacts(body: unknown): RecordFacts | null {
  const message = record(record(body)?.message);
  const doi = str(message?.DOI, 200);
  if (!message || !doi) return null;
  const authors = list(message.author);
  const abstract = str(message.abstract, 20_000);
  return {
    identity: pairs([
      ["Index", "crossref.org"],
      ["DOI", doi],
      ["Type", str(message.type, 80)],
      ["Title", str(list(message.title)[0])],
      ["Container", str(list(message["container-title"])[0])],
      ["Publisher", str(message.publisher)],
    ]),
    dates: pairs([
      ["Issued", dateParts(message.issued)],
      ["Deposited with the index", str(record(message.deposited)?.["date-time"], 60)],
      ["Record indexed", str(record(message.indexed)?.["date-time"], 60)],
    ]),
    participants: authors.map((entry, position) => {
      const author = record(entry);
      const name = [str(author?.given, 120), str(author?.family, 120)].filter(Boolean).join(" ");
      const sequence = str(author?.sequence, 40);
      return {
        name: name || (str(author?.name, 200) ?? "Unnamed contributor"),
        position: `author ${String(position + 1)} of ${String(authors.length)}${
          sequence ? `, listed ${sequence}` : ""
        }`,
        identifiers: [str(author?.ORCID, 200)].flatMap((value) => (value ? [value] : [])),
        affiliations: list(author?.affiliation).flatMap((affiliation) => {
          const name = str(record(affiliation)?.name);
          return name ? [name] : [];
        }),
      };
    }),
    abstract: abstract ? plain(abstract) : null,
    abstractNote: null,
    declared: list(message.license).flatMap((entry) => {
      const licence = record(entry);
      const url = str(licence?.URL, 600);
      if (!url) return [];
      const version = str(licence?.["content-version"], 40);
      return [
        {
          material: "full-text" as const,
          statement: version ? `${url} (${version})` : url,
          url,
          appliesFrom: str(record(licence?.start)?.["date-time"], 40),
        },
      ];
    }),
    linked: [
      ...list(message.link).flatMap((entry) => {
        const url = str(record(entry)?.URL, 600);
        return url ? [url] : [];
      }),
      ...(str(message.URL, 600) ? [str(message.URL, 600)!] : []),
    ],
    publishedAt: dateParts(message.issued) ?? dateParts(message.published),
    sourceVersion: (() => {
      const indexed = record(message.indexed);
      const stamp = str(indexed?.["date-time"], 60);
      const version = str(indexed?.version, 80);
      return stamp || version
        ? `crossref indexed ${stamp ?? "at an unstated time"}${version ? ` (${version})` : ""}`
        : null;
    })(),
    metadata: {
      basis: "crossref-rest-metadata",
      statement:
        "No sign-up is required to use the REST API, and almost none of the metadata is subject to copyright; abstracts may be subject to publisher or author copyright.",
      documentation: "https://www.crossref.org/documentation/retrieve-metadata/rest-api/",
    },
  };
}

function dataciteFacts(body: unknown): RecordFacts | null {
  const attributes = record(record(record(body)?.data)?.attributes);
  const doi = str(attributes?.doi, 200);
  if (!attributes || !doi) return null;
  const creators = list(attributes.creators);
  const abstract = list(attributes.descriptions).flatMap((entry) => {
    const description = record(entry);
    return str(description?.descriptionType, 40) === "Abstract"
      ? [str(description?.description, 20_000) ?? ""]
      : [];
  })[0];
  const year = attributes.publicationYear;
  const issued =
    list(attributes.dates).flatMap((entry) => {
      const date = record(entry);
      return str(date?.dateType, 40) === "Issued" ? [str(date?.date, 40) ?? ""] : [];
    })[0] ?? (typeof year === "number" ? String(year) : null);
  return {
    identity: pairs([
      ["Index", "datacite.org"],
      ["DOI", doi],
      ["Type", str(record(attributes.types)?.resourceTypeGeneral, 80)],
      ["Title", str(record(list(attributes.titles)[0])?.title)],
      ["Publisher", str(attributes.publisher)],
    ]),
    dates: pairs([
      ["Issued", issued],
      ["Registered", str(attributes.registered, 60)],
      ["Record updated", str(attributes.updated, 60)],
    ]),
    participants: creators.map((entry, position) => {
      const creator = record(entry);
      /* DataCite creators are catalogued as "Family, Given", which is the same
         person written in an order no other source uses. Where the record
         carries the parts separately, they are rendered in reading order: it
         is the record's own data, and identity matching downstream compares a
         retained line against a Profile's name rather than a catalogue key. */
      const parts = [str(creator?.givenName, 120), str(creator?.familyName, 120)].filter(Boolean);
      return {
        name: parts.length === 2 ? parts.join(" ") : (str(creator?.name, 200) ?? "Unnamed creator"),
        position: `creator ${String(position + 1)} of ${String(creators.length)}`,
        identifiers: list(creator?.nameIdentifiers).flatMap((identifier) => {
          const value = str(record(identifier)?.nameIdentifier, 200);
          return value ? [value] : [];
        }),
        affiliations: list(creator?.affiliation).flatMap((affiliation) => {
          const name = str(affiliation, 200) ?? str(record(affiliation)?.name, 200);
          return name ? [name] : [];
        }),
      };
    }),
    abstract: abstract ? plain(abstract) : null,
    abstractNote: null,
    declared: list(attributes.rightsList).flatMap((entry) => {
      const rights = record(entry);
      const statement = str(rights?.rights, 300);
      if (!statement) return [];
      return [
        {
          material: "deposited-resource" as const,
          statement,
          url: str(rights?.rightsUri, 600),
          appliesFrom: null,
        },
      ];
    }),
    linked: [
      ...(str(attributes.url, 600) ? [str(attributes.url, 600)!] : []),
      ...list(attributes.contentUrl).flatMap((entry) => {
        const url = str(entry, 600);
        return url ? [url] : [];
      }),
    ],
    publishedAt: issued,
    sourceVersion: (() => {
      const updated = str(attributes.updated, 60);
      const metadataVersion = attributes.metadataVersion;
      return updated
        ? `datacite updated ${updated}${
            typeof metadataVersion === "number"
              ? ` (metadata version ${String(metadataVersion)})`
              : ""
          }`
        : null;
    })(),
    metadata: {
      basis: "datacite-data-file-cc0",
      statement:
        "DataCite waives its rights in the Data File — the DOIs and deposited metadata — under CC0; the waiver reaches neither the linked resources nor the privacy and publicity rights of the individuals described.",
      documentation: "https://support.datacite.org/docs/datacite-data-file-use-policy",
    },
  };
}

function openalexFacts(body: unknown): RecordFacts | null {
  const work = record(body);
  const id = str(work?.id, 200);
  if (!work || !id) return null;
  const authorships = list(work.authorships);
  const primary = record(work.primary_location);
  const licence = str(primary?.license, 200);
  return {
    identity: pairs([
      ["Index", "openalex.org"],
      ["OpenAlex ID", id],
      ["DOI", str(work.doi, 200)],
      ["Type", str(work.type, 80)],
      ["Title", str(work.title) ?? str(work.display_name)],
      ["Source", str(record(primary?.source)?.display_name)],
    ]),
    dates: pairs([
      ["Published", str(work.publication_date, 40)],
      ["Record created", str(work.created_date, 60)],
      ["Record updated", str(work.updated_date, 60)],
    ]),
    participants: authorships.map((entry, position) => {
      const authorship = record(entry);
      const author = record(authorship?.author);
      const listed = str(authorship?.author_position, 40);
      return {
        name: str(author?.display_name, 200) ?? "Unnamed author",
        position: `author ${String(position + 1)} of ${String(authorships.length)}${
          listed ? `, listed ${listed}` : ""
        }`,
        identifiers: [str(author?.orcid, 200)].flatMap((value) => (value ? [value] : [])),
        affiliations: list(authorship?.institutions).flatMap((institution) => {
          const name = str(record(institution)?.display_name, 200);
          return name ? [name] : [];
        }),
      };
    }),
    /* OpenAlex ships the abstract as an inverted index precisely so that the
       text is not redistributed as text. Reconstructing it here would defeat
       that, so the record carries the fact that an abstract exists and the
       reason it is not quoted. */
    abstract: null,
    abstractNote:
      record(work.abstract_inverted_index) === null
        ? null
        : "The record carries the abstract only as an inverted index, which is not reconstructed into retained text.",
    declared: licence
      ? [
          {
            /* OpenAlex names the licence with its own identifier ("cc-by") and
               publishes no URL for the licence document. The landing page is
               where the work lives, not where its terms are stated, so the
               licence URL stays null rather than pointing a reader at a page
               that does not substantiate it. */
            material: "full-text" as const,
            statement: licence,
            url: null,
            appliesFrom: null,
          },
        ]
      : [],
    linked: [str(primary?.landing_page_url, 600), str(primary?.pdf_url, 600)].flatMap((url) =>
      url ? [url] : [],
    ),
    publishedAt: str(work.publication_date, 40),
    sourceVersion: (() => {
      const updated = str(work.updated_date, 60);
      return updated ? `openalex updated ${updated}` : null;
    })(),
    metadata: {
      basis: "openalex-cc0",
      statement:
        "Basic API use is free with no key, and the data are CC0; a key or a paid plan buys a larger daily budget and is not used here.",
      documentation: "https://help.openalex.org/api/authentication/",
    },
  };
}
