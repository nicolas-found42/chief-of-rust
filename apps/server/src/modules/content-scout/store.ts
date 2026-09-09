import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
  BrandProfileRevision,
  BrandProfileRevisionSummary,
  BrandProfileProposal,
  BrandProfileSourceScan,
  ContentScoutScheduleState,
  ContentShortlist,
  OpportunityEarlyFollowUp,
  RankedOpportunity,
  ShortlistOpportunity,
  SourceItemReference,
  SourceSuggestion,
  SourceTarget,
} from "@chief-of-staff-demo/shared";
import type { OpportunityProjectInput } from "../../content-projects/opportunity-projects.js";
import { WorkspaceBrandProfileStore } from "../../brand-profile/store.js";

interface ContentScoutState {
  brandProfiles: Omit<BrandProfileRevision, "markdown">[];
  sourceTargets: SourceTarget[];
  activeShortlist: ContentShortlist | null;
  pendingActions: Record<
    string,
    | { kind: "selection"; opportunityIds: string[]; project: OpportunityProjectInput }
    | { kind: "skip" }
  >;
  sourceSuggestions: SourceSuggestion[];
  schedule: ContentScoutScheduleState;
  brandProfileProposal: BrandProfileProposal | null;
  opportunityDecisions: OpportunityDecisionRecord[];
}

type OpportunityDecision = "draft" | "dismiss_angle" | "not_relevant" | "already_covered";

interface OpportunityDecisionRecord {
  canonicalKey: string;
  angle: string;
  angleDescription?: string;
  evidence?: SourceItemReference[];
  decision: OpportunityDecision;
  decidedAt: string;
}

const EMPTY: ContentScoutState = {
  brandProfiles: [],
  sourceTargets: [],
  activeShortlist: null,
  pendingActions: {},
  sourceSuggestions: [],
  schedule: {
    lastSuccessfulIntakePeriod: null,
    lastSuccessfulDiscoveryPeriod: null,
  },
  brandProfileProposal: null,
  opportunityDecisions: [],
};

function identifier(prefix: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
  return `${prefix}_${stamp}_${randomBytes(4).toString("hex")}`;
}

export class ContentScoutStore {
  private readonly root: string;
  private readonly stateFile: string;
  private readonly brandProfiles: WorkspaceBrandProfileStore;

  constructor(
    workspaceDir: string,
    private readonly now: () => Date,
  ) {
    this.root = join(workspaceDir, "content-scout");
    this.stateFile = join(this.root, "state.json");
    this.brandProfiles = new WorkspaceBrandProfileStore(workspaceDir, now);
  }

  acceptBrandProfile(input: {
    markdown: string;
    sourceScan: BrandProfileSourceScan;
    note?: string | null;
    siteBaselineMarkdown?: string;
  }): BrandProfileRevision {
    return this.brandProfiles.accept(input);
  }

  saveBrandProfileProposal(proposal: BrandProfileProposal): void {
    const state = this.readState();
    state.brandProfileProposal = proposal;
    this.writeState(state);
  }

  brandProfileProposal(): BrandProfileProposal | null {
    return this.readState().brandProfileProposal;
  }

  clearBrandProfileProposal(id: string): void {
    const state = this.readState();
    if (state.brandProfileProposal?.id === id) state.brandProfileProposal = null;
    this.writeState(state);
  }

  currentBrandProfile(): BrandProfileRevision | null {
    return this.brandProfiles.current();
  }

  brandProfile(id: string): BrandProfileRevision | null {
    return this.brandProfiles.get(id);
  }

  listBrandProfiles(): BrandProfileRevisionSummary[] {
    return this.brandProfiles.list();
  }

  addSourceTarget(input: { adapterId: string; label: string; url: string }): SourceTarget {
    const state = this.readState();
    const existing = state.sourceTargets.find(
      (target) => target.adapterId === input.adapterId && target.url === input.url,
    );
    if (existing) {
      return existing;
    }
    const target: SourceTarget = {
      id: identifier("source", this.now()),
      adapterId: input.adapterId,
      label: input.label,
      url: input.url,
      state: "active",
      createdAt: this.now().toISOString(),
      archivedAt: null,
      checkpoint: null,
      lastSuccessfulAt: null,
      conditional: null,
    };
    state.sourceTargets.push(target);
    this.writeState(state);
    return target;
  }

  listSourceTargets(): SourceTarget[] {
    return this.readState().sourceTargets;
  }

  setSourceTargetState(id: string, next: "active" | "archived"): SourceTarget {
    const state = this.readState();
    const target = state.sourceTargets.find((candidate) => candidate.id === id);
    if (!target) throw new Error(`Source Target not found: ${id}`);
    target.state = next;
    target.archivedAt = next === "archived" ? this.now().toISOString() : null;
    this.writeState(state);
    return target;
  }

