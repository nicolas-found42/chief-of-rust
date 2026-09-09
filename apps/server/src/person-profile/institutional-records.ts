import type { PersonResearchFailureCode, PersonSourceRights } from "@chief-of-staff-demo/shared";

/**
 * Professional and institutional records, read as evidence rather than as
 * catalogue hits (issue #250).
 *
 * A federal provider registry or a trial registration proves an identifier
 * resolved. What a Profile can use is the record's own fields — who it names,
 * what dates it carries, and what publishing it public actually establishes —
 * kept apart from the generic JSON flattener that would otherwise carry the
 * whole body into retained text with no rights basis and no version.
 *
 * The attribution rule this ticket adds is stricter than participation: a
 * registry entry establishes that the named individual matched this record. It
 * does not establish that they are competent, credentialed, currently
 * available, or personally responsible for their organisation's output, so an
 * NPI record's "authorized official" of a hospital system, or a trial's
 * principal investigator of a multi-site study, is rendered with that limit
 * attached rather than as a demonstrated capability.
 *
 * Same-name records are held apart by the identity resolution that already
 * runs over every source (`PersonResearch.decideIdentity` in `research.ts`):
 * a record naming this person alongside no other corroborating signal is
 * attributed at reduced ("probable") confidence rather than merged into
 * confirmed fact, and a record naming this person alongside a conflicting
 * affiliation is rejected outright. That corroboration is read from
 * `namedIndividuals` below, each entry's own affiliation strings, never from
 * a trial's lead sponsor or responsible organization or an NPI's
 * organisation name: a record-level field is the record's, not the named
 * individual's, and cannot stand in for their own affiliation (review
 * finding on issue #250, PR #295). Nothing here repeats that resolution;
 * this module only renders what one matched record says.
 *
 * `affiliations` is `null`, distinct from `[]`, whenever a route's own shape
 * cannot state an affiliation for the person it names at all — an NPPES
 * individual (NPI-1) registration states a specialty and a practice
 * address, never an employer, and an NPI-2's "authorized official" is a
 * registration contact whose relationship to the organisation the record
 * never states either. Reusing the specialty description or the
 * organisation's own name as a stand-in affiliation was the review finding
 * this module now avoids: a Profile whose employer happened to equal a
 * medical specialty or the organisation's name was absorbed as a confident
 * match with nothing real corroborating it. Identity resolution reads a
 * `null` as "cannot corroborate or refute" and holds the match ambiguous
 * rather than either confirming or rejecting it (review finding on issue
 * #250, PR #295).
 */

/** The indexes whose records this module can render. */
const RENDERERS = ["npiregistry.cms.hhs.gov", "clinicaltrials.gov"] as const;

/**
 * The sentence every rendered record carries.
 *
 * Exported so a caller can assert the limit travels with the text instead of
 * pinning the wording, and so the wording lives in one place.
 */
export const MATCH_LIMIT =
  "Registry match only: this record establishes that the individual named matched the record, not that they are competent, credentialed, currently available, or personally responsible for their organisation's output.";

/** One person the record names, with whatever role the record itself gives them. */
interface NamedIndividual {
  name: string;
  /** How the record itself describes this person's relationship to it. */
  role: string;
  identifiers: string[];
  /**
   * This person's own affiliation strings, or `null` when the record's shape
   * cannot state one for them at all (a specialty is not an employer, and an
   * organisation's own name is not its authorized official's affiliation).
   * `null` is never collapsed to `[]`: the two mean different things to
   * identity resolution (see the module doc comment above).
   */
  affiliations: string[] | null;
}

/** A document a record links without granting rights over it. */
interface LinkedMaterial {
  label: string;
  url: string;
}

/** What one index's record says, before it becomes retained text. */
interface RecordFacts {
  identity: [string, string][];
  dates: [string, string][];
  named: NamedIndividual[];
  linked: LinkedMaterial[];
  publishedAt: string | null;
  sourceVersion: string | null;
  metadata: PersonSourceRights["metadata"];
}

