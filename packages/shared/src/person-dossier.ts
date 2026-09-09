import { z } from "zod/v3";
import {
  PersonResearchAttemptSchema,
  PersonResearchOperationOutcomeSchema,
} from "./person-research.js";

const text = z.string().min(1).max(4000);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const date = z.string().max(40).nullable();
export const PersonDossierSectionSchema = z.enum([
  "overview",
  "career",
  "work",
  "expertise",
  "ideas",
  "connections",
  "recognition",
  "context",
]);
/**
 * What a retained source may be used for, recorded per material (issue #249).
 *
 * A publication or deposit index grants permission over its *metadata*, and
 * that permission stops there: an abstract carried inside the same response,
 * and the full text the record links to, each need their own rights basis. One
 * blanket "this record is open" field would erase that boundary, so the
 * permission the fields were retained under, the licences the record itself
 * declares, and what this read did with every other material are three
 * separate things here.
 */
export const PersonSourceRightsSchema = z.object({
  /** The permission the record's own metadata fields were retained under. */
  metadata: z.object({
    /* "orcid-public-api" joined the publication/deposit bases for identity
       and affiliation registry records (issue #252). */
    basis: z.enum([
      "crossref-rest-metadata",
      "datacite-data-file-cc0",
      "openalex-cc0",
      "orcid-public-api",
      /* A US federal registry and a public trial-registration API (issue #250):
         both publish structured records for public dissemination, with no
         licence over the record and no warranty about the person it names. */
      "nppes-public-registry",
      "clinicaltrials-public-api",
      "openlibrary-public-api",
      "loc-json-api",
      "tvmaze-free-api",
    ]),
    statement: z.string().max(600),
    /** Where that permission was read; a catalogue label is not a source. */
    documentation: z.string().max(600),
  }),
  /** Licences the record declares, each naming the material it covers. */
  declared: z
    .array(
      z.object({
        material: z.enum(["deposited-resource", "full-text"]),
        statement: z.string().max(300),
        url: z.string().max(600).nullable(),
        appliesFrom: z.string().max(40).nullable(),
      }),
    )
    .max(20),
  /** Every material beyond the metadata, and what this read did with it. */
  materials: z
    .array(
      z.object({
        material: z.enum([
          "abstract",
          "full-text",
          "linked-document",
          "cover-image",
          "linked-work",
          "description",
        ]),
        disposition: z.enum([
          "retained-under-declared-licence",
          "withheld-no-rights-basis",
          "not-retrieved",
        ]),
        /** The declared licence the disposition rests on, when there is one. */
        licence: z.string().max(300).nullable(),
        reason: z.string().max(400),
      }),
    )
    .max(10),
});
export type PersonSourceRights = z.infer<typeof PersonSourceRightsSchema>;
export const PersonSourceDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  id,
  url: z.string().max(4000),
  title: text,
  author: z.string().max(1000).nullable(),
  publishedAt: date,
  retrievedAt: z.string().max(40),
  /**
   * When a web archive captured this material, for text read out of a capture
   * rather than off the live web (issue #253). Distinct from `retrievedAt`,
   * which says when this operation asked the archive, and from `publishedAt`,
   * which the publisher states: a capture is evidence of what the page said on
   * its capture date and of nothing after it. Absent means the text is not
   * archived material, never that its capture date is unknown.
   */
  capturedAt: z.string().max(40).optional(),
  text: z.string().max(500000),
  hash: z.string().length(64),
  family: text,
  sourceClass: z.enum([
    "self-report",
    "independent-account",
    "primary-artifact",
    "workspace",
    "manual",
    "unclassified",
  ]),
  attribution: z
    .enum(["self-report", "independent-account", "primary-artifact", "unknown"])
    .optional(),
  visibility: z.enum(["public", "private"]),
  extractionCoverage: z.enum(["unattempted", "partial", "full"]).optional(),
  /** Exact original-text ranges read by extraction; omitted ranges remain available in text. */
  extractionRanges: z
    .array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }))
    .max(4)
    .optional(),
  completeness: z.enum(["full", "partial", "snippet", "unavailable"]),
  access: z.enum(["retrieved", "blocked", "failed", "unsupported"]),
  acquisition: text,
  transcriptId: id.optional(),
  outboundUrls: z.array(z.string().max(4000)).max(200).optional(),
  /**
   * The source family this evidence belongs to (issue #228). Distinct from
   * `family`, which identifies duplicated *content*: two mirrors of one
   * article share a content family, while a caption track and a filing are
   * different evidence families even when nothing about them is duplicated.
   */
  evidenceFamily: z.string().max(120).optional(),
  /**
   * The index or publisher the content ultimately came from. Several wrappers
   * over one index share it, so independent evidence can be counted rather
   * than inferred from distinct hostnames.
   */
  upstreamIndex: z.string().max(200).optional(),
  /** Citation anchors suited to the format: PDF pages, caption timestamps. */
  anchors: z
    .array(
      z.object({
        kind: z.enum(["page", "timestamp", "section"]),
        value: z.string().max(80),
        offset: z.number().int().nonnegative(),
      }),
    )
    .max(500)
    .optional(),
  /**
   * What a reader must not lose about how this text was produced: publisher
   * captions versus speech recognition, a rendered page versus a raw response.
   */
  provenanceNote: z.string().max(1000).optional(),
  /**
   * The upstream's own version marker for this record — Crossref's indexing
   * build, DataCite's update stamp — when it states one. A retained version is
   * dated by when we read it; this says which version of the record that was.
   */
  sourceVersion: z.string().max(200).optional(),
  /** Rights provenance, absent when the route established none (issue #249). */
  rights: PersonSourceRightsSchema.optional(),
  /**
   * Individuals a professional or institutional record names, by name, with
   * only their own affiliation strings the record states for them — never a
   * record-level sponsor or responsible organization. Absent for every route
   * that is not an institutional record. Identity resolution reads this
   * instead of searching the whole rendered text for a known employer, so a
   * trial sponsored by the Profile's employer cannot corroborate a same-name
   * investigator whose own affiliation conflicts (review finding on issue
   * #250, PR #295).
   *
   * An entry's `affiliations` is `null`, distinct from `[]`, when the
   * record's own shape cannot state an affiliation for that person at all —
   * an NPPES specialty or an organisation's own name is never a stand-in.
   * Identity resolution reads `null` as "cannot corroborate or refute" and
   * holds a same-name match ambiguous rather than confirming or rejecting it
   * (review finding on issue #250, PR #295).
   */
  namedIndividuals: z
    .array(
      z.object({
        name: z.string().max(400),
        affiliations: z.array(z.string().max(400)).max(20).nullable(),
      }),
    )
    .max(20)
    .optional(),
});
/**
 * One passage a claim rests on.
 *
 * `capturedAt` repeats the cited source's capture date on the citation itself
 * (issue #253) rather than leaving a reader to join the two: a claim grounded
 * in archived material is only evidence about the capture date, and a reader
 * preparing for a meeting sees the claim, not the source record behind it. It
 * is written from the retained source, never from a model's answer.
 */
