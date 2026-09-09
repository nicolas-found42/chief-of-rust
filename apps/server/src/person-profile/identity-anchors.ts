import type { PersonSourceRights } from "@chief-of-staff-demo/shared";

/**
 * Identity and affiliation registry records, read as an anchor rather than as
 * an accomplishment list (issue #252).
 *
 * A registry entry — an ORCID iD, an NPI, a ROR record — establishes one
 * thing: that this identifier belongs to this person. It is the strongest
 * available basis for deciding identity before any fact is attributed, so it
 * is rendered field by field and kept traceable to the record's own version,
 * exactly as a publication or deposit record is (`publication-records.ts`).
 *
 * The limit is structural, not cautious phrasing, and is enforced below: a
 * registry record commonly links further activity — ORCID's own claimed
 * works, employments and fundings — and none of that linked activity becomes
 * retained fact text here. Registry membership is not accomplishment; a
 * linked work is retained as a lead, to be read and attributed under its own
 * evidence document, never asserted from the identity record that merely
 * names it.
 */

/** The indexes whose records this module can render. */
const RENDERERS = ["orcid.org"] as const;

export const REGISTRY_MEMBERSHIP_LIMIT =
  "Registry membership only: this record establishes that the identifier above belongs to the person named, not that every activity or work the registry links to it belongs to them as a verified personal accomplishment.";

/** One affiliation the record names, in the record's own words. */
interface Affiliation {
  organization: string;
  role: string | null;
  department: string | null;
  start: string | null;
  end: string | null;
}

/** What one index's identity record says, before it becomes retained text. */
interface AnchorFacts {
  identity: [string, string][];
  otherNames: string[];
  externalIdentifiers: [string, string][];
  affiliations: Affiliation[];
  /** Linked activity the record claims — never rendered as fact text. */
  linkedActivityCount: number;
  linked: string[];
  sourceVersion: string | null;
  metadata: PersonSourceRights["metadata"];
}

export interface IdentityAnchorRendering {
  text: string;
  publishedAt: string | null;
  sourceVersion: string | null;
  rights: PersonSourceRights;
  provenanceNote: string;
  anchors: { kind: "section"; value: string; offset: number }[];
  /** Links the record names, including its own linked activity. Leads only. */
  outboundUrls: string[];
}

/**
 * Whether a retained source is an identity or affiliation registry record.
 *
 * Both halves matter: the record reader is what produced field lines rather
 * than a page, and the upstream index is what says those lines are an
 * identity registry record rather than a publication or a museum catalogue.
 */
export function isIdentityAnchorRead(read: {
  acquisition: string;
  upstreamIndex?: string | null | undefined;
}): boolean {
  return (
    read.acquisition === "record-reader" &&
    RENDERERS.includes((read.upstreamIndex ?? "") as (typeof RENDERERS)[number])
  );
}

/** Render one index's identity record, or nothing when the body is not one. */
export function renderIdentityAnchor(index: string, body: unknown): IdentityAnchorRendering | null {
  const facts = index === "orcid.org" ? orcidFacts(body) : null;
  return facts ? assemble(index, facts) : null;
}

/* ------------------------------------------------------------------ */
/* Assembly                                                             */
/* ------------------------------------------------------------------ */

