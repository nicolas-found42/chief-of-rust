import type { BrandProfileRevision, ContentAngle } from "./content-scout.js";
import type { PersonProfilePublicSafeProjection } from "./person-profile.js";
import type { AdapterDiagnostic, SourceItem } from "./source-items.js";

/**
 * The versioned catalog of approved publication targets (spec #117 "Target
 * catalog"). Each entry is one platform/format contract: what its structured
 * Platform Outline plan contains and what its optional Content Engine Draft
 * produces. Changing the catalog changes the Outline Set contract, so every
 * entry carries its own contractVersion and `CONTENT_PROJECT_TARGETS` is
 * derived from the catalog — the target union and the catalog cannot drift.
 */
export const CONTENT_TARGET_CATALOG = [
  {
    target: "linkedin-standard-post",
    contractVersion: 1,
    contract: {
      platform: "LinkedIn",
      format: "Standard Post",
      outlineResult: "hook/argument/evidence/CTA plan",
      draftResult: "finished post copy",
    },
  },
  {
    target: "linkedin-carousel",
    contractVersion: 1,
    contract: {
      platform: "LinkedIn",
      format: "Carousel",
      outlineResult: "cover and slide-beat plan",
      draftResult: "finished slide copy",
    },
  },
  {
    target: "linkedin-long-article",
    contractVersion: 1,
    contract: {
      platform: "LinkedIn",
      format: "Long-form Article",
      outlineResult: "section/evidence plan",
      draftResult: "finished article copy",
    },
  },
  {
    target: "website-blog-article",
    contractVersion: 1,
    contract: {
      platform: "Website",
      format: "Blog Article",
      outlineResult: "headline/section/SEO evidence plan",
      draftResult: "finished article copy",
    },
  },
  {
    target: "email-newsletter",
    contractVersion: 1,
    contract: {
      platform: "Email",
      format: "Newsletter",
      outlineResult: "subject/opening/section/CTA plan",
      draftResult: "finished newsletter copy",
    },
  },
  {
    target: "youtube-short",
    contractVersion: 1,
    contract: {
      platform: "YouTube",
      format: "Short",
      outlineResult: "hook/visual beats/payoff plan",
      draftResult: "record-ready short script",
    },
  },
  {
    target: "youtube-long-video",
    contractVersion: 1,
    contract: {
      platform: "YouTube",
      format: "Long-form Video",
      outlineResult: "cold open/chapter/visual plan",
      draftResult: "record-ready long script",
    },
  },
  {
    target: "instagram-reel",
    contractVersion: 1,
    contract: {
      platform: "Instagram",
      format: "Reel",
      outlineResult: "pattern interrupt/visual beats/payoff plan",
      draftResult: "record-ready Reel script",
    },
  },
  {
    target: "tiktok-video",
    contractVersion: 1,
    contract: {
      platform: "TikTok",
      format: "Video",
      outlineResult: "immediate hook/rapid proof/payoff plan",
      draftResult: "record-ready TikTok script",
    },
  },
] as const;

export type ContentProjectTarget = (typeof CONTENT_TARGET_CATALOG)[number]["target"];

export const CONTENT_PROJECT_TARGETS: readonly ContentProjectTarget[] = CONTENT_TARGET_CATALOG.map(
  (entry) => entry.target,
);

export interface ContentTargetContract {
  platform: string;
  format: string;
  /** What the structured Platform Outline plan contains for this target. */
  outlineResult: string;
  /** What the optional Content Engine Draft produces for this target. */
  draftResult: string;
}

export interface ContentTargetCatalogEntry {
  target: ContentProjectTarget;
  contractVersion: number;
  contract: ContentTargetContract;
}

export type ContentProjectResearchMode =
  "no-external-research" | "existing-workspace-evidence" | "fresh-bounded-research";

export const CONTENT_PROJECT_RESEARCH_MODES: readonly ContentProjectResearchMode[] = [
  "no-external-research",
  "existing-workspace-evidence",
  "fresh-bounded-research",
];
export type ContentProjectSubjectInput =
  { kind: "topic"; topic: string } | { kind: "person-profile"; profileId: string };