const citation = z.object({
  sourceId: id,
  quote: text,
  capturedAt: z.string().max(40).optional(),
});
export const PersonClaimSchema = z.object({
  id,
  section: PersonDossierSectionSchema,
  statement: text,
  fact: z
    .object({ field: z.enum(["fullName", "role", "currentEmployer", "background"]), value: text })
    .optional(),
  status: z.enum(["supported", "claimed", "contested", "unknown", "stale", "superseded"]),
  nature: z.enum(["statement", "interpretation"]),
  matchConfidence: z.enum(["high", "medium", "low"]),
  effectiveFrom: date,
  effectiveTo: date,
  citations: z.array(citation).max(30),
  supports: z.array(id).max(30),
  supersedes: z.array(id).max(30),
  changeReason: z.string().max(4000).nullable(),
});
const grounded = z.object({ text, claimIds: z.array(id).min(1).max(30) });
export const PersonWorkRecordSchema = z.object({
  id,
  title: text,
  url: z.string().max(4000).nullable(),
  kind: z.enum([
    "system",
    "product",
    "company",
    "research",
    "paper",
    "talk",
    "patent",
    "post",
    "release",
    "commit",
    "filing",
    "other",
  ]),
  startedAt: date,
  endedAt: date,
  claimIds: z.array(id).min(1).max(30),
  contribution: grounded.nullable(),
  teamContribution: grounded.nullable(),
  authority: z
    .array(
      z.object({
        role: z.enum(["decided", "recommended", "executed"]),
        claimIds: z.array(id).min(1).max(30),
      }),
    )
    .max(10),
  scale: z
    .array(
      z.object({
        value: z.number().finite(),
        unit: text,
        scope: text,
        date,
        claimIds: z.array(id).min(1).max(30),
      }),
    )
    .max(30),
  constraints: z.array(grounded).max(30),
  outcomes: z
    .array(grounded.extend({ date, afterDeparture: z.boolean(), unsuccessful: z.boolean() }))
    .max(30),
});
export const PersonConnectionSchema = z.object({
  id,
  counterparty: text,
  counterpartyUrl: z.string().url().max(4000).optional(),
  profileId: id.nullable(),
  kind: z.enum([
    "co-authored",
    "co-founded",
    "collaborated",
    "reported-to",
    "managed",
    "shared-employer",
    "invested",
    "funded",
    "board",
    "advised",
    "committee",
    "credited",
    "influenced",
  ]),
  direction: z.enum(["outgoing", "incoming", "undirected"]),
  from: date,
  to: date,
  workIds: z.array(id).max(100),
  claimIds: z.array(id).min(1).max(30),
});
export const PersonExpertiseSchema = z.object({
  category: text,
  originalWording: text,
  support: z.enum(["claimed", "demonstrated"]),
  workIds: z.array(id).max(100),
  claimIds: z.array(id).min(1).max(30),
});
export const PersonDossierContentSchema = z.object({
  sourceIds: z.array(id).max(1000).optional(),
  claims: z.array(PersonClaimSchema).max(2000),
  works: z.array(PersonWorkRecordSchema).max(500),
  expertise: z.array(PersonExpertiseSchema).max(200),
  connections: z.array(PersonConnectionSchema).max(1000),
  sections: z
    .array(
      z.object({
        key: PersonDossierSectionSchema,
        summary: z.string().max(8000),
        claimIds: z.array(id).max(100),
        updatedAt: date,
        gaps: z.array(text).max(30),
        state: z.enum(["unresearched", "incomplete", "current", "unavailable"]),
      }),
    )
    .max(8),
});
/**
 * A published dossier. `sourceIds` loses its optionality here: publishing
 * derives the list from the content's own citations, so a stored dossier always
 * names every source it retains, and readers never have to guess whether an
 * absent list means "no sources" or "not recorded".
 */