export interface InstitutionalRecordRendering {
  text: string;
  publishedAt: string | null;
  sourceVersion: string | null;
  rights: PersonSourceRights;
  provenanceNote: string;
  anchors: { kind: "section"; value: string; offset: number }[];
  /**
   * Always empty. A trial's linked protocol, statistical analysis plan or
   * consent form is recorded provenance — named in the "Linked material" text
   * section and in `rights.materials` — never a URL here: `outboundUrls` is
   * exactly what `PersonResearch` turns into an automatically-read lead (once
   * directly, for a feed, and once when a model attributes a "work" to one of
   * them), and a linked document has to stay unread under this record's
   * metadata-only permission until something reads it under its own rights
   * (review finding on issue #250, PR #295).
   */
  outboundUrls: string[];
  /**
   * Every individual this record names, by name, with only their own
   * affiliation strings — a trial's lead sponsor and responsible
   * organization, and an NPPES organization's own name, are record-level and
   * deliberately excluded. Identity resolution reads this instead of
   * searching the whole rendered text for a known employer, so a trial
   * sponsored by the Profile's employer cannot corroborate a same-name
   * investigator whose own affiliation conflicts (review finding on issue
   * #250, PR #295). An entry's `affiliations` is `null`, distinct from `[]`,
   * when this record's shape cannot state one for that person at all (an
   * NPPES specialty or an organisation's own name is never a stand-in): a
   * `null` reads to identity resolution as "cannot corroborate or refute",
   * never as a stated absence of affiliation to compare against.
   */
  namedIndividuals: { name: string; affiliations: string[] | null }[];
}

/**
 * Whether a retained source is a professional or institutional record.
 *
 * Both halves matter: the record reader is what produced field lines rather
 * than a page, and the upstream index is what says those lines are a
 * registry or registration record rather than a publication or a museum one.
 */
export function isInstitutionalRecordRead(read: {
  acquisition: string;
  upstreamIndex?: string | null | undefined;
}): boolean {
  return (
    read.acquisition === "record-reader" &&
    RENDERERS.includes((read.upstreamIndex ?? "") as (typeof RENDERERS)[number])
  );
}

/** Render one index's record, or nothing when the body is not one. */
export function renderInstitutionalRecord(
  index: string,
  body: unknown,
): InstitutionalRecordRendering | null {
  const facts =
    index === "npiregistry.cms.hhs.gov"
      ? nppesFacts(body)
      : index === "clinicaltrials.gov"
        ? clinicalTrialsFacts(body)
        : null;
  return facts ? assemble(index, facts) : null;
}

/**
 * Whether one of this module's two indexes answered with a body that, by
 * that index's own conventions, is not a record and never becomes one, and
 * the failure code its read takes: a refusal envelope is the index
 * declining to serve (`registry-error-envelope`); NPPES's empty result set
 * is a fact about coverage (`resource-unavailable`).
 *
 * Deliberately narrower than "the renderer returned null": a body the
 * renderer cannot fully read — a record whose shape outgrew the facts
 * readers, or an unrelated JSON document the endpoint served — stays with
 * the generic flattener, the normal retention path for records this module
 * has not grown into (#249, #250). Only an answer the index's own
 * conventions define as a non-record is refused here, and its text is
 * never retained: such an envelope can echo the requested name, and no
 * rights basis, version or attribution would cover it (review finding on
 * issue #250, PR #295).
 */
export function registryNonRecordBody(
  index: string,
  body: unknown,
): PersonResearchFailureCode | null {
  if (index !== "npiregistry.cms.hhs.gov" && index !== "clinicaltrials.gov") return null;
  const envelope = record(body);
  if (!envelope) return null;
  /* Both indexes answer refusals and API errors under a top-level error
     key — ClinicalTrials.gov nests its message under `error`; NPPES
     documents its invalid-parameter envelope with a capitalized `Errors`
     key (observed live 2026-09-07: {"Errors":[{"description":"No valid
     search criteria provided","field":"generic","number":"04"}]}). A record
     of either index never carries one. */
  if ("error" in envelope || "errors" in envelope || "Errors" in envelope)
    return "registry-error-envelope";
  /* NPPES's answer for an identifier it does not register: the envelope is
     present and says it holds nothing. */
  if (index === "npiregistry.cms.hhs.gov" && Array.isArray(envelope.results))
    return envelope.results.length === 0 ? "resource-unavailable" : null;
  return null;
}