/**
 * The source Content Opportunity (#133) one Project revision was seeded from.
 * The relationship is recorded at creation and carried through revisions; it
 * is an input lineage, never a generation trigger: the Project still needs its
 * own evidence review and an approved Outline Charter.
 */
export interface ContentProjectSourceOpportunity {
  opportunityId: string;
  runId: string;
  title: string;
  angle: ContentAngle;
  angleDescription: string;
  sourceUrls: string[];
  brandProfileRevisionId: string;
  recordedAt: string;
}

export type ContentProjectSubject =
  | { kind: "topic"; topic: string }
  | { kind: "person-profile"; profileId: string; profileRevision: number };

export interface ContentProjectCreateInput {
  subject: ContentProjectSubjectInput;
  authorProfileId?: string;
  objective: string;
  audience: string;
  constraints: string[];
  targets: ContentProjectTarget[];
  researchMode: ContentProjectResearchMode | null;
  seedMaterial: string[];
  /** The shortlisted Content Opportunity that seeded this Project, when one did. */
  sourceOpportunity?: Omit<ContentProjectSourceOpportunity, "recordedAt">;
}

export interface ContentProjectIntentPatch {
  subject?: ContentProjectSubjectInput;
  authorProfileId?: string;
  objective?: string;
  audience?: string;
  constraints?: string[];
  targets?: ContentProjectTarget[];
  researchMode?: ContentProjectResearchMode | null;
  seedMaterial?: string[];
}

export interface ContentProjectAuthorReference {
  profileId: string;
  profileRevision: number;
}

// ---------------------------------------------------------------------------
// Research Requests (issue #130; spec #117 "fresh bounded research")
// ---------------------------------------------------------------------------

/**
 * The class of a Workspace-held identifier that an anonymous public query was
 * built from. Only the class is ever recorded: the identifier value itself
 * stays inside the Person Profiles interface.
 */
export type ResearchIdentifierClass =
  "email" | "full-name" | "handle" | "profile-url" | "employer-hint";

/** Why an identifier was sent: to locate the person, or to pair them with the Project subject. */
export type ResearchIdentifierPurpose = "person-identification" | "topic-evidence";

/** One audited use of one identifier class by one provider at one moment. */
export interface ResearchIdentifierUse {
  identifierClass: ResearchIdentifierClass;
  providerId: string;
  usedAt: string;
  purpose: ResearchIdentifierPurpose;
}

/**
 * The providers a Research Request is explicitly configured with. An
 * `all-providers` bundle is the strict selection of spec #117: it reports
 * incomplete until every provider in it succeeds. A `best-effort` bundle keeps
 * whatever succeeded, because Source Adapters stay independent (ADR-0028).
 */
export interface ResearchProviderBundle {
  providerIds: string[];
  completeness: "best-effort" | "all-providers";
}

/** What makes a Research Request finite: it asks a bounded number of bounded questions. */
export interface ResearchRequestLimits {
  maxQueriesPerProvider: number;
  maxSourceItems: number;
}

/** The explicit scope one Research Request was allowed to ask about. */
export interface ResearchRequestScope {
  question: string;
  terms: string[];
  subject: ContentProjectSubject;
}

export interface ResearchRequestInput {
  question: string;
  terms: string[];
  bundle: ResearchProviderBundle;
  limits: ResearchRequestLimits;
}

/** What one configured provider did during one Research Request. */
export interface ResearchProviderOutcome {
  providerId: string;
  queries: number;
  itemsFound: number;
  diagnostic: AdapterDiagnostic;
}

/**
 * One finite, Project-owned piece of fresh public research. It terminates: it
 * carries a `finishedAt` and holds no checkpoint, conditional validator,
 * baseline, schedule or watch state, so nothing about it recurs and nothing
 * about it belongs to Content Research.
 */
export interface ResearchRequest {
  id: string;
  projectId: string;
  projectRevision: number;
  scope: ResearchRequestScope;
  bundle: ResearchProviderBundle;
  limits: ResearchRequestLimits;
  startedAt: string;
  finishedAt: string;
  completeness: "complete" | "incomplete";
  providerOutcomes: ResearchProviderOutcome[];
  identifierUses: ResearchIdentifierUse[];
  /** Exactly the evidence the providers returned, before the owner reviews it. */
  sourceItems: SourceItem[];
}