  recordCollectionSuccess(
    targetId: string,
    checkpoint: string | null,
    conditional: { etag: string | null; lastModified: string | null } | null,
  ): void {
    const state = this.readState();
    const target = state.sourceTargets.find((candidate) => candidate.id === targetId);
    if (!target) {
      return;
    }
    target.checkpoint = checkpoint;
    target.lastSuccessfulAt = this.now().toISOString();
    target.conditional = conditional;
    this.writeState(state);
  }

  installShortlist(shortlist: ContentShortlist): ContentShortlist | null {
    const state = this.readState();
    const previous = state.activeShortlist;
    state.activeShortlist = shortlist;
    this.writeState(state);
    return previous;
  }

  activeShortlist(): ContentShortlist | null {
    return this.readState().activeShortlist;
  }

  recordSelection(runId: string, opportunityIds: string[], project: OpportunityProjectInput): void {
    const state = this.readState();
    const shortlist = state.activeShortlist;
    if (!shortlist || shortlist.runId !== runId) {
      throw new Error("That shortlist is no longer current.");
    }
    const unique = [...new Set(opportunityIds)];
    if (unique.length === 0 || unique.length > 3) {
      throw new Error("Select between one and three Ready opportunities.");
    }
    for (const id of unique) {
      const opportunity = shortlist.opportunities.find((candidate) => candidate.id === id);
      if (!opportunity || opportunity.state !== "ready") {
        throw new Error(`Opportunity is not Ready: ${id}`);
      }
      opportunity.state = "drafted";
      opportunity.decision = "draft";
      this.recordOpportunityDecision(state, opportunity, "draft");
    }
    state.pendingActions[runId] = { kind: "selection", opportunityIds: unique, project };
    this.writeState(state);
  }

  recordSkip(runId: string): void {
    const state = this.readState();
    if (state.activeShortlist?.runId !== runId) {
      throw new Error("That shortlist is no longer current.");
    }
    state.pendingActions[runId] = { kind: "skip" };
    this.writeState(state);
  }

  decideOpportunity(
    runId: string,
    opportunityId: string,
    decision: "dismiss_angle" | "not_relevant" | "already_covered",
  ): void {
    const state = this.readState();
    const shortlist = state.activeShortlist;
    if (!shortlist || shortlist.runId !== runId)
      throw new Error("That shortlist is no longer current.");
    const opportunity = shortlist.opportunities.find((candidate) => candidate.id === opportunityId);
    if (!opportunity || opportunity.state !== "ready")
      throw new Error("That opportunity is no longer Ready.");
    opportunity.state = "dismissed";
    opportunity.decision = decision;
    this.recordOpportunityDecision(state, opportunity, decision);
    this.writeState(state);
  }

  opportunityCooldownDisposition(
    opportunity: RankedOpportunity,
    sourceItemReferences: SourceItemReference[],
  ): { eligible: false } | { eligible: true; earlyFollowUp: OpportunityEarlyFollowUp | null } {
    const cutoff = this.now().getTime() - 7 * 86_400_000;
    const recent = this.readState().opportunityDecisions.filter(
      (decision) =>
        decision.canonicalKey === opportunity.canonicalKey &&
        Date.parse(decision.decidedAt) > cutoff,
    );
    if (recent.length === 0) return { eligible: true, earlyFollowUp: null };

    const sameAngle = recent.filter((decision) => decision.angle === opportunity.angle);
    if (sameAngle.length === 0) {
      const description = opportunity.angleDescription.trim();
      return description
        ? {
            eligible: true,
            earlyFollowUp: {
              kind: "different_angle",
              explanation: `Different angle: ${description}`,
            },
          }
        : { eligible: false };
    }

    const development = opportunity.materialDevelopment;
    if (!development?.explanation.trim()) return { eligible: false };
    if (sameAngle.some((decision) => decision.evidence === undefined)) {
      return { eligible: false };
    }
    const priorEvidence = sameAngle.flatMap((decision) => decision.evidence ?? []);
    const priorIds = new Set(priorEvidence.map((reference) => reference.id));
    const priorUrls = new Set(priorEvidence.map((reference) => reference.canonicalUrl));
    const currentEvidence = new Map(
      sourceItemReferences.map((reference) => [reference.id, reference.canonicalUrl]),
    );
    const hasNewEvidence = development.sourceItemIds.some((id) => {
      const canonicalUrl = currentEvidence.get(id);
      return canonicalUrl !== undefined && !priorIds.has(id) && !priorUrls.has(canonicalUrl);
    });
    return hasNewEvidence
      ? {
          eligible: true,
          earlyFollowUp: {
            kind: "material_development",
            explanation: development.explanation.trim(),
          },
        }
      : { eligible: false };
  }

  private recordOpportunityDecision(
    state: ContentScoutState,
    opportunity: ShortlistOpportunity,
    decision: OpportunityDecision,
  ): void {
    state.opportunityDecisions.push({
      canonicalKey: opportunity.canonicalKey,
      angle: opportunity.angle,
      angleDescription: opportunity.angleDescription,
      ...(Array.isArray(opportunity.sourceItemReferences)
        ? { evidence: opportunity.sourceItemReferences }
        : {}),
      decision,
      decidedAt: this.now().toISOString(),
    });
  }

