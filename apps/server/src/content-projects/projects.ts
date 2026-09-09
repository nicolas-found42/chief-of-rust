import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTENT_PROJECT_TARGETS,
  CONTENT_ENGINE_UNSUPPORTED_CLAIM_POLICY,
  type AuthorizedAuthorPolicy,
  type ContentProject,
  type ContentProjectAuthorReference,
  type ContentProjectCreateInput,
  type ContentEngineDraft,
  type ContentProjectEvidenceAttachment,
  type ContentProjectEvidenceFreeze,
  type ContentProjectEvidenceSelection,
  type ContentProjectGate,
  type ContentProjectIntentPatch,
  type ContentProjectPromptEvidence,
  type PromptSourceItem,
  type ContentProjectReadiness,
  type ContentProjectRevision,
  type ContentProjectSubject,
  type ContentProjectSummary,
  type ContentProjectTarget,
  type ContentVoiceRevision,
  type OutlineCharter,
  type OutlineCharterApproval,
  type OutlineCharterProposalInput,
  type OutlineSetFailure,
  type OutlineSetOutcome,
  type PlatformOutline,
  type PlatformOutlineApproval,
  type ResearchProviderBundle,
  type ResearchRequest,
  type ResearchRequestInput,
  type ResearchRequestLimits,
  type ResearchRequestScope,
} from "@chief-of-staff-demo/shared";
import type { WorkspaceBrandProfileStore } from "../brand-profile/store.js";
import type { OwnerOnboarding } from "../onboarding/owner.js";
import { runFiniteResearch, uniqueBy, type ResearchProvider } from "./research.js";
import type { WorkspacePersonProfiles } from "../person-profile/profiles.js";
import {
  MAX_GENERATION_INSTRUCTION_LENGTH,
  type ContentEngineDraftGenerator,
  type ContentEngineDraftResult,
  type PlatformOutlineGenerator,
  type PlatformOutlineResult,
} from "./generation.js";

interface ContentProjectState {
  projects: ContentProject[];
  authorPolicies: AuthorizedAuthorPolicy[];
  contentVoices: ContentVoiceRevision[];
}

type ContentProjectRevisionSeed = Omit<
  ContentProjectRevision,
  | "researchRequest"
  | "frozenEvidence"
  | "outlineCharters"
  | "outlineCharterApprovals"
  | "platformOutlines"
  | "platformOutlineApprovals"
  | "drafts"
>;

/**
 * How many sibling Outline generations may be in flight at once when the
 * caller does not name a bound. An implementation policy value: changing it
 * changes how the provider seam is loaded, never what the Project persists.
 */
export const DEFAULT_OUTLINE_SET_CONCURRENCY = 3;

export class ContentProjectError extends Error {
  constructor(
    public readonly code:
      | "invalid-project-input"
      | "owner-not-confirmed"
      | "opportunity-already-linked"
      | "profile-not-found"
      | "author-forbidden"
      | "project-not-found"
      | "evidence-freeze-blocked"
      | "invalid-evidence-selection"
      | "outline-charter-blocked"
      | "outline-charter-not-found"
      | "outline-generation-blocked"
      | "outline-not-found"
      | "outline-not-supported"
      | "draft-generation-blocked"
      | "draft-not-supported"
      | "invalid-provider-result"
      | "invalid-research-request"
      | "research-request-blocked",
    message: string,
    public readonly missingGates: ContentProjectGate[] = [],
  ) {
    super(message);
    this.name = "ContentProjectError";
  }
}

/**
 * The Content Project deep interface from spec #117. It owns durable project
 * intent and author policy while reading canonical owner, Brand Profile, and
 * Person Profile state only through their Workspace-owned interfaces.
 */