export interface ContentProjectRevision {
  revision: number;
  createdAt: string;
  subject: ContentProjectSubject;
  author: ContentProjectAuthorReference;
  objective: string;
  audience: string;
  constraints: string[];
  targets: ContentProjectTarget[];
  researchMode: ContentProjectResearchMode | null;
  seedMaterial: string[];
  /** The shortlisted Content Opportunity that seeded this Project, when one did. */
  sourceOpportunity: ContentProjectSourceOpportunity | null;
  researchRequest: ResearchRequest | null;
  evidenceReview: ContentProjectEvidenceReview | null;
  frozenEvidence: ContentProjectEvidenceFreeze | null;
  outlineCharters: OutlineCharter[];
  outlineCharterApprovals: OutlineCharterApproval[];
  platformOutlines: PlatformOutline[];
  platformOutlineApprovals: PlatformOutlineApproval[];
  drafts: ContentEngineDraft[];
}

export interface ContentProject {
  id: string;
  createdAt: string;
  updatedAt: string;
  revisions: ContentProjectRevision[];
}

/**
 * One Content Project as a list reads it (spec #147). A Project carries every
 * revision, and each revision carries its evidence freeze, Outline Charters,
 * Platform Outlines and Drafts; a list that rendered whole Projects would read
 * all of that to draw a table of subjects. This is the current revision's
 * identity and standing, and nothing else.
 */
export interface ContentProjectSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** The current revision's number, so a list shows what has moved. */
  revision: number;
  subject: ContentProjectSubject;
  objective: string;
  audience: string;
  targets: ContentProjectTarget[];
  researchMode: ContentProjectResearchMode | null;
  sourceOpportunity: ContentProjectSourceOpportunity | null;
  readiness: ContentProjectReadiness;
}

export interface AuthorizedAuthorPolicy {
  profileId: string;
  authorizedAt: string;
}

export interface ContentVoiceRevision {
  id: string;
  profileId: string;
  revision: number;
  markdown: string;
  approvedAt: string;
}

export interface ContentProjectEvidenceReview {
  attachedAt: string;
  sourceItems: SourceItem[];
  diagnostics: AdapterDiagnostic[];
}

export interface ContentProjectProfileSnapshot {
  role: "author" | "subject";
  projection: PersonProfilePublicSafeProjection;
}

export interface ContentProjectEvidenceFreeze {
  frozenAt: string;
  sourceItems: SourceItem[];
  diagnostics: AdapterDiagnostic[];
  brandVoice: BrandProfileRevision;
  contentVoice: ContentVoiceRevision;
  profileProjections: ContentProjectProfileSnapshot[];
  userMaterial: string[];
  noExternalResearchAcknowledged: boolean;
}

/**
 * The Source Item fields a generation prompt may see.
 *
 * An allowlist rather than the stored record, because `ContentProjectPromptEvidence`
 * is serialized verbatim into the prompt: without this, every field a Source Item
 * grows would reach a model the day it was added, and the review that added it
 * would be about the field, not about the prompt. Named here, a new field is
 * Workspace-only until someone decides otherwise on purpose.
 *
 * What is left out is plumbing rather than evidence — provenance receipts,
 * per-field completeness states, engagement counts, story keys, and the adapter,
 * target and external identity that say where the item came from. A writer works
 * from none of it, and each one is a way for operational detail to be read back
 * as a fact about the subject.
 *
 * `transcript` is in: a Source Adapter fills it from the public artifact it
 * fetched — YouTube captions, today — and `SourceItem` is public evidence by
 * construction. It is named last on purpose, as the one field here whose
 * contents are long-form third-party prose, so that a future private-transcript
 * source has exactly one line to reconsider rather than a spread to audit.
 */
export type PromptSourceItem = Pick<
  SourceItem,
  | "id"
  | "canonicalUrl"
  | "author"
  | "title"
  | "body"
  | "description"
  | "publishedAt"
  | "claims"
  | "transcript"
>;

/**
 * What a Content Engine generator may put in a prompt: the frozen public
 * evidence and the approved voice, and nothing else. Search diagnostics and the
 * Research Request's identifier bookkeeping are structurally absent here, so an
 * operational failure or a private identifier class can never be handed to a
 * model as a factual content claim.
 */