  pendingAction(runId: string): ContentScoutState["pendingActions"][string] | null {
    return this.readState().pendingActions[runId] ?? null;
  }

  clearPendingAction(runId: string): void {
    const state = this.readState();
    delete state.pendingActions[runId];
    this.writeState(state);
  }

  listSourceSuggestions(): SourceSuggestion[] {
    return this.readState().sourceSuggestions;
  }

  saveSourceSuggestions(
    suggestions: Omit<
      SourceSuggestion,
      "id" | "state" | "discoveredAt" | "decisionReason" | "sourceTargetId"
    >[],
  ): SourceSuggestion[] {
    const state = this.readState();
    const blockedUrls = new Set([
      ...state.sourceTargets.map((target) => target.url),
      ...state.sourceSuggestions
        .filter((suggestion) => suggestion.state === "dismissed" || suggestion.state === "approved")
        .map((suggestion) => suggestion.url),
    ]);
    const added: SourceSuggestion[] = [];
    for (const proposal of suggestions) {
      if (blockedUrls.has(proposal.url)) continue;
      const suggestion: SourceSuggestion = {
        ...proposal,
        id: identifier("suggestion", this.now()),
        state: "proposed",
        discoveredAt: this.now().toISOString(),
        decisionReason: null,
        sourceTargetId: null,
      };
      state.sourceSuggestions.push(suggestion);
      blockedUrls.add(proposal.url);
      added.push(suggestion);
    }
    this.writeState(state);
    return added;
  }

  decideSourceSuggestion(
    id: string,
    decision: "approved" | "dismissed" | "proposed",
    reason: string | null,
  ): SourceSuggestion {
    const state = this.readState();
    const suggestion = state.sourceSuggestions.find((candidate) => candidate.id === id);
    if (!suggestion) throw new Error(`Source Suggestion not found: ${id}`);
    suggestion.state = decision;
    suggestion.decisionReason = reason;
    if (decision === "approved" && !suggestion.sourceTargetId) {
      const existing = state.sourceTargets.find(
        (target) => target.adapterId === suggestion.adapterId && target.url === suggestion.url,
      );
      if (existing) {
        suggestion.sourceTargetId = existing.id;
      } else {
        const target: SourceTarget = {
          id: identifier("source", this.now()),
          adapterId: suggestion.adapterId,
          label: suggestion.label,
          url: suggestion.url,
          state: "active",
          createdAt: this.now().toISOString(),
          archivedAt: null,
          checkpoint: null,
          lastSuccessfulAt: null,
          conditional: null,
        };
        state.sourceTargets.push(target);
        suggestion.sourceTargetId = target.id;
      }
    }
    this.writeState(state);
    return suggestion;
  }

  scheduleState(): ContentScoutScheduleState {
    return this.readState().schedule;
  }

  recordSuccessfulPeriod(kind: "intake" | "discovery", period: string): void {
    const state = this.readState();
    if (kind === "intake") state.schedule.lastSuccessfulIntakePeriod = period;
    else state.schedule.lastSuccessfulDiscoveryPeriod = period;
    this.writeState(state);
  }

  private readState(): ContentScoutState {
    if (!existsSync(this.stateFile)) {
      return structuredClone(EMPTY);
    }
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as Partial<ContentScoutState>;
      return {
        brandProfiles: Array.isArray(parsed.brandProfiles) ? parsed.brandProfiles : [],
        sourceTargets: Array.isArray(parsed.sourceTargets)
          ? parsed.sourceTargets.map((target) => ({
              ...target,
              conditional:
                target.conditional && typeof target.conditional === "object"
                  ? {
                      etag: target.conditional.etag ?? null,
                      lastModified: target.conditional.lastModified ?? null,
                    }
                  : null,
            }))
          : [],
        activeShortlist: parsed.activeShortlist ?? null,
        pendingActions:
          parsed.pendingActions && typeof parsed.pendingActions === "object"
            ? parsed.pendingActions
            : {},
        sourceSuggestions: Array.isArray(parsed.sourceSuggestions) ? parsed.sourceSuggestions : [],
        schedule: {
          lastSuccessfulIntakePeriod: parsed.schedule?.lastSuccessfulIntakePeriod ?? null,
          lastSuccessfulDiscoveryPeriod: parsed.schedule?.lastSuccessfulDiscoveryPeriod ?? null,
        },
        brandProfileProposal: parsed.brandProfileProposal ?? null,
        opportunityDecisions: Array.isArray(parsed.opportunityDecisions)
          ? parsed.opportunityDecisions
          : [],
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private writeState(state: ContentScoutState): void {
    this.writeAtomic(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  private writeAtomic(path: string, text: string): void {
    mkdirSync(this.root, { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, text, "utf8");
    renameSync(temporary, path);
  }
}