/* ------------------------------------------------------------------ */
/* Assembly                                                             */
/* ------------------------------------------------------------------ */

function assemble(index: string, facts: RecordFacts): InstitutionalRecordRendering {
  /* Linked documents (a trial's protocol, statistical analysis plan or
     consent form) are never fetched under a registry's metadata permission —
     each stays a lead, read under whatever its own route establishes. */
  const materials: PersonSourceRights["materials"] = facts.linked.map(() => ({
    material: "linked-document",
    disposition: "not-retrieved",
    licence: null,
    reason:
      "Linked documents are not retrieved under this record's metadata permission; they stay a lead to be read under their own rights.",
  }));
  const rights: PersonSourceRights = { metadata: facts.metadata, declared: [], materials };

  const sections: [string, string[]][] = [
    ["Record identity", facts.identity.map(([label, value]) => `${label}: ${value}`)],
    ["Dates", facts.dates.map(([label, value]) => `${label}: ${value}`)],
    [
      "Named individuals",
      [
        ...facts.named.map(
          (entry) =>
            `${entry.name} — ${entry.role}; ${
              entry.identifiers.length
                ? entry.identifiers.join(", ")
                : "no identifier in this record"
            }; ${
              entry.affiliations?.length
                ? entry.affiliations.join("; ")
                : "no affiliation in this record"
            }`,
        ),
        MATCH_LIMIT,
      ],
    ],
    [
      "Rights",
      [
        `Metadata: ${rights.metadata.statement} (${rights.metadata.documentation})`,
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

  const anchors: InstitutionalRecordRendering["anchors"] = [];
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
    provenanceNote: `Professional or institutional record from ${index}, rendered from its metadata fields. ${MATCH_LIMIT}`,
    anchors,
    /* A linked document is recorded above, in "Linked material" and in
       `rights.materials`; it never becomes an outbound URL. `outboundUrls` is
       what PersonResearch turns into a URL lead it reads automatically, and
       a protocol, statistical analysis plan or consent form must stay
       unread under this record's metadata-only permission (review finding
       on issue #250, PR #295). */
    outboundUrls: [],
    namedIndividuals: facts.named.map((entry) => ({
      name: entry.name,
      affiliations: entry.affiliations,
    })),
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

/**
 * NPPES: the US registry of individual and organizational healthcare
 * providers, read by exact NPI number (`RECORD_ROUTES` builds the
 * `number=` lookup, so `results` holds at most one entry).
 *
 * An individual (NPI-1) record names the provider directly. An organizational
 * (NPI-2) record names no clinician at all — its one named person is the
 * "authorized official", a registration contact the registry requires every
 * organization to name. Rendering that as a demonstrated clinical role would
 * be exactly the overclaim this ticket forbids, so the role line says what
 * the record actually calls them.
 */
function nppesFacts(body: unknown): RecordFacts | null {
  const first = record(list(record(body)?.results)[0]);
  const number = str(first?.number, 20);
  const basic = record(first?.basic);
  if (!first || !number || !basic) return null;
  const isOrganization = str(first.enumeration_type, 10) === "NPI-2";
  const taxonomies = list(first.taxonomies);
  const primary =
    record(taxonomies.find((entry) => record(entry)?.primary === true)) ?? record(taxonomies[0]);
  const status = str(basic.status, 5);
  const statusLabel =
    status === "A" ? "active" : status === "D" ? "deactivated" : status ? `code ${status}` : null;

  const subjectName = isOrganization
    ? str(basic.organization_name, 200)
    : [
        str(basic.name_prefix, 20),
        str(basic.first_name, 120),
        str(basic.middle_name, 120),
        str(basic.last_name, 120),
        str(basic.name_suffix, 20),
      ]
        .filter(Boolean)
        .join(" ") || null;
  if (!subjectName) return null;

  const named: NamedIndividual[] = [];
  if (!isOrganization) {
    named.push({
      name: subjectName,
      role: `Individual healthcare provider registered under NPI ${number}${
        statusLabel ? ` (registration ${statusLabel})` : ""
      }.`,
      identifiers: [`NPI ${number}`],
      /* NPPES states this provider's specialty (taxonomy) and practice
         address, never an employer — the specialty is rendered separately
         as "Primary taxonomy" below. Reusing it here would let a Profile
         whose employer happens to equal a medical specialty ("Internal
         Medicine") corroborate a same-name match that shares nothing real
         with them (review finding on issue #250, PR #295), so this record
         states no affiliation for its named individual at all. */
      affiliations: null,
    });
  } else {
    const officialName = [
      str(basic.authorized_official_first_name, 120),
      str(basic.authorized_official_last_name, 120),
    ]
      .filter(Boolean)
      .join(" ");
    if (officialName)
      named.push({
        name: officialName,
        role: `Authorized official (${
          str(basic.authorized_official_title_or_position, 120) ?? "title not stated in this record"
        }) named on this organization's registration, NPI ${number}.`,
        identifiers: [],
        /* The organization's own name is a record-level fact — this
           registration's subject, not the authorized official's stated
           affiliation. NPPES never says what the official's own employer
           is (most are the organization, but the record does not say so),
           so reusing the organization name here would let a Profile whose
           employer happens to equal it corroborate a same-name match with
           nothing real behind it (review finding on issue #250, PR #295).
           This record states no affiliation for its named official. */
        affiliations: null,
      });
  }

  const otherNames = list(first.other_names).flatMap((entry) => {
    const other = record(entry);
    const name = [
      str(other?.first_name, 120),
      str(other?.middle_name, 120),
      str(other?.last_name, 120),
    ]
      .filter(Boolean)
      .join(" ");
    return name ? [name] : [];
  });

  return {
    identity: pairs([
      ["Index", "npiregistry.cms.hhs.gov"],
      ["NPI", number],
      ["Registrant type", isOrganization ? "Organization (NPI-2)" : "Individual (NPI-1)"],
      [isOrganization ? "Organization name" : "Name", subjectName],
      ["Credential", str(basic.credential, 60)],
      ["Registration status", statusLabel],
      [
        "Primary taxonomy",
        primary
          ? `${str(primary.desc, 200) ?? "unnamed taxonomy"}${
              str(primary.license, 60)
                ? ` (license ${str(primary.license, 60)}${
                    str(primary.state, 10) ? `, ${str(primary.state, 10)}` : ""
                  })`
                : ""
            }`
          : null,
      ],
      ["Also known as", otherNames.length ? otherNames.join("; ") : null],
    ]),
    dates: pairs([
      ["Enumerated", str(basic.enumeration_date, 40)],
      ["Certified", str(basic.certification_date, 40)],
      ["Deactivated", str(basic.deactivation_date, 40)],
      ["Last updated", str(basic.last_updated, 40)],
    ]),
    named,
    linked: [],
    publishedAt: str(basic.enumeration_date, 40),
    sourceVersion: (() => {
      const updated = str(basic.last_updated, 40);
      return updated ? `NPPES last updated ${updated}` : null;
    })(),
    metadata: {
      basis: "nppes-public-registry",
      statement:
        "The NPPES NPI Registry publishes provider records for public dissemination; the API is public and needs no key. An NPI record does not validate the licensure, credentials, or clinical competence of the person or organization it names.",
      documentation: "https://npiregistry.cms.hhs.gov/api-page",
    },
  };
}

const OFFICIAL_ROLE_LABELS: Record<string, string> = {
  PRINCIPAL_INVESTIGATOR: "Principal investigator",
  STUDY_CHAIR: "Study chair",
  STUDY_DIRECTOR: "Study director",
};

/**
 * ClinicalTrials.gov: a trial's own registration, read by NCT ID.
 *
 * Its overall officials and central contacts are the only individuals a
 * trial record names, each with the role the record itself gives them
 * (principal investigator, study chair, a contact's phone and email). A
 * trial's linked protocol, statistical analysis plan and consent form carry
 * their own rights and are never retrieved here; they are recorded as leads
 * with the address the registry's own document convention builds.
 */
function clinicalTrialsFacts(body: unknown): RecordFacts | null {
  const protocol = record(record(body)?.protocolSection);
  const identification = record(protocol?.identificationModule);
  const nctId = str(identification?.nctId, 20);
  if (!protocol || !identification || !nctId) return null;
  const status = record(protocol.statusModule);
  const sponsor = record(protocol.sponsorCollaboratorsModule);
  const leadSponsor = record(sponsor?.leadSponsor);
  const organization = record(identification.organization);
  const contacts = record(protocol.contactsLocationsModule);

  const named: NamedIndividual[] = [
    ...list(contacts?.overallOfficials).map((entry) => {
      const official = record(entry);
      const role = str(official?.role, 60);
      /* Present when this trial's own registration states this official's
         affiliation; `null` (never `[]`) when it does not, so identity
         resolution can tell "this record says nothing about their
         affiliation" apart from "we checked and it does not match". */
      const affiliation = str(official?.affiliation, 200);
      return {
        name: str(official?.name, 200) ?? "Unnamed official",
        role: `${role ? (OFFICIAL_ROLE_LABELS[role] ?? role) : "Overall official"} of this trial.`,
        identifiers: [],
        affiliations: affiliation ? [affiliation] : null,
      };
    }),
    ...list(contacts?.centralContacts).map((entry) => {
      const contact = record(entry);
      return {
        name: str(contact?.name, 200) ?? "Unnamed contact",
        role: "Central contact listed for this trial.",
        identifiers: [str(contact?.email, 200), str(contact?.phone, 60)].flatMap((value) =>
          value ? [value] : [],
        ),
        /* ClinicalTrials.gov never carries an affiliation for a central
           contact at all — this is not "checked and empty", it is
           unstated. */
        affiliations: null,
      };
    }),
  ];

  /* Provided documents are named by filename, and the registry serves them
     at a fixed path keyed on the last two digits of the NCT ID — the same
     address a person reading the study page would follow. */
  const largeDocs = list(
    record(record(record(body)?.documentSection)?.largeDocumentModule)?.largeDocs,
  );
  const linked: LinkedMaterial[] = largeDocs.flatMap((entry) => {
    const doc = record(entry);
    const filename = str(doc?.filename, 200);
    if (!filename) return [];
    return [
      {
        label: str(doc?.label, 120) ?? filename,
        url: `https://clinicaltrials.gov/ProvidedDocs/${nctId.slice(-2)}/${nctId}/${encodeURIComponent(filename)}`,
      },
    ];
  });

  return {
    identity: pairs([
      ["Index", "clinicaltrials.gov"],
      ["NCT ID", nctId],
      ["Brief title", str(identification.briefTitle, 400)],
      ["Official title", str(identification.officialTitle, 600)],
      [
        "Lead sponsor",
        leadSponsor
          ? `${str(leadSponsor.name, 200) ?? "unnamed sponsor"}${
              str(leadSponsor.class, 40) ? ` (${str(leadSponsor.class, 40)})` : ""
            }`
          : null,
      ],
      [
        "Responsible organization",
        organization
          ? `${str(organization.fullName, 200) ?? "unnamed organization"}${
              str(organization.class, 40) ? ` (${str(organization.class, 40)})` : ""
            }`
          : null,
      ],
      ["Overall status", str(status?.overallStatus, 60)],
    ]),
    dates: pairs([
      ["First posted", str(record(status?.studyFirstPostDateStruct)?.date, 40)],
      ["Start", str(record(status?.startDateStruct)?.date, 40)],
      ["Completed", str(record(status?.completionDateStruct)?.date, 40)],
      ["Last update posted", str(record(status?.lastUpdatePostDateStruct)?.date, 40)],
    ]),
    named,
    linked,
    publishedAt: str(record(status?.studyFirstPostDateStruct)?.date, 40),
    sourceVersion: (() => {
      const updated = str(record(status?.lastUpdatePostDateStruct)?.date, 40);
      return updated ? `clinicaltrials.gov record last updated ${updated}` : null;
    })(),
    metadata: {
      basis: "clinicaltrials-public-api",
      statement:
        "ClinicalTrials.gov API v2 is public and unauthenticated; the registry publishes study records for public access. A trial record establishes that the named individual is listed in this role for this trial; it does not establish personal responsibility for the trial's conduct or results.",
      documentation: "https://clinicaltrials.gov/data-api/api",
    },
  };
}