export interface ContentProjectPromptEvidence {
  projectId: string;
  projectRevision: number;
  sourceItems: PromptSourceItem[];
  brandVoice: BrandProfileRevision;
  contentVoice: ContentVoiceRevision;
  profileProjections: ContentProjectProfileSnapshot[];
  userMaterial: string[];
}

export interface ContentProjectEvidenceAttachment {
  sourceItems: SourceItem[];
  diagnostics: AdapterDiagnostic[];
}

export interface ContentProjectEvidenceSelection {
  includedSourceItemIds: string[];
  noExternalResearchAcknowledged: boolean;
}

export const CONTENT_PROJECT_GATES = [
  "canonical-owner",
  "brand-voice",
  "author-authority",
  "content-voice",
  "research-mode",
  "evidence-review",
  "no-research-acknowledgement",
  "target",
] as const;
export type ContentProjectGate = (typeof CONTENT_PROJECT_GATES)[number];

export interface ContentProjectReadiness {
  ready: boolean;
  missingGates: ContentProjectGate[];
}

export interface OutlineCharterEvidenceMapEntry {
  claim: string;
  sourceItemIds: string[];
}

export interface OutlineCharterProposalInput {
  thesis: string;
  angle: string;
  claims: string[];
  evidenceMap: OutlineCharterEvidenceMapEntry[];
  ctaIntent: string | null;
}

export interface OutlineCharter extends OutlineCharterProposalInput {
  id: string;
  projectId: string;
  projectRevision: number;
  version: number;
  proposedAt: string;
  subject: ContentProjectSubject;
  author: ContentProjectAuthorReference;
  audience: string;
  objective: string;
  constraints: string[];
  brandVoiceRevisionId: string;
  targets: ContentProjectTarget[];
}

/** Approval is a separate immutable decision so the proposed Brief never changes in place. */
export interface OutlineCharterApproval {
  outlineCharterId: string;
  approvedAt: string;
}

// ---------------------------------------------------------------------------
// Platform Outlines and Content Engine Drafts (issue #131; spec #117
// generation and revision rules)
// ---------------------------------------------------------------------------

export interface PlatformOutlineBeat {
  position: number;
  direction: string;
  evidence: OutlineCharterEvidenceMapEntry;
  examples: string[];
}

export interface PlatformOutline {
  id: string;
  projectId: string;
  projectRevision: number;
  target: ContentProjectTarget;
  outlineCharterId: string;
  outlineCharterVersion: number;
  version: number;
  generatedAt: string;
  /** The bounded regeneration instruction that produced this version, if any. */
  instruction: string | null;
  title: string;
  hookDirection: string;
  /** Pinned from the approved Outline Charter; regeneration cannot alter it. */
  thesis: string;
  beats: PlatformOutlineBeat[];
  ctaIntent: string | null;
  targetLength: string;
  constraints: string[];
  warnings: string[];
  productionNotes: string[];
}

/** Approval is a separate immutable decision so the Outline never changes in place. */
export interface PlatformOutlineApproval {
  platformOutlineId: string;
  target: ContentProjectTarget;
  approvedAt: string;
}

export const CONTENT_ENGINE_UNSUPPORTED_CLAIM_POLICY = "mark-unsupported" as const;

export interface ContentEngineDraftClaim {
  text: string;
  sourceItemIds: string[];
  /**
   * Computed by the Content Project against the approved Brief's evidence map;
   * a provider or regeneration instruction can never set it.
   */
  supported: boolean;
}

export interface ContentEngineDraft {
  id: string;
  projectId: string;
  projectRevision: number;
  target: ContentProjectTarget;
  platformOutlineId: string;
  outlineVersion: number;
  version: number;
  generatedAt: string;
  /** The bounded regeneration instruction that produced this version, if any. */
  instruction: string | null;
  copy: string;
  /** Pinned from the approved Outline Charter; regeneration cannot alter it. */
  thesis: string;
  /** Pinned from the approved Outline Charter; regeneration cannot alter it. */
  evidence: OutlineCharterEvidenceMapEntry[];
  claims: ContentEngineDraftClaim[];
  unsupportedClaimPolicy: typeof CONTENT_ENGINE_UNSUPPORTED_CLAIM_POLICY;
  productionNotes: string[];
}

