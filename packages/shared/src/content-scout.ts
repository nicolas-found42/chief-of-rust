import type {
  AdapterDiagnostic,
  SourceAdapterCanaryTarget,
  SourceAdapterState,
  SourceBackfillWindowDays,
  SourceCapability,
  SourceCollectionAttemptReceipt,
  SourceDiagnosticClassification,
} from "./source-items.js";

export const CONTENT_SCOUT_MODULE_ID = "content-scout";
export const CONTENT_SCOUT_MODULE_VERSION = 1;

export interface SourceSuggestion {
  id: string;
  adapterId: string;
  label: string;
  url: string;
  state: "proposed" | "approved" | "dismissed";
  discoveredAt: string;
  discoveredBecause: string;
  evidenceUrls: string[];
  similarityFactors: string[];
  decisionReason: string | null;
  sourceTargetId: string | null;
}

export interface ContentScoutScheduleState {
  lastSuccessfulIntakePeriod: string | null;
  lastSuccessfulDiscoveryPeriod: string | null;
}

export interface ContentScoutStorageUse {
  measuredAt: string;
  categories: {
    durableRecords: { files: number; bytes: number };
    sanitizedDiagnostics: { files: number; bytes: number };
    temporaryMedia: { files: number; bytes: number };
    retainedEvidenceTranscripts: { files: number; bytes: number };
  };
}

export interface ContentScoutCleanupPreview {
  scope: "expired_temporary_data";
  measuredAt: string;
  items: {
    id: string;
    category: "sanitized_diagnostics" | "temporary_media";
    relativePath: string;
    bytes: number;
    reason: "older_than_30_days" | "failed_media_older_than_24_hours";
  }[];
  files: number;
  bytes: number;
}

export interface ContentScoutCleanupReceipt extends ContentScoutCleanupPreview {
  id: string;
  executedAt: string;
  dryRun: boolean;
  deleted: number;
}

export type RuntimeCapabilityState = "available" | "unavailable" | "unsupported";

export interface ContentScoutRuntimeCapability {
  id: string;
  category: "browser" | "python" | "media" | "transcription";
  state: RuntimeCapabilityState;
  version: string | null;
  pinnedVersion?: string;
  requiredBy: string[];
  diagnostic: {
    classification: "runtime_available" | "runtime_unavailable" | "runtime_unsupported";
    command: string;
    checkedAt: string;
    causeChain: string[];
  };
}

export interface BrandProfileSourceScan {
  websiteUrl: string;
  includedUrls: string[];
  excludedUrls: string[];
}

export interface BrandProfileRevision {
  id: string;
  createdAt: string;
  markdown: string;
  sourceScan: BrandProfileSourceScan;
  note: string | null;
  changedSections: string[];
  /** Website-derived baseline used only for later three-way comparison. */
  siteBaselineMarkdown?: string;
}

/**
 * A stored Brand Profile revision without its Markdown body — the shape a
 * listing carries. Bodies load one revision at a time through the API.
 */
export type BrandProfileRevisionSummary = Omit<BrandProfileRevision, "markdown">;

export interface BrandProfileScanPage {
  url: string;
  title: string;
  depth: number;
  included: boolean;
  exclusionReason: string | null;
  text: string;
}

export interface BrandProfileSectionDiff {
  section: string;
  oldWebsiteValue: string;
  currentValue: string;
  proposedValue: string;
  status: "unchanged" | "non_conflicting" | "conflicting";
}

export interface BrandProfileProposal {
  id: string;
  runId: string;
  createdAt: string;
  websiteUrl: string;
  pages: BrandProfileScanPage[];
  proposedMarkdown: string;
  basedOnRevisionId: string | null;
  sectionDiffs: BrandProfileSectionDiff[];
}

/**
 * The composed Markdown a proposal acceptance stores: accepted sections take
 * the website proposal, every other section keeps its current value. Shared so
 * the review UI can preview exactly what the accept endpoint will write,
 * rather than approximating it.
 */