function assemble(index: string, facts: AnchorFacts): IdentityAnchorRendering {
  const rights: PersonSourceRights = { metadata: facts.metadata, declared: [], materials: [] };

  const sections: [string, string[]][] = [
    ["Registry identity", facts.identity.map(([label, value]) => `${label}: ${value}`)],
    ...(facts.otherNames.length
      ? ([["Other names", facts.otherNames]] as [string, string[]][])
      : []),
    ...(facts.externalIdentifiers.length
      ? ([
          [
            "External identifiers",
            facts.externalIdentifiers.map(([label, value]) => `${label}: ${value}`),
          ],
        ] as [string, string[]][])
      : []),
    [
      "Affiliations",
      [
        ...(facts.affiliations.length
          ? facts.affiliations.map(
              (affiliation) =>
                `${affiliation.organization}${affiliation.role ? ` — ${affiliation.role}` : ""}${
                  affiliation.department ? `, ${affiliation.department}` : ""
                }; ${affiliation.start ?? "start unstated"}–${affiliation.end ?? "present or unstated"}`,
            )
          : ["No employment or education affiliation in this record."]),
        REGISTRY_MEMBERSHIP_LIMIT,
      ],
    ],
    [
      "Linked activity",
      [
        facts.linkedActivityCount > 0
          ? `${String(facts.linkedActivityCount)} work(s) linked in this record; not retained as fact here.`
          : "No linked work in this record.",
        REGISTRY_MEMBERSHIP_LIMIT,
      ],
    ],
    [
      "Rights",
      [
        `Metadata: ${rights.metadata.statement} (${rights.metadata.documentation})`,
        "No declared licence over prose fields (such as a biography) was found in this record; none is retained as quoted text.",
      ],
    ],
  ];

  const anchors: IdentityAnchorRendering["anchors"] = [];
  let text = "";
  for (const [name, lines] of sections) {
    anchors.push({ kind: "section", value: name, offset: text.length });
    text += `${name}\n${lines.join("\n")}\n\n`;
  }

  return {
    text: text.trimEnd(),
    publishedAt: null,
    sourceVersion: facts.sourceVersion,
    rights,
    provenanceNote: `Identity and affiliation registry record from ${index}, rendered from its metadata fields. ${REGISTRY_MEMBERSHIP_LIMIT}`,
    anchors,
    outboundUrls: facts.linked,
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

/** ORCID wraps almost every scalar in `{ value: X }`. */
function val(value: unknown): string | null {
  return str(record(value)?.value);
}

/** ORCID's `year`/`month`/`day` triple, rendered as an ISO-ish day. */
function orcidDate(value: unknown): string | null {
  const date = record(value);
  if (!date) return null;
  const year = val(date.year);
  if (!year) return null;
  const month = val(date.month);
  const day = val(date.day);
  return [year, ...(month ? [month] : []), ...(day ? (month ? [day] : []) : [])].join("-");
}

/** An ORCID epoch-millisecond timestamp, as an ISO-8601 instant. */
function epochMillis(value: unknown): string | null {
  const raw = record(value)?.value;
  return typeof raw === "number" && Number.isFinite(raw) ? new Date(raw).toISOString() : null;
}

function orcidFacts(body: unknown): AnchorFacts | null {
  const root = record(body);
  const orcidId = str(record(root?.["orcid-identifier"])?.path, 30);
  if (!root || !orcidId) return null;
  const person = record(root.person);
  const name = record(person?.name);
  const givenNames = val(name?.["given-names"]);
  const familyName = val(name?.["family-name"]);
  const fullName = [givenNames, familyName].filter(Boolean).join(" ") || null;
  const otherNames = list(record(person?.["other-names"])?.["other-name"]).flatMap((entry) => {
    const content = str(record(entry)?.content, 200);
    return content ? [content] : [];
  });
  const externalIdentifiers = list(
    record(person?.["external-identifiers"])?.["external-identifier"],
  ).flatMap((entry) => {
    const identifier = record(entry);
    const type = str(identifier?.["external-id-type"], 80);
    const value = str(identifier?.["external-id-value"], 200);
    return type && value ? ([[type, value]] as [string, string][]) : [];
  });

  const activities = record(root["activities-summary"]);
  const affiliationsFrom = (kind: "employment" | "education"): Affiliation[] =>
    list(record(activities?.[`${kind}s`])?.["affiliation-group"]).flatMap((group) =>
      list(record(group)?.summaries).flatMap((summaryEntry) => {
        const summary = record(record(summaryEntry)?.[`${kind}-summary`]);
        const organization = str(record(summary?.organization)?.name, 300);
        if (!organization) return [];
        return [
          {
            organization,
            role: str(summary?.["role-title"], 200),
            department: str(summary?.["department-name"], 200),
            start: orcidDate(summary?.["start-date"]),
            end: orcidDate(summary?.["end-date"]),
          },
        ];
      }),
    );
  const affiliations = [...affiliationsFrom("employment"), ...affiliationsFrom("education")];

  const linked: string[] = [];
  let linkedActivityCount = 0;
  for (const group of list(record(activities?.works)?.group)) {
    const summaries = list(record(group)?.["work-summary"]);
    if (summaries.length === 0) continue;
    linkedActivityCount += 1;
    const primary = record(summaries[0]);
    for (const externalId of list(record(primary?.["external-ids"])?.["external-id"])) {
      const entry = record(externalId);
      if (str(entry?.["external-id-type"], 40)?.toLowerCase() !== "doi") continue;
      const value = str(entry?.["external-id-value"], 300);
      if (value) linked.push(`https://doi.org/${value}`);
    }
  }

  return {
    identity: pairs([
      ["Index", "orcid.org"],
      ["ORCID iD", orcidId],
      ["Name", fullName],
    ]),
    otherNames,
    externalIdentifiers,
    affiliations,
    linkedActivityCount,
    linked: [...new Set(linked)],
    sourceVersion: (() => {
      const modified = epochMillis(record(root.history)?.["last-modified-date"]);
      return modified ? `orcid record last modified ${modified}` : null;
    })(),
    metadata: {
      basis: "orcid-public-api",
      statement:
        "pub.orcid.org serves the public record without a token; the curated transport sends the JSON accept header the documentation asks for.",
      documentation: "https://info.orcid.org/documentation/api-tutorials/",
    },
  };
}