// ---------------------------------------------------------------------------
// Outline Sets (issue #132; spec #117 generation and revision rules 4-5)
// ---------------------------------------------------------------------------

/**
 * Why one selected target produced no Platform Outline in one set generation.
 * The set path emits exactly these: a provider that never answered in the
 * Outline's Result Shape (`provider-failed`), or an answer the Content
 * Project refused as a provider-contract violation (`invalid-provider-result`).
 */
export type OutlineSetFailureCode = "provider-failed" | "invalid-provider-result";

export interface OutlineSetFailure {
  target: ContentProjectTarget;
  code: OutlineSetFailureCode;
  message: string;
}

/**
 * What one Outline Set generation did: the approved Brief it ran from, the
 * Platform Outlines that landed, and the targets that failed. Successful
 * siblings persist immediately; `failures` names exactly what a retry of the
 * same call will regenerate.
 */
export interface OutlineSetOutcome {
  outlineCharterId: string;
  outlineCharterVersion: number;
  generated: PlatformOutline[];
  failures: OutlineSetFailure[];
}

// ---------------------------------------------------------------------------
// User exports (issue #132; spec #117 generation rule 10)
// ---------------------------------------------------------------------------

function markdownBullets(values: readonly string[]): string[] {
  return values.map((value) => `- ${value}`);
}

function evidenceSourceLabel(sourceItemIds: readonly string[]): string {
  return sourceItemIds.length > 0
    ? `Source Items: ${sourceItemIds.join(", ")}`
    : "thesis beat, no frozen source";
}

/**
 * The Markdown download for one Platform Outline: a deterministic rendering of
 * the structured record. The structured JSON remains the product interface;
 * this is only what a person downloads.
 */
export function platformOutlineMarkdown(outline: PlatformOutline): string {
  const lines = [
    `# ${outline.title}`,
    "",
    `- Target: ${outline.target} (version ${outline.version})`,
    `- Thesis: ${outline.thesis}`,
    `- Hook: ${outline.hookDirection}`,
    `- Target length: ${outline.targetLength}`,
  ];
  if (outline.ctaIntent) lines.push(`- CTA intent: ${outline.ctaIntent}`);
  lines.push("", "## Beats", "");
  for (const beat of outline.beats) {
    lines.push(
      `### ${beat.position}. ${beat.direction}`,
      "",
      `- Evidence: ${beat.evidence.claim} (${evidenceSourceLabel(beat.evidence.sourceItemIds)})`,
    );
    if (beat.examples.length > 0) lines.push(`- Examples: ${beat.examples.join("; ")}`);
    lines.push("");
  }
  if (outline.warnings.length > 0) {
    lines.push("## Warnings", "", ...markdownBullets(outline.warnings), "");
  }
  if (outline.productionNotes.length > 0) {
    lines.push("## Production notes", "", ...markdownBullets(outline.productionNotes), "");
  }
  if (outline.constraints.length > 0) {
    lines.push("## Constraints", "", ...markdownBullets(outline.constraints));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The Markdown download for one Content Engine Draft. The copy export is the
 * draft's own `copy` field verbatim; this rendering adds the claim support
 * the unsupported-claim policy requires a person to see.
 */
export function contentEngineDraftMarkdown(draft: ContentEngineDraft): string {
  const lines = [
    `# ${draft.target} draft (version ${draft.version})`,
    "",
    draft.copy,
    "",
    `Thesis: ${draft.thesis}`,
    "",
    "## Claims",
    "",
  ];
  for (const claim of draft.claims) {
    const support = claim.supported
      ? `Supported (${evidenceSourceLabel(claim.sourceItemIds)})`
      : `Unsupported (${CONTENT_ENGINE_UNSUPPORTED_CLAIM_POLICY})`;
    lines.push(`- ${claim.text} — ${support}`);
  }
  if (draft.productionNotes.length > 0) {
    lines.push("", "## Production notes", "", ...markdownBullets(draft.productionNotes));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