export class WorkspaceContentProjects {
  private readonly stateFile: string;
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      workspaceDir: string;
      people: WorkspacePersonProfiles;
      ownerOnboarding: OwnerOnboarding;
      brandProfiles: WorkspaceBrandProfileStore;
      /** The public-research providers a Research Request bundle may be configured from. */
      researchProviders: ResearchProvider[];
      /** The one Outline generation, parameterized by the target contract. */
      outlineGenerator: PlatformOutlineGenerator;
      /** The one Draft generation, parameterized by the target contract. */
      draftGenerator: ContentEngineDraftGenerator;
      now?: () => Date;
    },
  ) {
    this.stateFile = join(deps.workspaceDir, "content-engine", "projects.json");
    this.now = deps.now ?? (() => new Date());
  }

  authorizeAuthor(profileId: string): AuthorizedAuthorPolicy {
    this.requireSelectableProfile(profileId);
    const state = this.readState();
    const existing = state.authorPolicies.find((policy) => policy.profileId === profileId);
    if (existing) return clone(existing);
    const policy = { profileId, authorizedAt: this.now().toISOString() };
    state.authorPolicies.push(policy);
    this.writeState(state);
    return clone(policy);
  }

  approveContentVoice(profileId: string, markdown: string): ContentVoiceRevision {
    this.requireSelectableProfile(profileId);
    const text = requiredText(markdown, "Content Voice");
    if (!this.isAuthorized(profileId)) {
      throw new ContentProjectError(
        "author-forbidden",
        "Authorize this Person Profile before approving its Content Voice.",
      );
    }
    const state = this.readState();
    const prior = state.contentVoices.filter((voice) => voice.profileId === profileId);
    const revision: ContentVoiceRevision = {
      id: identifier("voice", this.now()),
      profileId,
      revision: prior.length + 1,
      markdown: `${text.trimEnd()}\n`,
      approvedAt: this.now().toISOString(),
    };
    state.contentVoices.push(revision);
    this.writeState(state);
    return clone(revision);
  }

  create(input: ContentProjectCreateInput): ContentProject {
    if (input.sourceOpportunity) {
      const linked = this.projectByOpportunity(input.sourceOpportunity.opportunityId);
      if (linked) {
        throw new ContentProjectError(
          "opportunity-already-linked",
          `Opportunity ${input.sourceOpportunity.opportunityId} already seeded Project ${linked.id}; one Opportunity seeds exactly one Project.`,
        );
      }
    }
    const author = this.selectAuthor(input.authorProfileId);
    const revision = this.initialRevision(input, author);
    const timestamp = this.now().toISOString();
    const project: ContentProject = {
      id: identifier("project", this.now()),
      createdAt: timestamp,
      updatedAt: timestamp,
      revisions: [revision],
    };
    const state = this.readState();
    state.projects.push(project);
    this.writeState(state);
    return clone(project);
  }

  /**
   * Every Content Project, newest first, as a summary (#147). `get` needs an id
   * the owner has no way to discover, so a surface that lists Projects had to
   * exist before one could be opened at all.
   */
  list(): ContentProjectSummary[] {
    const state = this.readState();
    return state.projects
      .map((project) => {
        const revision = currentRevision(project);
        const missing = this.missingGates(revision);
        return clone({
          id: project.id,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          revision: revision.revision,
          subject: revision.subject,
          objective: revision.objective,
          audience: revision.audience,
          targets: revision.targets,
          researchMode: revision.researchMode,
          sourceOpportunity: revision.sourceOpportunity,
          readiness: { ready: missing.length === 0, missingGates: missing },
        });
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  get(projectId: string): ContentProject | null {
    const project = this.readState().projects.find((candidate) => candidate.id === projectId);
    return project ? clone(project) : null;
  }

  /** The one Project this Opportunity seeded, when it seeded one (#133). */
  projectByOpportunity(opportunityId: string): ContentProject | null {
    const project = this.readState().projects.find(
      (candidate) => candidate.revisions[0]?.sourceOpportunity?.opportunityId === opportunityId,
    );
    return project ? clone(project) : null;
  }

  reviseIntent(projectId: string, patch: ContentProjectIntentPatch): ContentProjectRevision {
    const state = this.readState();
    const project = requireProject(state, projectId);
    const previous = currentRevision(project);
    const revision = buildRevision({
      revision: previous.revision + 1,
      createdAt: this.now().toISOString(),
      subject:
        patch.subject === undefined ? clone(previous.subject) : this.resolveSubject(patch.subject),
      author: this.selectAuthor(
        patch.authorProfileId ?? previous.author.profileId,
        patch.authorProfileId === undefined ? previous.author.profileRevision : undefined,
      ),
      objective:
        patch.objective === undefined
          ? previous.objective
          : requiredText(patch.objective, "objective"),
      audience:
        patch.audience === undefined ? previous.audience : requiredText(patch.audience, "audience"),
      constraints:
        patch.constraints === undefined
          ? clone(previous.constraints)
          : cleanList(patch.constraints),
      targets: patch.targets === undefined ? previous.targets : patch.targets,
      researchMode: "researchMode" in patch ? (patch.researchMode ?? null) : previous.researchMode,
      seedMaterial:
        patch.seedMaterial === undefined
          ? clone(previous.seedMaterial)
          : cleanList(patch.seedMaterial),
      sourceOpportunity: previous.sourceOpportunity,
      evidenceReview: null,
    });
    project.revisions.push(revision);
    this.touch(project);
    this.writeState(state);
    return clone(revision);
  }

  attachEvidence(
    projectId: string,
    attachment: ContentProjectEvidenceAttachment,
  ): ContentProjectRevision {
    const state = this.readState();
    const project = requireProject(state, projectId);
    let revision = currentRevision(project);
    if (
      revision.frozenEvidence !== null ||
      revision.outlineCharters.length > 0 ||
      revision.outlineCharterApprovals.length > 0
    ) {
      revision = nextRevision(revision, this.now().toISOString());
      project.revisions.push(revision);
    }
    const ids = attachment.sourceItems.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      throw new ContentProjectError(
        "invalid-evidence-selection",
        "Attached Source Items must have unique ids.",
      );
    }
    revision.evidenceReview = {
      attachedAt: this.now().toISOString(),
      sourceItems: clone(attachment.sourceItems),
      diagnostics: clone(attachment.diagnostics),
    };
    this.touch(project);
    this.writeState(state);
    return clone(revision);
  }

  freezeEvidence(
    projectId: string,
    selection: ContentProjectEvidenceSelection,
  ): ContentProjectEvidenceFreeze {
    const state = this.readState();
    const project = requireProject(state, projectId);
    let revision = currentRevision(project);
    if (revision.frozenEvidence !== null) {
      const previous = revision;
      revision = nextRevision(previous, this.now().toISOString(), previous.evidenceReview);
      project.revisions.push(revision);
    }
    const missing = this.missingFreezeGates(revision);
    if (missing.length > 0) {
      throw new ContentProjectError(
        "evidence-freeze-blocked",
        `Evidence cannot be frozen until these gates are present: ${missing.join(", ")}.`,
        missing,
      );
    }
    if (
      revision.researchMode === "no-external-research" &&
      !selection.noExternalResearchAcknowledged
    ) {
      throw new ContentProjectError(
        "evidence-freeze-blocked",
        "No external research requires an explicit acknowledgement.",
        ["no-research-acknowledgement"],
      );
    }
    const review = revision.evidenceReview;
    const selectedIds = [...new Set(selection.includedSourceItemIds)];
    if (revision.researchMode !== "no-external-research" && selectedIds.length === 0) {
      throw new ContentProjectError(
        "evidence-freeze-blocked",
        "External research requires at least one included reviewed Source Item; choose no external research and acknowledge it when no source is selected.",
        ["evidence-review"],
      );
    }
    if (
      revision.researchMode === "no-external-research" &&
      (selectedIds.length > 0 ||
        (review?.sourceItems.length ?? 0) > 0 ||
        (review?.diagnostics.length ?? 0) > 0)
    ) {
      throw new ContentProjectError(
        "invalid-evidence-selection",
        "A no-external-research Project cannot include attached Source Items or diagnostics.",
      );
    }
    const known = new Map(review?.sourceItems.map((item) => [item.id, item]) ?? []);
    if (selectedIds.some((id) => !known.has(id))) {
      throw new ContentProjectError(
        "invalid-evidence-selection",
        "Every included Source Item must come from the attached evidence review.",
      );
    }
    const brandVoice = this.deps.brandProfiles.current()!;
    const contentVoice = this.currentVoice(revision.author.profileId)!;
    const authorProjection = this.deps.people.project("public-safe", revision.author.profileId, {
      revision: revision.author.profileRevision,
    });
    if (authorProjection?.purpose !== "public-safe") {
      throw new ContentProjectError(
        "profile-not-found",
        "The pinned author Profile is unavailable.",
      );
    }
    const profileProjections: ContentProjectEvidenceFreeze["profileProjections"] = [
      { role: "author", projection: authorProjection },
    ];
    if (revision.subject.kind === "person-profile") {
      const subjectProjection = this.deps.people.project(
        "public-safe",
        revision.subject.profileId,
        { revision: revision.subject.profileRevision },
      );
      if (subjectProjection?.purpose !== "public-safe") {
        throw new ContentProjectError(
          "profile-not-found",
          "The pinned subject Person Profile is unavailable.",
        );
      }
      profileProjections.push({ role: "subject", projection: subjectProjection });
    }
    const frozen: ContentProjectEvidenceFreeze = {
      frozenAt: this.now().toISOString(),
      sourceItems: selectedIds.map((id) => known.get(id)!),
      diagnostics: clone(review?.diagnostics ?? []),
      brandVoice: clone(brandVoice),
      contentVoice: clone(contentVoice),
      profileProjections: clone(profileProjections),
      userMaterial: clone(revision.seedMaterial),
      noExternalResearchAcknowledged: selection.noExternalResearchAcknowledged,
    };
    revision.frozenEvidence = frozen;
    this.touch(project);
    this.writeState(state);
    return clone(frozen);
  }

  /**
   * Start and finish one finite Research Request for this Project's current
   * revision. Everything the request needs to be bounded — which providers may
   * be asked, how many questions each may be asked, how much evidence may come
   * back — is stated here, and everything it produces is returned for the owner
   * to include or exclude before freezing. It creates no schedule, no
   * checkpoint, no baseline and no Content Research Named Person watch.
   */
  async runResearchRequest(
    projectId: string,
    input: ResearchRequestInput,
  ): Promise<ResearchRequest> {
    const planned = requireProject(this.readState(), projectId);
    const plannedRevision = currentRevision(planned);
    if (plannedRevision.researchMode !== "fresh-bounded-research") {
      throw new ContentProjectError(
        "research-request-blocked",
        "Only a fresh-bounded-research Project revision may start a Research Request.",
        ["research-mode"],
      );
    }
    const scope: ResearchRequestScope = {
      question: requiredText(input.question, "Research question"),
      terms: cleanList(input.terms),
      subject: clone(plannedRevision.subject),
    };
    const bundle = this.validatedBundle(input.bundle);
    const limits = validatedLimits(input.limits);
    const providers = bundle.providerIds.map((id) => this.requireResearchProvider(id));
    const subjectProfile =
      scope.subject.kind === "person-profile"
        ? this.deps.people.getRevision(scope.subject.profileId, scope.subject.profileRevision)
        : null;
    if (scope.subject.kind === "person-profile" && !subjectProfile) {
      throw new ContentProjectError(
        "profile-not-found",
        "The pinned subject Person Profile revision is unavailable.",
      );
    }

    const result = await runFiniteResearch({
      providers,
      bundle,
      limits,
      scope,
      subjectProfile,
      now: this.now,
    });

    /* Re-read after awaiting the providers: this is the one method that yields,
       so it must not write back a project it read before the pause. */
    const state = this.readState();
    const project = requireProject(state, projectId);
    let revision = currentRevision(project);
    /* The owner may have revised the Project while the providers were in
       flight: the revision this request would land on is re-validated here. */
    if (revision.researchMode !== "fresh-bounded-research") {
      throw new ContentProjectError(
        "research-request-blocked",
        "Only a fresh-bounded-research Project revision may start a Research Request.",
        ["research-mode"],
      );
    }
    const carriedReview = revision.evidenceReview;
    if (
      revision.researchRequest !== null ||
      revision.frozenEvidence !== null ||
      revision.evidenceReview !== null ||
      revision.outlineCharters.length > 0 ||
      revision.outlineCharterApprovals.length > 0
    ) {
      revision = nextRevision(revision, this.now().toISOString());
      project.revisions.push(revision);
    }
    const request: ResearchRequest = {
      id: identifier("research", this.now()),
      projectId,
      projectRevision: revision.revision,
      scope,
      bundle,
      limits,
      ...result,
    };
    revision.researchRequest = clone(request);
    /* Evidence the owner attached before the request runs stays in the review,
       now alongside the research results the owner must vet. */
    revision.evidenceReview = {
      attachedAt: this.now().toISOString(),
      sourceItems: uniqueBy(
        [...(carriedReview?.sourceItems ?? []), ...clone(request.sourceItems)],
        (item) => item.id,
      ),
      diagnostics: [
        ...(carriedReview?.diagnostics ?? []),
        ...request.providerOutcomes.map((outcome) => clone(outcome.diagnostic)),
      ],
    };
    this.touch(project);
    this.writeState(state);
    return clone(request);
  }

  /**
   * The frozen material a Content Engine generator may prompt with. It is a
   * projection, not the revision: diagnostics and Research Request identifier
   * bookkeeping stay on the Project for the owner and never reach a prompt.
   */
  promptEvidence(projectId: string): ContentProjectPromptEvidence | null {
    const project = requireProject(this.readState(), projectId);
    const revision = currentRevision(project);
    const frozen = revision.frozenEvidence;
    if (!frozen) return null;
    return clone({
      projectId,
      projectRevision: revision.revision,
      /* Projected field by field, never spread: the frozen record keeps the
         whole Source Item for the owner, and `PromptSourceItem` names the part
         a model is allowed to read. */
      sourceItems: frozen.sourceItems.map((item): PromptSourceItem => ({
        id: item.id,
        canonicalUrl: item.canonicalUrl,
        author: item.author,
        title: item.title,
        body: item.body,
        description: item.description,
        publishedAt: item.publishedAt,
        ...(item.claims ? { claims: item.claims } : {}),
        transcript: item.transcript,
      })),
      brandVoice: frozen.brandVoice,
      contentVoice: frozen.contentVoice,
      profileProjections: frozen.profileProjections,
      userMaterial: frozen.userMaterial,
    });
  }

  readiness(projectId: string): ContentProjectReadiness {
    const project = requireProject(this.readState(), projectId);
    const revision = currentRevision(project);
    const missing = this.missingGates(revision);
    return { ready: missing.length === 0, missingGates: missing };
  }

  proposeOutlineCharter(projectId: string, input: OutlineCharterProposalInput): OutlineCharter {
    const state = this.readState();
    const project = requireProject(state, projectId);
    const revision = currentRevision(project);
    const missing = this.missingGates(revision);
    if (missing.length > 0) {
      throw new ContentProjectError(
        "outline-charter-blocked",
        `An Outline Charter cannot be proposed until these gates are present: ${missing.join(", ")}.`,
        missing,
      );
    }
    const frozen = revision.frozenEvidence!;
    const selectedIds = new Set(frozen.sourceItems.map((item) => item.id));
    if (input.evidenceMap.some((entry) => entry.sourceItemIds.some((id) => !selectedIds.has(id)))) {
      throw new ContentProjectError(
        "invalid-evidence-selection",
        "The Outline Charter may cite only Source Items in the frozen evidence selection.",
      );
    }
    const brief: OutlineCharter = {
      id: identifier("brief", this.now()),
      projectId,
      projectRevision: revision.revision,
      version: revision.outlineCharters.length + 1,
      proposedAt: this.now().toISOString(),
      subject: clone(revision.subject),
      author: clone(revision.author),
      audience: revision.audience,
      objective: revision.objective,
      constraints: clone(revision.constraints),
      thesis: requiredText(input.thesis, "thesis"),
      angle: requiredText(input.angle, "angle"),
      claims: cleanList(input.claims),
      evidenceMap: clone(input.evidenceMap),
      ctaIntent: input.ctaIntent === null ? null : requiredText(input.ctaIntent, "CTA intent"),
      brandVoiceRevisionId: frozen.brandVoice.id,
      targets: clone(revision.targets),
    };
    revision.outlineCharters.push(brief);
    this.touch(project);
    this.writeState(state);
    return clone(brief);
  }

  approveOutlineCharter(projectId: string, outlineCharterId: string): OutlineCharterApproval {
    const state = this.readState();
    const project = requireProject(state, projectId);
    const revision = currentRevision(project);
    const missing = this.missingGates(revision);
    if (missing.length > 0) {
      throw new ContentProjectError(
        "outline-charter-blocked",
        `An Outline Charter cannot be approved until these gates are present: ${missing.join(", ")}.`,
        missing,
      );
    }
    if (!revision.outlineCharters.some((brief) => brief.id === outlineCharterId)) {
      throw new ContentProjectError(
        "outline-charter-not-found",
        "The Outline Charter does not belong to the current Project revision.",
      );
    }
    const existing = revision.outlineCharterApprovals.find(
      (approval) => approval.outlineCharterId === outlineCharterId,
    );
    if (existing) return clone(existing);
    const approval = { outlineCharterId, approvedAt: this.now().toISOString() };
    revision.outlineCharterApprovals.push(approval);
    this.touch(project);
    this.writeState(state);
    return clone(approval);
  }

  /**
   * Generate one immutable Platform Outline version for one target from the
   * current revision's latest approved Outline Charter. Only an explicitly
   * approved Brief can start generation, and a regeneration instruction is
   * bounded prose that appends a version rather than editing a prior one.
   */
  async generateOutline(
    projectId: string,
    target: ContentProjectTarget,
    input: { instruction?: string } = {},
  ): Promise<PlatformOutline> {
    const instruction = validatedInstruction(input.instruction ?? null);
    return this.runVersionedGeneration({
      projectId,
      plan: (revision) => this.plannedOutlineGeneration(revision, target),
      noEvidence: frozenEvidenceRequired(),
      call: (planned, evidence) =>
        this.deps.outlineGenerator.generate({
          target,
          brief: clone(planned.brief),
          evidence: clone(evidence),
          instruction,
        }),
      changed: (planned, landed) =>
        landed.brief.id === planned.brief.id
          ? null
          : new ContentProjectError(
              "outline-generation-blocked",
              "The Project changed while the Outline was generated; approve the Brief on the current revision and generate again.",
            ),
      build: (landed, result) =>
        buildOutline({
          projectId,
          brief: landed.brief,
          target,
          version: landed.version,
          instruction,
          result,
          approvedEvidenceIds: landed.approvedEvidenceIds,
          now: this.now(),
        }),
      commit: (revision, outline) => revision.platformOutlines.push(outline),
    });
  }

  /**
   * Generate the Outline Set for the current revision's latest approved
   * Outline Charter: the sibling Platform Outlines for every selected target
   * that does not yet hold Outline work citing that Brief, started
   * concurrently within a configured bound. Successful siblings persist when
   * a target fails, so a repeat of this same call is the missing-only retry:
   * it regenerates exactly the missing or failed targets and never
   * duplicates or regenerates existing work.
   */
  async generateOutlineSet(
    projectId: string,
    input: { concurrency?: number } = {},
  ): Promise<OutlineSetOutcome> {
    const concurrency = validatedConcurrency(input.concurrency);
    const state = this.readState();
    const project = requireProject(state, projectId);
    const planned = this.plannedOutlineSet(currentRevision(project));
    const evidence = this.promptEvidence(projectId);
    if (!evidence) throw frozenEvidenceRequired();
    const settled = await runBounded(planned.pending, concurrency, async (target) =>
      this.deps.outlineGenerator.generate({
        target,
        brief: clone(planned.brief),
        evidence: clone(evidence),
        instruction: null,
      }),
    );

    /* Re-read after awaiting the providers: this is a method that yields, so
       it must not write back a project it read before the pause. The set only
       lands on the revision whose approved Brief it was planned from. */
    const landedState = this.readState();
    const landedProject = requireProject(landedState, projectId);
    const landedRevision = currentRevision(landedProject);
    const landedBrief = latestApprovedOutlineCharter(landedRevision);
    if (landedBrief?.id !== planned.brief.id) {
      throw new ContentProjectError(
        "outline-generation-blocked",
        "The Project changed while the Outline Set was generated; approve the Brief on the current revision and generate again.",
      );
    }
    const generated: PlatformOutline[] = [];
    const failures: OutlineSetFailure[] = [];
    for (const [index, target] of planned.pending.entries()) {
      const result = settled[index]!;
      if (result.status === "rejected") {
        failures.push(outlineSetFailure(target, result.reason));
        continue;
      }
      try {
        const outline = buildOutline({
          projectId,
          brief: landedBrief,
          target,
          version: landedRevision.platformOutlines.filter((o) => o.target === target).length + 1,
          instruction: null,
          result: result.value,
          approvedEvidenceIds: new Set(landedBrief.evidenceMap.flatMap((e) => e.sourceItemIds)),
          now: this.now(),
        });
        landedRevision.platformOutlines.push(outline);
        generated.push(outline);
      } catch (error) {
        failures.push(outlineSetFailure(target, error));
      }
    }
    if (generated.length > 0) {
      this.touch(landedProject);
      this.writeState(landedState);
    }
    return clone({
      outlineCharterId: landedBrief.id,
      outlineCharterVersion: landedBrief.version,
      generated,
      failures,
    });
  }

  /** Approve the latest Platform Outline version for one target as the Draft source. */
  approveOutline(projectId: string, target: ContentProjectTarget): PlatformOutlineApproval {
    const state = this.readState();
    const project = requireProject(state, projectId);
    const revision = currentRevision(project);
    const outline = [...revision.platformOutlines]
      .reverse()
      .find((candidate) => candidate.target === target);
    if (!outline) {
      throw new ContentProjectError(
        "outline-not-found",
        `No Platform Outline for the ${target} target exists on the current Project revision.`,
      );
    }
    const existing = revision.platformOutlineApprovals.find(
      (approval) => approval.platformOutlineId === outline.id,
    );
    if (existing) return clone(existing);
    const approval = {
      platformOutlineId: outline.id,
      target,
      approvedAt: this.now().toISOString(),
    };
    revision.platformOutlineApprovals.push(approval);
    this.touch(project);
    this.writeState(state);
    return clone(approval);
  }

  /**
   * Generate one immutable Content Engine Draft version for one target from
   * the current revision's latest approved Platform Outline version. The
   * approved thesis, evidence, and unsupported-claim policy are recomputed
   * here on every call, so a provider answer or a bounded regeneration
   * instruction can never drift them.
   */
  async generateDraft(
    projectId: string,
    target: ContentProjectTarget,
    input: { instruction?: string } = {},
  ): Promise<ContentEngineDraft> {
    const instruction = validatedInstruction(input.instruction ?? null);
    return this.runVersionedGeneration({
      projectId,
      plan: (revision) => this.plannedDraftGeneration(revision, target),
      noEvidence: new ContentProjectError(
        "draft-generation-blocked",
        "Draft generation needs frozen evidence.",
        ["evidence-review"],
      ),
      call: (planned, evidence) =>
        this.deps.draftGenerator.generate({
          target,
          brief: clone(planned.brief),
          outline: clone(planned.outline),
          evidence: clone(evidence),
          instruction,
        }),
      changed: (planned, landed) =>
        landed.outline.id === planned.outline.id
          ? null
          : new ContentProjectError(
              "draft-generation-blocked",
              "The Project changed while the Draft was generated; approve the Outline on the current revision and generate again.",
            ),
      build: (landed, result) =>
        buildDraft({
          projectId,
          brief: landed.brief,
          outline: landed.outline,
          target,
          version: landed.version,
          instruction,
          result,
          approvedEvidenceIds: landed.approvedEvidenceIds,
          now: this.now(),
        }),
      commit: (revision, draft) => revision.drafts.push(draft),
    });
  }

  /**
   * The pipeline both Outline and Draft versions share: a bounded instruction,
   * the approved plan, the frozen prompt evidence, one provider call, and a
   * yield-safe re-read that refuses to land on a Project that changed while
   * the provider ran.
   */
  private async runVersionedGeneration<P, T, R>(input: {
    projectId: string;
    plan(revision: ContentProjectRevision): P;
    noEvidence: ContentProjectError;
    call(planned: P, evidence: ContentProjectPromptEvidence): Promise<T>;
    changed(planned: P, landed: P): ContentProjectError | null;
    build(landed: P, result: T): R;
    commit(revision: ContentProjectRevision, record: R): void;
  }): Promise<R> {
    const state = this.readState();
    const project = requireProject(state, input.projectId);
    const planned = input.plan(currentRevision(project));
    const evidence = this.promptEvidence(input.projectId);
    if (!evidence) throw input.noEvidence;
    const result = await input.call(planned, evidence);

    /* Re-read after awaiting the provider: this is a method that yields, so it
       must not write back a project it read before the pause. If the owner
       revised the Project while the provider ran, the approval sequence
       restarted, the plan no longer matches, and the generation is refused
       rather than landed on the new revision. */
    const landedState = this.readState();
    const landedProject = requireProject(landedState, input.projectId);
    const landed = input.plan(currentRevision(landedProject));
    const changed = input.changed(planned, landed);
    if (changed) throw changed;
    const record = input.build(landed, result);
    input.commit(currentRevision(landedProject), record);
    this.touch(landedProject);
    this.writeState(landedState);
    return clone(record);
  }

  /**
   * The gates and the approved Brief every Platform Outline generation — one
   * target or the whole set — is planned from.
   */
  private plannedBrief(revision: ContentProjectRevision): OutlineCharter {
    const missing = this.missingGates(revision);
    if (missing.length > 0) {
      throw new ContentProjectError(
        "outline-generation-blocked",
        `Platform Outline generation needs these gates first: ${missing.join(", ")}.`,
        missing,
      );
    }
    const brief = latestApprovedOutlineCharter(revision);
    if (!brief) {
      throw new ContentProjectError(
        "outline-generation-blocked",
        "Only an approved immutable Outline Charter can start Platform Outline generation.",
      );
    }
    return brief;
  }

  private plannedOutlineGeneration(
    revision: ContentProjectRevision,
    target: ContentProjectTarget,
  ): {
    brief: OutlineCharter;
    version: number;
    approvedEvidenceIds: Set<string>;
  } {
    const brief = this.plannedBrief(revision);
    if (!revision.targets.includes(target)) {
      throw new ContentProjectError(
        "outline-not-supported",
        `The Project revision does not select the ${target} target.`,
      );
    }
    return {
      brief,
      version: revision.platformOutlines.filter((outline) => outline.target === target).length + 1,
      approvedEvidenceIds: new Set(brief.evidenceMap.flatMap((entry) => entry.sourceItemIds)),
    };
  }

  /**
   * The set-level plan behind `generateOutlineSet`: the approved Brief every
   * sibling is generated from, and the targets still missing Outline work that
   * cites that Brief. The missing-only rule lives here, not with callers.
   */
  private plannedOutlineSet(revision: ContentProjectRevision): {
    brief: OutlineCharter;
    pending: ContentProjectTarget[];
  } {
    const brief = this.plannedBrief(revision);
    const pending = brief.targets.filter(
      (target) =>
        !revision.platformOutlines.some(
          (outline) => outline.target === target && outline.outlineCharterId === brief.id,
        ),
    );
    return { brief, pending };
  }

  private plannedDraftGeneration(
    revision: ContentProjectRevision,
    target: ContentProjectTarget,
  ): {
    brief: OutlineCharter;
    outline: PlatformOutline;
    version: number;
    approvedEvidenceIds: Set<string>;
  } {
    const missing = this.missingGates(revision);
    if (missing.length > 0) {
      throw new ContentProjectError(
        "draft-generation-blocked",
        `Draft generation needs these gates first: ${missing.join(", ")}.`,
        missing,
      );
    }
    const outline = latestApprovedPlatformOutline(revision, target);
    if (!outline) {
      throw new ContentProjectError(
        "draft-generation-blocked",
        "Only an approved Platform Outline version can generate a Draft.",
      );
    }
    if (!revision.targets.includes(target)) {
      throw new ContentProjectError(
        "draft-not-supported",
        `The Project revision does not select the ${target} target.`,
      );
    }
    const brief = revision.outlineCharters.find(
      (candidate) => candidate.id === outline.outlineCharterId,
    );
    if (!brief) {
      throw new ContentProjectError(
        "draft-generation-blocked",
        "The approved Platform Outline no longer names its Outline Charter.",
      );
    }
    return {
      brief,
      outline,
      version: revision.drafts.filter((draft) => draft.target === target).length + 1,
      approvedEvidenceIds: new Set(brief.evidenceMap.flatMap((entry) => entry.sourceItemIds)),
    };
  }

  private initialRevision(
    input: ContentProjectCreateInput,
    author: ContentProjectAuthorReference,
  ): ContentProjectRevision {
    const objective = requiredText(input.objective, "objective");
    const audience = requiredText(input.audience, "audience");
    const subject = this.resolveSubject(input.subject);
    return buildRevision({
      revision: 1,
      createdAt: this.now().toISOString(),
      subject,
      author,
      objective,
      audience,
      constraints: cleanList(input.constraints),
      targets: input.targets,
      researchMode: input.researchMode,
      seedMaterial: cleanList(input.seedMaterial),
      sourceOpportunity: input.sourceOpportunity
        ? { ...clone(input.sourceOpportunity), recordedAt: this.now().toISOString() }
        : null,
      evidenceReview: null,
    });
  }

  private resolveSubject(input: ContentProjectCreateInput["subject"]): ContentProjectSubject {
    if (input.kind === "topic") {
      return { kind: "topic", topic: requiredText(input.topic, "Topic") };
    }
    const profile = this.requireSelectableProfile(input.profileId);
    return { kind: "person-profile", profileId: profile.id, profileRevision: profile.revision };
  }

  private selectAuthor(
    profileId?: string,
    pinnedProfileRevision?: number,
  ): ContentProjectAuthorReference {
    const owner = this.deps.ownerOnboarding.confirmed();
    const selectedProfileId = profileId ?? owner?.profileId;
    if (!selectedProfileId) {
      throw new ContentProjectError(
        "owner-not-confirmed",
        "Confirm the canonical owner Profile before using the default author.",
      );
    }
    if (owner?.profileId === selectedProfileId) {
      const confirmedRevision = this.deps.people.getRevision(
        owner.profileId,
        owner.profileRevision,
      );
      if (!confirmedRevision) {
        throw new ContentProjectError(
          "profile-not-found",
          "The onboarding-confirmed owner Profile revision is unavailable.",
        );
      }
      return { profileId: owner.profileId, profileRevision: owner.profileRevision };
    }
    const profile = this.requireSelectableProfile(selectedProfileId);
    if (!this.hasApprovedAuthor(profile.id)) {
      throw new ContentProjectError(
        "author-forbidden",
        "Another Person Profile is selectable only after author authorization and Content Voice approval.",
      );
    }
    if (
      pinnedProfileRevision !== undefined &&
      !this.deps.people.getRevision(profile.id, pinnedProfileRevision)
    ) {
      throw new ContentProjectError(
        "profile-not-found",
        "The pinned author Person Profile revision is unavailable.",
      );
    }
    return {
      profileId: profile.id,
      profileRevision: pinnedProfileRevision ?? profile.revision,
    };
  }

  private validatedBundle(bundle: ResearchProviderBundle): ResearchProviderBundle {
    const providerIds = cleanList(bundle.providerIds);
    if (providerIds.length === 0) {
      throw new ContentProjectError(
        "invalid-research-request",
        "A Research Request needs at least one configured research provider.",
      );
    }
    if (new Set(providerIds).size !== providerIds.length) {
      throw new ContentProjectError(
        "invalid-research-request",
        "A research provider may appear only once in a Research Request bundle.",
      );
    }
    return { providerIds, completeness: bundle.completeness };
  }

  private requireResearchProvider(providerId: string): ResearchProvider {
    const provider = this.deps.researchProviders.find((candidate) => candidate.id === providerId);
    if (!provider) {
      throw new ContentProjectError(
        "invalid-research-request",
        `No research provider is configured with id ${providerId}.`,
      );
    }
    return provider;
  }

  private requireSelectableProfile(profileId: string) {
    const profile = this.deps.people.get(profileId);
    if (!profile || profile.archivedAt !== null) {
      throw new ContentProjectError(
        "profile-not-found",
        `No active Person Profile exists with id ${profileId}.`,
      );
    }
    return profile;
  }

  private hasApprovedAuthor(profileId: string): boolean {
    const state = this.readState();
    return (
      state.authorPolicies.some((policy) => policy.profileId === profileId) &&
      state.contentVoices.some((voice) => voice.profileId === profileId)
    );
  }

  private currentVoice(profileId: string): ContentVoiceRevision | null {
    return (
      this.readState()
        .contentVoices.filter((voice) => voice.profileId === profileId)
        .at(-1) ?? null
    );
  }

  private missingFreezeGates(revision: ContentProjectRevision): ContentProjectGate[] {
    const missing: ContentProjectGate[] = [];
    if (!this.deps.brandProfiles.current()) missing.push("brand-voice");
    if (!this.currentVoice(revision.author.profileId)) missing.push("content-voice");
    if (revision.researchMode === null) {
      missing.push("research-mode");
    } else if (
      revision.researchMode !== "no-external-research" &&
      (revision.evidenceReview === null || revision.evidenceReview.sourceItems.length === 0)
    ) {
      missing.push("evidence-review");
    }
    return missing;
  }

  private missingGates(revision: ContentProjectRevision): ContentProjectGate[] {
    const missing: ContentProjectGate[] = [];
    const owner = this.deps.ownerOnboarding.confirmed();
    if (!owner) missing.push("canonical-owner");
    if (!revision.frozenEvidence?.brandVoice && !this.deps.brandProfiles.current()) {
      missing.push("brand-voice");
    }
    const authorAuthorized =
      owner?.profileId === revision.author.profileId ||
      this.readState().authorPolicies.some(
        (policy) => policy.profileId === revision.author.profileId,
      );
    if (!authorAuthorized) missing.push("author-authority");
    if (!revision.frozenEvidence?.contentVoice && !this.currentVoice(revision.author.profileId)) {
      missing.push("content-voice");
    }
    if (!revision.researchMode) missing.push("research-mode");
    if (!revision.frozenEvidence) missing.push("evidence-review");
    if (
      revision.researchMode === "no-external-research" &&
      !revision.frozenEvidence?.noExternalResearchAcknowledged
    ) {
      missing.push("no-research-acknowledgement");
    }
    if (revision.targets.length === 0) missing.push("target");
    return missing;
  }

  private isAuthorized(profileId: string): boolean {
    const owner = this.deps.ownerOnboarding.confirmed();
    return (
      owner?.profileId === profileId ||
      this.readState().authorPolicies.some((policy) => policy.profileId === profileId)
    );
  }

  private readState(): ContentProjectState {
    if (!existsSync(this.stateFile)) return { projects: [], authorPolicies: [], contentVoices: [] };
    try {
      const parsed = JSON.parse(
        readFileSync(this.stateFile, "utf8"),
      ) as Partial<ContentProjectState>;
      return {
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        authorPolicies: Array.isArray(parsed.authorPolicies) ? parsed.authorPolicies : [],
        contentVoices: Array.isArray(parsed.contentVoices) ? parsed.contentVoices : [],
      };
    } catch {
      return { projects: [], authorPolicies: [], contentVoices: [] };
    }
  }

  private writeState(state: ContentProjectState): void {
    mkdirSync(join(this.deps.workspaceDir, "content-engine"), { recursive: true });
    const temporary = `${this.stateFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(temporary, this.stateFile);
  }

  private touch(project: ContentProject): void {
    project.updatedAt = this.now().toISOString();
  }
}

function requireProject(state: ContentProjectState, projectId: string): ContentProject {
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new ContentProjectError(
      "project-not-found",
      `No Content Project exists with id ${projectId}.`,
    );
  }
  return project;
}

function currentRevision(project: ContentProject): ContentProjectRevision {
  const revision = project.revisions.at(-1);
  if (!revision)
    throw new ContentProjectError("project-not-found", "The Content Project has no revision.");
  return revision;
}

/**
 * The one refusal both Outline generation paths share when a Project has no
 * frozen evidence to prompt with.
 */
function frozenEvidenceRequired(): ContentProjectError {
  return new ContentProjectError(
    "outline-generation-blocked",
    "Platform Outline generation needs frozen evidence.",
    ["evidence-review"],
  );
}

function latestApproved<T>(
  items: readonly T[],
  approvedIds: ReadonlySet<string>,
  matches: (item: T) => boolean,
  idOf: (item: T) => string,
): T | null {
  return [...items].reverse().find((item) => matches(item) && approvedIds.has(idOf(item))) ?? null;
}

function latestApprovedOutlineCharter(revision: ContentProjectRevision): OutlineCharter | null {
  return latestApproved(
    revision.outlineCharters,
    new Set(revision.outlineCharterApprovals.map((approval) => approval.outlineCharterId)),
    () => true,
    (brief) => brief.id,
  );
}

function latestApprovedPlatformOutline(
  revision: ContentProjectRevision,
  target: ContentProjectTarget,
): PlatformOutline | null {
  return latestApproved(
    revision.platformOutlines,
    new Set(revision.platformOutlineApprovals.map((approval) => approval.platformOutlineId)),
    (outline) => outline.target === target,
    (outline) => outline.id,
  );
}

function validatedInstruction(instruction: string | null): string | null {
  if (instruction === null) return null;
  const text = requiredText(instruction, "regeneration instruction");
  if (text.length > MAX_GENERATION_INSTRUCTION_LENGTH) {
    throw new ContentProjectError(
      "invalid-project-input",
      `A generation instruction is bounded to ${MAX_GENERATION_INSTRUCTION_LENGTH} characters.`,
    );
  }
  return text;
}

function validatedConcurrency(bound: number | undefined): number {
  if (bound === undefined) return DEFAULT_OUTLINE_SET_CONCURRENCY;
  if (!Number.isInteger(bound) || bound < 1) {
    throw new ContentProjectError(
      "invalid-project-input",
      "The Outline Set concurrency bound must be a positive whole number.",
    );
  }
  return bound;
}

/**
 * Run one worker per item with at most `bound` workers in flight, preserving
 * item order in the settled results. A worker's rejection never stops the
 * other items: partial success is the point.
 */
async function runBounded<T, R>(
  items: readonly T[],
  bound: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  /* Each lane claims one index at a time and always settles the one it
     claimed, so every index is written exactly once before this resolves. */
  const settled = new Map<number, PromiseSettledResult<R>>();
  let next = 0;
  const lanes = Array.from({ length: Math.min(bound, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        const value = await worker(items[index]!);
        settled.set(index, { status: "fulfilled", value });
      } catch (error) {
        settled.set(index, { status: "rejected", reason: error });
      }
    }
  });
  await Promise.all(lanes);
  return items.map((_, index) => settled.get(index)!);
}

/**
 * A set path failure is either a provider that never answered in the
 * Outline's Result Shape, or an answer the Content Project refused as a
 * provider-contract violation. Any other Content Project code a provider
 * adapter might raise is not a result-shape fact, so it reports as
 * `provider-failed` with its message intact.
 */
function outlineSetFailure(target: ContentProjectTarget, error: unknown): OutlineSetFailure {
  const code =
    error instanceof ContentProjectError && error.code === "invalid-provider-result"
      ? "invalid-provider-result"
      : "provider-failed";
  const message = error instanceof Error ? error.message : String(error);
  return { target, code, message };
}

function providerText(value: string, label: string): string {
  const text = value.trim();
  if (!text) {
    throw new ContentProjectError("invalid-provider-result", `${label} is required.`);
  }
  return text;
}

function buildOutline(input: {
  projectId: string;
  brief: OutlineCharter;
  target: ContentProjectTarget;
  version: number;
  instruction: string | null;
  result: PlatformOutlineResult;
  approvedEvidenceIds: Set<string>;
  now: Date;
}): PlatformOutline {
  if (input.result.beats.length === 0) {
    throw new ContentProjectError(
      "invalid-provider-result",
      "A Platform Outline needs at least one beat.",
    );
  }
  const beats = input.result.beats.map((beat, index) => {
    if (beat.evidence.sourceItemIds.some((id) => !input.approvedEvidenceIds.has(id))) {
      throw new ContentProjectError(
        "invalid-provider-result",
        "The Platform Outline may cite only Source Items in the approved Brief's evidence map.",
      );
    }
    return {
      position: index + 1,
      direction: providerText(beat.direction, "Beat direction"),
      evidence: {
        claim: providerText(beat.evidence.claim, "Beat evidence claim"),
        sourceItemIds: [...beat.evidence.sourceItemIds],
      },
      examples: cleanList(beat.examples),
    };
  });
  return {
    id: identifier("outline", input.now),
    projectId: input.projectId,
    projectRevision: input.brief.projectRevision,
    target: input.target,
    outlineCharterId: input.brief.id,
    outlineCharterVersion: input.brief.version,
    version: input.version,
    generatedAt: input.now.toISOString(),
    instruction: input.instruction,
    title: providerText(input.result.title, "Outline title"),
    hookDirection: providerText(input.result.hookDirection, "Outline hook direction"),
    thesis: input.brief.thesis,
    beats,
    ctaIntent: input.brief.ctaIntent,
    targetLength: providerText(input.result.targetLength, "Outline target length"),
    constraints: clone(input.brief.constraints),
    warnings: cleanList(input.result.warnings),
    productionNotes: cleanList(input.result.productionNotes),
  };
}

function buildDraft(input: {
  projectId: string;
  brief: OutlineCharter;
  outline: PlatformOutline;
  target: ContentProjectTarget;
  version: number;
  instruction: string | null;
  result: ContentEngineDraftResult;
  approvedEvidenceIds: Set<string>;
  now: Date;
}): ContentEngineDraft {
  return {
    id: identifier("draft", input.now),
    projectId: input.projectId,
    projectRevision: input.outline.projectRevision,
    target: input.target,
    platformOutlineId: input.outline.id,
    outlineVersion: input.outline.version,
    version: input.version,
    generatedAt: input.now.toISOString(),
    instruction: input.instruction,
    copy: providerText(input.result.copy, "Draft copy"),
    thesis: input.brief.thesis,
    evidence: clone(input.brief.evidenceMap),
    claims: input.result.claims.map((claim) => {
      const sourceItemIds = [...claim.sourceItemIds];
      return {
        text: providerText(claim.text, "Draft claim text"),
        sourceItemIds,
        supported:
          sourceItemIds.length > 0 &&
          sourceItemIds.every((id) => input.approvedEvidenceIds.has(id)),
      };
    }),
    unsupportedClaimPolicy: CONTENT_ENGINE_UNSUPPORTED_CLAIM_POLICY,
    productionNotes: cleanList(input.result.productionNotes),
  };
}

function buildRevision(seed: ContentProjectRevisionSeed): ContentProjectRevision {
  return {
    ...seed,
    subject: clone(seed.subject),
    author: clone(seed.author),
    constraints: cleanList(seed.constraints),
    targets: validatedTargets(seed.targets),
    seedMaterial: cleanList(seed.seedMaterial),
    sourceOpportunity: clone(seed.sourceOpportunity),
    evidenceReview: clone(seed.evidenceReview),
    researchRequest: null,
    frozenEvidence: null,
    outlineCharters: [],
    outlineCharterApprovals: [],
    platformOutlines: [],
    platformOutlineApprovals: [],
    drafts: [],
  };
}

function nextRevision(
  previous: ContentProjectRevision,
  createdAt: string,
  evidenceReview: ContentProjectRevision["evidenceReview"] = null,
): ContentProjectRevision {
  return buildRevision({
    revision: previous.revision + 1,
    createdAt,
    subject: previous.subject,
    author: previous.author,
    objective: previous.objective,
    audience: previous.audience,
    constraints: previous.constraints,
    targets: previous.targets,
    researchMode: previous.researchMode,
    seedMaterial: previous.seedMaterial,
    sourceOpportunity: previous.sourceOpportunity,
    evidenceReview,
  });
}

function requiredText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new ContentProjectError("invalid-project-input", `${label} is required.`);
  return text;
}

function validatedLimits(limits: ResearchRequestLimits): ResearchRequestLimits {
  for (const [label, value] of [
    ["maxQueriesPerProvider", limits.maxQueriesPerProvider],
    ["maxSourceItems", limits.maxSourceItems],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new ContentProjectError(
        "invalid-research-request",
        `A Research Request needs a positive whole ${label} limit.`,
      );
    }
  }
  return { ...limits };
}

function cleanList(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function validatedTargets(
  values: ContentProjectRevision["targets"],
): ContentProjectRevision["targets"] {
  if (values.some((target) => !CONTENT_PROJECT_TARGETS.includes(target))) {
    throw new ContentProjectError(
      "invalid-project-input",
      "The Project contains an unknown target.",
    );
  }
  return [...new Set(values)];
}

function identifier(prefix: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
  return `${prefix}_${stamp}_${randomBytes(4).toString("hex")}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