export function acceptedProposalMarkdown(
  proposal: BrandProfileProposal,
  acceptedSections: string[],
): string {
  const accepted = new Set(acceptedSections);
  const blocks = proposal.sectionDiffs.map((diff) => {
    const value = accepted.has(diff.section) ? diff.proposedValue : diff.currentValue;
    return `## ${diff.section}\n${value}`.trimEnd();
  });
  return `# Brand Profile\n\n${blocks.join("\n\n")}\n`;
}

export const CONTENT_ANGLE_TYPES = [
  "practical_implication",
  "contrarian_interpretation",
  "myth_correction",
  "trend_analysis",
  "tactical_advice",
  "founder_perspective",
  "customer_implication",
  "forecast",
  "reaction",
  "educational_explanation",
] as const;
export type ContentAngle = (typeof CONTENT_ANGLE_TYPES)[number];

export interface OpportunityScores {
  brandRelevance: number;
  audienceUsefulness: number;
  timeliness: number;
  novelty: number;
  evidenceStrength: number;
  evidenceDiversity: number;
  specificity: number;
  originalPerspective: number;
  packApplicability: number;
  speculationRisk: number;
}

export interface OpportunityMaterialDevelopment {
  explanation: string;
  sourceItemIds: string[];
}

export interface OpportunityEarlyFollowUp {
  kind: "different_angle" | "material_development";
  explanation: string;
}

export interface SourceItemReference {
  id: string;
  canonicalUrl: string;
}

export interface RankedOpportunity {
  id: string;
  canonicalKey: string;
  title: string;
  angle: ContentAngle;
  angleDescription: string;
  materialDevelopment: OpportunityMaterialDevelopment | null;
  urgency: string;
  explanation: string;
  sourceItemIds: string[];
  sourceUrls: string[];
  experimentalEvidence: boolean;
  confidence: number;
  scores: OpportunityScores;
}

export interface ShortlistOpportunity extends RankedOpportunity {
  state: "ready" | "drafted" | "dismissed";
  decision: "draft" | "dismiss_angle" | "not_relevant" | "already_covered" | null;
  earlyFollowUp: OpportunityEarlyFollowUp | null;
  sourceItemReferences: SourceItemReference[];
}

export interface ContentShortlist {
  runId: string;
  createdAt: string;
  brandProfileRevisionId: string;
  opportunities: ShortlistOpportunity[];
  omittedCount: number;
  supersededByRunId: string | null;
}

export interface ContentScoutRunResult {
  /** Present only on a source-backfill Run: what was requested and whether the adapter honored it. */
  backfill?: {
    targetId: string;
    windowDays: SourceBackfillWindowDays;
    adapterId: string;
    supported: boolean;
  };
  adapters: {
    adapterId: string;
    state: SourceAdapterState;
    targetsAttempted: number;
    outcome: SourceDiagnosticClassification;
    itemsFound: number;
    durationMs: number;
    retries: number;
    /** Absent only on durable Runs written before Source Adapter diagnostics were completed. */
    lastSuccessfulRequest?: { at: string; route: string } | null;
    /** Absent only on durable Runs written before Source Adapter diagnostics were completed. */
    errorClassifications?: SourceDiagnosticClassification[];
    affectedCapabilities: SourceCapability[];
    attempts: SourceCollectionAttemptReceipt[];
  }[];
  shortlist: { opportunityCount: number; omittedCount: number };
  warnings: number;
  /** Present on a selection Run: the Content Projects each selected Opportunity started (#133). */
  projects?: {
    opportunityId: string;
    projectId: string;
    created: boolean;
  }[];
}

/**
 * The result of a Brand Profile scan Run: evidence counts for the receipt,
 * not the collection receipt a discovery Run carries. The proposal itself
 * lives in the Module's state, not in the Run artifact.
 */
export interface ContentScoutBrandProfileScanRunResult {
  pages: number;
  included: number;
  changedSections: number;
}

export interface SourceCanaryReceipt {
  adapterId: string;
  adapterVersion: string;
  target: SourceAdapterCanaryTarget;
  capability: SourceCapability;
  route: string;
  outcome: SourceDiagnosticClassification;
  diagnostic: AdapterDiagnostic;
  checkedAt: string;
  durationMs: number;
  itemsFound: number;
}