export const PersonDossierSchema = PersonDossierContentSchema.extend({
  sourceIds: z.array(id).max(1000),
  schemaVersion: z.literal(1),
  profileId: id,
  revision: z.number().int().positive(),
  updatedAt: z.string(),
});
export type PersonSourceDocument = z.infer<typeof PersonSourceDocumentSchema>;
export type PersonClaim = z.infer<typeof PersonClaimSchema>;
export type PersonDossierContent = z.infer<typeof PersonDossierContentSchema>;
export type PersonDossier = z.infer<typeof PersonDossierSchema>;
/**
 * Research settings.
 *
 * The four ceilings are safety bounds on one continuous operation, not a
 * definition of completion: reaching one concludes the operation as bounded
 * with its pending leads retained, and the job reports `incomplete` (#228).
 * Only the operation's own completion conditions can report success.
 */
export const PersonResearchSettingsSchema = z.object({
  paused: z.boolean(),
  concurrency: z.number().int().min(1).max(4),
  /** Model calls one operation may spend before it is bounded. The default
   * carries the small-call rebalance (ADR-0074): extraction reads a document
   * in bounded parts, so wall clock stays the binding constraint. */
  profileCalls: z.number().int().min(1).max(400).default(180),
  /** Wall-clock backstop for one operation. */
  profileMilliseconds: z.number().int().min(1000).max(3600000).default(900000),
  /** Sources read at once inside one operation. */
  readConcurrency: z.number().int().min(1).max(12).default(4),
  /** Deadline for a single request; retries live inside the reader. */
  requestTimeoutMilliseconds: z.number().int().min(1000).max(120000).default(20000),
  /** Consecutive expansion rounds that must find nothing before completion. */
  quietRounds: z.number().int().min(1).max(6).default(2),
  refreshHours: z.number().min(1).max(8760),
  historicalRefreshHours: z.number().min(24).max(8760).optional(),
});
export type PersonResearchSettings = z.infer<typeof PersonResearchSettingsSchema>;
const researchResult = z.object({
  url: z.string().max(4000),
  title: z.string().max(4000),
  snippet: z.string().max(10000),
});
export const PersonResearchCheckpointSchema = z.object({
  /** Identity revision whose traversal may be reused. */
  profileRevision: z.number().int().nonnegative().optional(),
  /** The continuous operation this checkpoint belongs to. */
  operationId: z.string().max(64).optional(),
  /** Discovery queries still pending. */
  queries: z.array(z.string().max(4000)),
  pass: z.number().int().min(0),
  results: z.array(researchResult),
  direct: z.array(researchResult),
  visited: z.array(z.string().max(4000)),
  linked: z.array(z.string().max(4000)),
  pendingSourceId: id.optional(),
  /** Every retained document awaiting extraction; legacy singular checkpoints still resume. */
  pendingSourceIds: z.array(id).max(10000).optional(),
  /** Distinct source versions already retained in this operation across restarts. */
  retainedSourceIds: z.array(z.string().length(64)).max(10000).optional(),
});
export type PersonResearchCheckpoint = z.infer<typeof PersonResearchCheckpointSchema>;
export const PersonResearchJobSchema = z.object({
  /**
   * The compact slice a Profile reader sees. It is derived from `operation`,
   * which keeps the whole attempt history: a display limit here must never be
   * the reason a failure stopped being recoverable (issue #228).
   */
  diagnostics: z.array(PersonResearchAttemptSchema).max(80).optional(),
  /** The durable record of the last operation: coverage, leads, attempts. */
  operation: PersonResearchOperationOutcomeSchema.optional(),
  evidenceRevision: z.string().optional(),
  lastHistoricalAt: z.string().optional(),
  checkpoint: PersonResearchCheckpointSchema.optional(),
  elapsedMilliseconds: z.number().nonnegative().optional(),
  startedAt: z.string().optional(),
  profileId: z.string(),
  state: z.enum([
    "queued",
    "researching",
    "paused",
    "incomplete",
    "unavailable",
    "interrupted",
    "empty",
    "current",
  ]),
  reasons: z.array(z.string()),
  queuedAt: z.string(),
  updatedAt: z.string(),
  nextAt: z.string(),
  calls: z.number().int().nonnegative(),
  sources: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  detail: z.string(),
});
export type PersonResearchJob = z.infer<typeof PersonResearchJobSchema>;
export const PersonResearchStatusSchema = z.object({
  schemaVersion: z.literal(1),
  settings: PersonResearchSettingsSchema,
  day: z.string(),
  usedCalls: z.number().int().nonnegative(),
  jobs: z.array(PersonResearchJobSchema),
});
export type PersonResearchStatus = z.infer<typeof PersonResearchStatusSchema>;
export interface PersonRelationshipRecord {
  kind: "meeting" | "transcript" | "task" | "action-item";
  id: string;
  title: string;
  date: string | null;
  href: string;
  detail: string;
}
export const PersonDossierQuerySchema = z.object({
  query: z.string().max(500).default(""),
  categories: z.array(z.string().min(1).max(200)).max(10).default([]),
  constraints: z.array(z.string().min(1).max(200)).max(10).default([]),
  scale: z.object({ minimum: z.number().finite(), unit: z.string().min(1).max(200) }).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  visibility: z.enum(["public", "private"]).default("private"),
});
export type PersonDossierQuery = z.input<typeof PersonDossierQuerySchema>;
export interface PersonDossierMatch {
  profileId: string;
  name: string;
  dossierRevision: number;
  workIds: string[];
  claimIds: string[];
  citations: { sourceId: string; quote: string }[];
  gaps: string[];
}
export interface PersonDossierQueryResult {
  demonstrated: PersonDossierMatch[];
  claimed: PersonDossierMatch[];
  coverage: {
    activeProfiles: number;
    researchedProfiles: number;
    demonstrated: number;
    claimedOnly: number;
  };
  scope: string;
}
export interface PersonDossierAnalysis {
  activity: { period: string; kind: string; count: number }[];
  collaborations: {
    counterparty: string;
    distinctWorks: number;
    workIds: string[];
    claimIds: string[];
  }[];
  quality: {
    totalClaims: number;
    singleSourceClaims: number;
    unknownClaims: number;
    contestedClaims: number;
    composition: Record<string, number>;
    byClaim: { claimId: string; families: string[]; sourceClasses: string[] }[];
  };
  scope: string;
}
export interface PersonConnectionStep {
  fromProfileId: string;
  toProfileId: string;
  kind: string;
  direction: string;
  from: string | null;
  to: string | null;
  workIds: string[];
  claimIds: string[];
  citations: { sourceId: string; quote: string }[];
}