export interface SourceCanaryHealth {
  adapterId: string;
  state: SourceAdapterState;
  version: string;
  canaryTargets: SourceAdapterCanaryTarget[];
  recentReceipts: SourceCanaryReceipt[];
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  degraded: boolean;
  promotionEligible: boolean;
  evidence: {
    requiredSuccesses: number;
    successCount: number;
    version: string;
    recentOutcomes: SourceDiagnosticClassification[];
  };
}

export const CANARY_PROMOTION_REQUIRED_SUCCESSES = 3;
export const CANARY_PROMOTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const CANARY_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const CANARY_MIN_TARGETS = 3;

export function isCanarySuccess(receipt: SourceCanaryReceipt): boolean {
  return receipt.outcome === "items_found" && receipt.itemsFound > 0;
}

export function isCanaryPromotionEligible(input: {
  adapter: { id: string; version: string; canaryTargets?: readonly SourceAdapterCanaryTarget[] };
  receipts: readonly SourceCanaryReceipt[];
  now?: Date;
}): boolean {
  const targets = input.adapter.canaryTargets ?? [];
  if (targets.length < CANARY_MIN_TARGETS) return false;
  const now = input.now ?? new Date();
  const windowStart = now.getTime() - CANARY_PROMOTION_WINDOW_MS;
  for (const target of targets) {
    const forTarget = input.receipts.filter(
      (receipt) =>
        receipt.adapterId === input.adapter.id &&
        receipt.adapterVersion === input.adapter.version &&
        receipt.target.url === target.url &&
        Date.parse(receipt.checkedAt) >= windowStart,
    );
    const successes = forTarget.filter(isCanarySuccess);
    if (successes.length < CANARY_PROMOTION_REQUIRED_SUCCESSES) return false;
    const latest = [...forTarget].sort(
      (a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt),
    )[0];
    if (!latest || !isCanarySuccess(latest)) return false;
  }
  return true;
}

export function canaryHealthForAdapter(input: {
  adapter: {
    id: string;
    state: SourceAdapterState;
    version: string;
    canaryTargets?: readonly SourceAdapterCanaryTarget[];
  };
  receipts: readonly SourceCanaryReceipt[];
  /** The clock the promotion window is measured against; the caller's, not the wall's. */
  now?: Date;
}): SourceCanaryHealth {
  const targets = [...(input.adapter.canaryTargets ?? [])];
  const forAdapter = [...input.receipts]
    .filter(
      (receipt) =>
        receipt.adapterId === input.adapter.id && receipt.adapterVersion === input.adapter.version,
    )
    .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt));
  const recentReceipts = forAdapter.slice(0, 9);
  const lastSuccess = forAdapter.find(isCanarySuccess) ?? null;
  const lastFailure = forAdapter.find((receipt) => !isCanarySuccess(receipt)) ?? null;
  const latestByTarget = new Map<string, SourceCanaryReceipt>();
  for (const receipt of forAdapter) {
    if (!latestByTarget.has(receipt.target.url)) latestByTarget.set(receipt.target.url, receipt);
  }
  const degraded = [...latestByTarget.values()].some((receipt) => !isCanarySuccess(receipt));
  const promotionEligible = isCanaryPromotionEligible({
    adapter: input.adapter,
    receipts: input.receipts,
    ...(input.now ? { now: input.now } : {}),
  });
  return {
    adapterId: input.adapter.id,
    state: input.adapter.state,
    version: input.adapter.version,
    canaryTargets: targets,
    recentReceipts,
    lastSuccessAt: lastSuccess?.checkedAt ?? null,
    lastFailureAt: lastFailure?.checkedAt ?? null,
    degraded,
    promotionEligible,
    evidence: {
      requiredSuccesses: CANARY_PROMOTION_REQUIRED_SUCCESSES,
      successCount: forAdapter.filter(isCanarySuccess).length,
      version: input.adapter.version,
      recentOutcomes: recentReceipts.map((receipt) => receipt.outcome),
    },
  };
}
