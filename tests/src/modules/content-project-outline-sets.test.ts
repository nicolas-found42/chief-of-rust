import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTENT_ENGINE_UNSUPPORTED_CLAIM_POLICY,
  CONTENT_PROJECT_TARGETS,
  CONTENT_TARGET_CATALOG,
  contentEngineDraftMarkdown,
  platformOutlineMarkdown,
  type ContentEngineDraft,
  type ContentProject,
  type ContentProjectTarget,
  type OutlineCharter,
  type OutlineSetOutcome,
} from "@chief-of-staff-demo/shared";
import {
  DIAGNOSTIC,
  NOW,
  SOURCE_ITEM,
  SOURCE_ITEM_2,
  stubDraftGenerator,
} from "./content-project-fixtures";
import { WorkspaceBrandProfileStore } from "../../../apps/server/src/brand-profile/store";
import type {
  ContentEngineDraftGenerator,
  DraftGenerationRequest,
  OutlineGenerationRequest,
  PlatformOutlineGenerator,
  PlatformOutlineResult,
} from "../../../apps/server/src/content-projects/generation";
import {
  ContentProjectError,
  DEFAULT_OUTLINE_SET_CONCURRENCY,
  WorkspaceContentProjects,
} from "../../../apps/server/src/content-projects/projects";
import { OwnerOnboarding } from "../../../apps/server/src/onboarding/owner";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";

const BASE_RESULT: PlatformOutlineResult = {
  title: "A grounded case for immutable inputs",
  hookDirection: "Open with the reproducibility failure the owner knows.",
  targetLength: "900 to 1,200 characters",
  beats: [
    {
      direction: "Name the editable-input problem.",
      evidence: { claim: "Frozen inputs preserve lineage.", sourceItemIds: [SOURCE_ITEM.id] },
      examples: ["The evidence review queue"],
    },
    {
      direction: "Show the approved-Brief path.",
      evidence: {
        claim: "Immutable approved inputs make generated content reproducible.",
        sourceItemIds: [],
      },
      examples: [],
    },
  ],
  warnings: ["The second beat rests on the thesis, not on a frozen source."],
  productionNotes: ["Draft the hook last."],
};

function fakeDraftProvider(target: ContentProjectTarget): {
  target: ContentProjectTarget;
  provider: ContentEngineDraftGenerator;
  calls: DraftGenerationRequest[];
} {
  const calls: DraftGenerationRequest[] = [];
  return {
    target,
    calls,
    provider: {
      async generate(request) {
        calls.push(structuredClone(request));
        return {
          copy: `${target} copy from outline v${request.outline.version}: ${request.outline.thesis}`,
          productionNotes: ["Paste-ready copy."],
          claims: [
            { text: "Frozen inputs preserve lineage.", sourceItemIds: [SOURCE_ITEM.id] },
            { text: "An author-supplied flourish.", sourceItemIds: [] },
          ],
        };
      },
    },
  };
}

/** Routes each Draft generation call to the per-target fake bound to that target. */
function draftGeneratorFor(
  fakes: ReturnType<typeof fakeDraftProvider>[],
): ContentEngineDraftGenerator {
  const byTarget = new Map(fakes.map((fake) => [fake.target, fake.provider]));
  return {
    async generate(request) {
      const provider = byTarget.get(request.target);
      if (!provider) throw new Error(`No Draft fake is bound to the ${request.target} target.`);
      return provider.generate(request);
    },
  };
}

/**
 * One Outline generation serving every selected target, with deterministic fault
 * injection. `hold` blocks every call after it has been recorded until
 * `releaseAll()`, so the concurrency bound is observed without wall-clock
 * waits: when the bound is 2, exactly two calls can have arrived before the
 * test releases them, and an unbounded implementation would have arrived with
 * all nine.
 */
interface OutlineSetHarness {
  outlineGenerator: PlatformOutlineGenerator;
  calls: Array<{ target: ContentProjectTarget; request: OutlineGenerationRequest }>;
  /** Resolves once `count` calls have arrived and are held (requires `hold`). */
  held(count: number): Promise<void>;
  releaseAll(): void;
}

function fakeOutlineSetProviders(
  options: {
    hold?: boolean;
    /** The target whose provider rejects its first call, then succeeds (a healable failure). */
    failFirstCall?: ContentProjectTarget;
    /** The target whose provider always rejects. */
    alwaysReject?: ContentProjectTarget;
    /** The target whose provider returns an unapproved citation on its first call. */
    badCitation?: ContentProjectTarget;
  } = {},
): OutlineSetHarness {
  const calls: OutlineSetHarness["calls"] = [];
  const gates = new Map<number, PromiseWithResolvers<void>>();
  let released = false;
  let waiter: { count: number; resolve: () => void } | null = null;
  const attempts = new Map<ContentProjectTarget, number>();
  const outlineGenerator: PlatformOutlineGenerator = {
    async generate(request) {
      const target = request.target;
      const attempt = (attempts.get(target) ?? 0) + 1;
      attempts.set(target, attempt);
      const index = calls.push({ target, request: structuredClone(request) }) - 1;
      if (waiter && calls.length === waiter.count) waiter.resolve();
      if (options.hold && !released) {
        const gate = Promise.withResolvers<void>();
        gates.set(index, gate);
        await gate.promise;
      }
      if (options.alwaysReject === target || (options.failFirstCall === target && attempt === 1)) {
        throw new Error(`The ${target} generation is unavailable.`);
      }
      if (options.badCitation === target && attempt === 1) {
        return {
          ...structuredClone(BASE_RESULT),
          beats: [
            {
              direction: "Name the problem.",
              evidence: { claim: "Not frozen.", sourceItemIds: ["source_404"] },
              examples: [],
            },
          ],
        };
      }
      return structuredClone(BASE_RESULT);
    },
  };
  return {
    outlineGenerator,
    calls,
    held(count) {
      if (calls.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiter = { count, resolve };
      });
    },
    releaseAll() {
      released = true;
      for (const gate of gates.values()) gate.resolve();
    },
  };
}

function setupWorkspace(generators: {
  outlineGenerator: PlatformOutlineGenerator;
  draftGenerator: ContentEngineDraftGenerator;
}): { workspaceDir: string; people: WorkspacePersonProfiles; projects: WorkspaceContentProjects } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "content-outline-sets-"));
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    now: () => NOW,
    lifecycle: [],
  });
  const owner = people.create({ fullName: "Workspace Owner", primaryEmail: "owner@example.com" });
  const ownerOnboarding = new OwnerOnboarding({ people, workspaceDir, now: () => NOW });
  ownerOnboarding.setConnectedIdentity("owner@example.com");
  ownerOnboarding.confirm(owner.id);
  const brandProfiles = new WorkspaceBrandProfileStore(workspaceDir, () => NOW);
  const projects = new WorkspaceContentProjects({
    workspaceDir,
    people,
    ownerOnboarding,
    brandProfiles,
    researchProviders: [],
    outlineGenerator: generators.outlineGenerator,
    draftGenerator: generators.draftGenerator,
    now: () => NOW,
  });
  projects.approveContentVoice(owner.id, "Clear, practical, and evidence-led.");
  brandProfiles.accept({
    markdown: "# Brand Profile\n\n## Voice\nUseful and specific.",
    sourceScan: {
      websiteUrl: "https://brand.example/",
      includedUrls: ["https://brand.example/"],
      excludedUrls: [],
    },
  });
  return { workspaceDir, people, projects };
}

interface ApprovedSetup {
  projects: WorkspaceContentProjects;
  project: ContentProject;
  brief: OutlineCharter;
}

/** A ready Project revision: gates present, evidence frozen, Brief proposed and approved. */
function setupApprovedProject(
  targets: readonly ContentProjectTarget[],
  generators: {
    outlineGenerator: PlatformOutlineGenerator;
    draftGenerator?: ContentEngineDraftGenerator;
  },
): ApprovedSetup {
  const { projects } = setupWorkspace({
    outlineGenerator: generators.outlineGenerator,
    draftGenerator: generators.draftGenerator ?? stubDraftGenerator(),
  });
  const project = projects.create({
    subject: { kind: "topic", topic: "Immutable approved inputs beat in-app editors" },
    objective: "establish-authority",
    audience: "Engineering leaders",
    constraints: ["Separate facts from author claims"],
    targets: [...targets],
    researchMode: "existing-workspace-evidence",
    seedMaterial: ["The audience already generates daily posts."],
  });
  projects.attachEvidence(project.id, {
    sourceItems: [SOURCE_ITEM, SOURCE_ITEM_2],
    diagnostics: [DIAGNOSTIC],
  });
  projects.freezeEvidence(project.id, {
    includedSourceItemIds: [SOURCE_ITEM.id, SOURCE_ITEM_2.id],
    noExternalResearchAcknowledged: false,
  });
  const brief = projects.proposeOutlineCharter(project.id, {
    thesis: "Immutable approved inputs make generated content reproducible.",
    angle: "Treat evidence review as product state, not workflow discipline.",
    claims: ["Frozen inputs preserve lineage."],
    evidenceMap: [{ claim: "Frozen inputs preserve lineage.", sourceItemIds: [SOURCE_ITEM.id] }],
    ctaIntent: "Approve the Brief before generating.",
  });
  projects.approveOutlineCharter(project.id, brief.id);
  return { projects, project, brief };
}

function storedRevision(projects: WorkspaceContentProjects, projectId: string) {
  return projects.get(projectId)!.revisions[0];
}

describe("The versioned nine-target catalog (#132)", () => {
  it("holds exactly the nine approved platform/format targets with distinct versioned Outline and Draft contracts", () => {
    expect(CONTENT_TARGET_CATALOG.map((entry) => entry.target)).toEqual([
      "linkedin-standard-post",
      "linkedin-carousel",
      "linkedin-long-article",
      "website-blog-article",
      "email-newsletter",
      "youtube-short",
      "youtube-long-video",
      "instagram-reel",
      "tiktok-video",
    ]);
    expect(new Set(CONTENT_TARGET_CATALOG.map((entry) => entry.target)).size).toBe(9);
    expect(CONTENT_PROJECT_TARGETS).toEqual(CONTENT_TARGET_CATALOG.map((entry) => entry.target));
    const platforms = new Set<string>();
    for (const entry of CONTENT_TARGET_CATALOG) {
      expect(entry.contractVersion).toBe(1);
      expect(entry.contract.platform.trim()).not.toBe("");
      expect(entry.contract.format.trim()).not.toBe("");
      expect(entry.contract.outlineResult.trim()).not.toBe("");
      expect(entry.contract.draftResult.trim()).not.toBe("");
      platforms.add(entry.contract.platform);
    }
    // Nine targets are nine contracts, not one shape restated nine times.
    expect(platforms.size).toBeGreaterThan(1);
    expect(new Set(CONTENT_TARGET_CATALOG.map((entry) => entry.contract.outlineResult)).size).toBe(
      9,
    );
    expect(
      new Set(
        CONTENT_TARGET_CATALOG.map((entry) =>
          JSON.stringify([
            entry.contract.platform,
            entry.contract.format,
            entry.contract.outlineResult,
            entry.contract.draftResult,
          ]),
        ),
      ).size,
    ).toBe(9);
  });
});

describe("WorkspaceContentProjects.generateOutlineSet (#132)", () => {
  it("generates exactly the selected targets and no others, each from the same approved Brief", async () => {
    const selected: ContentProjectTarget[] = [
      "linkedin-standard-post",
      "email-newsletter",
      "youtube-short",
    ];
    const harness = fakeOutlineSetProviders();
    const { projects, project, brief } = setupApprovedProject(selected, {
      outlineGenerator: harness.outlineGenerator,
    });

    const outcome: OutlineSetOutcome = await projects.generateOutlineSet(project.id);
    expect(outcome.outlineCharterId).toBe(brief.id);
    expect(outcome.outlineCharterVersion).toBe(brief.version);
    expect(outcome.failures).toEqual([]);
    expect(outcome.generated.map((outline) => outline.target)).toEqual(selected);
    for (const outline of outcome.generated) {
      expect(outline).toMatchObject({
        projectId: project.id,
        projectRevision: 1,
        outlineCharterId: brief.id,
        outlineCharterVersion: brief.version,
        version: 1,
        instruction: null,
      });
    }
    // Exactly the selected targets were asked, and every sibling was prompted
    // with the same approved Brief and nothing else.
    expect(harness.calls.map((call) => call.target).sort()).toEqual([...selected].sort());
    for (const call of harness.calls) {
      expect(Object.keys(call.request).sort()).toEqual(
        ["brief", "evidence", "instruction", "target"].sort(),
      );
      expect(call.request.brief.id).toBe(brief.id);
      expect(call.request.instruction).toBeNull();
    }
    const stored = storedRevision(projects, project.id);
    expect(stored.platformOutlines.map((outline) => outline.target).sort()).toEqual(
      [...selected].sort(),
    );
    expect(stored.drafts).toHaveLength(0);
  });

  it("starts the selected targets concurrently within the configured bound and refuses an invalid bound", async () => {
    const harness = fakeOutlineSetProviders({ hold: true });
    const { projects, project } = setupApprovedProject(CONTENT_PROJECT_TARGETS, {
      outlineGenerator: harness.outlineGenerator,
    });

    const pending = projects.generateOutlineSet(project.id, { concurrency: 2 });
    await harness.held(2);
    // Two calls are in flight and the bound stops every other target: an
    // unbounded implementation would already have arrived with all nine.
    expect(harness.calls).toHaveLength(2);
    harness.releaseAll();
    const bounded = await pending;
    expect(bounded.failures).toEqual([]);
    expect(bounded.generated).toHaveLength(9);
    expect(harness.calls).toHaveLength(9);

    const callsAfterBounded = harness.calls.length;
    for (const badBound of [0, -1, 1.5]) {
      await expect(
        projects.generateOutlineSet(project.id, { concurrency: badBound }),
      ).rejects.toThrowError(
        expect.objectContaining<Partial<ContentProjectError>>({
          code: "invalid-project-input",
        }),
      );
    }
    expect(harness.calls).toHaveLength(callsAfterBounded);

    // A second set proves the default configured bound applies when the
    // caller does not name one.
    const defaultHarness = fakeOutlineSetProviders({ hold: true });
    const defaultSetup = setupApprovedProject(CONTENT_PROJECT_TARGETS, {
      outlineGenerator: defaultHarness.outlineGenerator,
    });
    const defaultPending = defaultSetup.projects.generateOutlineSet(defaultSetup.project.id);
    await defaultHarness.held(DEFAULT_OUTLINE_SET_CONCURRENCY);
    expect(defaultHarness.calls).toHaveLength(DEFAULT_OUTLINE_SET_CONCURRENCY);
    defaultHarness.releaseAll();
    await defaultPending;
  });

  it("refuses to generate a set until an Outline Charter is approved", async () => {
    const harness = fakeOutlineSetProviders();
    const { projects } = setupWorkspace({
      outlineGenerator: harness.outlineGenerator,
      draftGenerator: stubDraftGenerator(),
    });
    const project = projects.create({
      subject: { kind: "topic", topic: "No approved Brief yet" },
      objective: "educate",
      audience: "Operators",
      constraints: [],
      targets: ["linkedin-standard-post"],
      researchMode: "no-external-research",
      seedMaterial: [],
    });
    projects.attachEvidence(project.id, { sourceItems: [], diagnostics: [] });
    projects.freezeEvidence(project.id, {
      includedSourceItemIds: [],
      noExternalResearchAcknowledged: true,
    });
    projects.proposeOutlineCharter(project.id, {
      thesis: "Unapproved Briefs cannot start a set.",
      angle: "Prove the approval gate.",
      claims: [],
      evidenceMap: [],
      ctaIntent: null,
    });

    await expect(projects.generateOutlineSet(project.id)).rejects.toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({
        code: "outline-generation-blocked",
      }),
    );
    expect(harness.calls).toHaveLength(0);
    expect(storedRevision(projects, project.id).platformOutlines).toHaveLength(0);
  });

  it("keeps successful siblings when one target fails, and a retry regenerates only the missing target", async () => {
    const failing = "email-newsletter";
    const selected: ContentProjectTarget[] = ["linkedin-standard-post", failing, "youtube-short"];
    const harness = fakeOutlineSetProviders({ failFirstCall: failing });
    const { projects, project, brief } = setupApprovedProject(selected, {
      outlineGenerator: harness.outlineGenerator,
    });

    const first: OutlineSetOutcome = await projects.generateOutlineSet(project.id);
    expect(first.generated.map((outline) => outline.target)).toEqual(
      selected.filter((target) => target !== failing),
    );
    expect(first.failures).toEqual([
      { target: failing, code: "provider-failed", message: expect.stringContaining(failing) },
    ]);
    expect(storedRevision(projects, project.id).platformOutlines).toHaveLength(2);
    const survivors = new Map(first.generated.map((outline) => [outline.target, outline.id]));

    const retry: OutlineSetOutcome = await projects.generateOutlineSet(project.id);
    expect(retry.outlineCharterId).toBe(brief.id);
    expect(retry.failures).toEqual([]);
    expect(retry.generated.map((outline) => outline.target)).toEqual([failing]);
    // The healed target joins the same Outline Set: same approved Brief, first version.
    expect(retry.generated[0]).toMatchObject({
      outlineCharterId: brief.id,
      version: 1,
      projectRevision: 1,
    });
    const complete = storedRevision(projects, project.id);
    expect(complete.platformOutlines).toHaveLength(3);
    expect(complete.platformOutlines.map((outline) => outline.version)).toEqual([1, 1, 1]);
    // Successful siblings were not re-generated: ids are untouched.
    for (const outline of complete.platformOutlines) {
      if (outline.target === failing) continue;
      expect(outline.id).toBe(survivors.get(outline.target));
    }

    // A further retry is a no-op: the set is complete, so no provider is asked.
    const callsBeforeNoop = harness.calls.length;
    const noop: OutlineSetOutcome = await projects.generateOutlineSet(project.id);
    expect(noop.generated).toEqual([]);
    expect(noop.failures).toEqual([]);
    expect(harness.calls).toHaveLength(callsBeforeNoop);
    expect(storedRevision(projects, project.id).platformOutlines).toHaveLength(3);
  });

  it("records a provider-contract failure for a target whose result cites unapproved evidence while its siblings persist", async () => {
    const bad = "youtube-short";
    const selected: ContentProjectTarget[] = ["linkedin-standard-post", bad];
    const harness = fakeOutlineSetProviders({ badCitation: bad });
    const { projects, project } = setupApprovedProject(selected, {
      outlineGenerator: harness.outlineGenerator,
    });

    const outcome = await projects.generateOutlineSet(project.id);
    expect(outcome.generated.map((outline) => outline.target)).toEqual(["linkedin-standard-post"]);
    expect(outcome.failures).toEqual([
      expect.objectContaining<Partial<{ target: ContentProjectTarget; code: string }>>({
        target: bad,
        code: "invalid-provider-result",
      }),
    ]);
    expect(storedRevision(projects, project.id).platformOutlines.map((o) => o.target)).toEqual([
      "linkedin-standard-post",
    ]);

    // Retry heals the contract failure only: the valid sibling is never re-generated.
    const retry = await projects.generateOutlineSet(project.id);
    expect(retry.generated.map((outline) => outline.target)).toEqual([bad]);
    expect(retry.failures).toEqual([]);
    expect(storedRevision(projects, project.id).platformOutlines).toHaveLength(2);
  });

  it("preserves parent lineage and immutable prior versions across Outline and Draft regeneration", async () => {
    const selected: ContentProjectTarget[] = ["linkedin-standard-post", "email-newsletter"];
    const harness = fakeOutlineSetProviders();
    const postDraft = fakeDraftProvider("linkedin-standard-post");
    const newsletterDraft = fakeDraftProvider("email-newsletter");
    const { projects, project, brief } = setupApprovedProject(selected, {
      outlineGenerator: harness.outlineGenerator,
      draftGenerator: draftGeneratorFor([postDraft, newsletterDraft]),
    });

    const set = await projects.generateOutlineSet(project.id);
    const firstVersion = structuredClone(set.generated);

    const regenerated = await projects.generateOutline(project.id, "linkedin-standard-post", {
      instruction: "Lead with the approval gate, then the reproducibility payoff.",
    });
    expect(regenerated.version).toBe(2);
    expect(regenerated.instruction).toBe(
      "Lead with the approval gate, then the reproducibility payoff.",
    );
    expect(regenerated.outlineCharterId).toBe(brief.id);
    expect(firstVersion).toEqual(set.generated);

    // A set retry after regeneration creates nothing: every selected target
    // already holds Outline work citing the approved Brief.
    const afterRegeneration = await projects.generateOutlineSet(project.id);
    expect(afterRegeneration.generated).toEqual([]);
    expect(afterRegeneration.failures).toEqual([]);

    projects.approveOutline(project.id, "linkedin-standard-post");
    const draftOne = await projects.generateDraft(project.id, "linkedin-standard-post");
    const draftOneSnapshot = structuredClone(draftOne);
    const draftTwo = await projects.generateDraft(project.id, "linkedin-standard-post", {
      instruction: "Tighten the hook and keep every claim grounded.",
    });
    expect(draftTwo.version).toBe(2);
    expect(draftTwo.platformOutlineId).toBe(draftOne.platformOutlineId);
    expect(draftTwo.outlineVersion).toBe(draftOne.outlineVersion);
    expect(draftOne).toEqual(draftOneSnapshot);

    const stored = storedRevision(projects, project.id);
    expect(stored.platformOutlines.map((outline) => [outline.target, outline.version])).toEqual([
      ["linkedin-standard-post", 1],
      ["email-newsletter", 1],
      ["linkedin-standard-post", 2],
    ]);
    expect(stored.drafts.map((draft) => draft.version)).toEqual([1, 2]);
  });

  it("never lets a Draft consume a sibling output", async () => {
    const selected: ContentProjectTarget[] = ["linkedin-standard-post", "email-newsletter"];
    const harness = fakeOutlineSetProviders();
    const postDraft = fakeDraftProvider("linkedin-standard-post");
    const newsletterDraft = fakeDraftProvider("email-newsletter");
    const { projects, project } = setupApprovedProject(selected, {
      outlineGenerator: harness.outlineGenerator,
      draftGenerator: draftGeneratorFor([postDraft, newsletterDraft]),
    });

    await projects.generateOutlineSet(project.id);
    projects.approveOutline(project.id, "linkedin-standard-post");
    projects.approveOutline(project.id, "email-newsletter");
    const post = await projects.generateDraft(project.id, "linkedin-standard-post");
    const newsletter = await projects.generateDraft(project.id, "email-newsletter");

    // Each Draft was prompted with its own target's Outline and nothing from
    // its sibling: no sibling outline, no sibling reference, no sibling id.
    expect(Object.keys(postDraft.calls[0]).sort()).toEqual(
      ["brief", "outline", "evidence", "instruction", "target"].sort(),
    );
    expect(postDraft.calls[0].outline.target).toBe("linkedin-standard-post");
    expect(postDraft.calls[0].outline.id).toBe(post.platformOutlineId);
    expect(newsletterDraft.calls[0].outline.target).toBe("email-newsletter");
    expect(newsletterDraft.calls[0].outline.id).toBe(newsletter.platformOutlineId);
    // No draft request may carry the OTHER target's outline: each call may
    // only ever contain its own outline id.
    for (const call of postDraft.calls) {
      expect(JSON.stringify(call)).not.toContain(newsletter.platformOutlineId);
    }
    for (const call of newsletterDraft.calls) {
      expect(JSON.stringify(call)).not.toContain(post.platformOutlineId);
    }

    const stored = storedRevision(projects, project.id);
    for (const draft of stored.drafts) {
      const parent = stored.platformOutlines.find(
        (outline) => outline.id === draft.platformOutlineId,
      );
      expect(parent?.target).toBe(draft.target);
    }
  });

  it("keeps Draft generation one target per explicit action with no bulk Draft operation", async () => {
    const publicMethods = Object.getOwnPropertyNames(WorkspaceContentProjects.prototype).filter(
      (name) => name !== "constructor" && !name.startsWith("planned"),
    );
    expect(publicMethods.filter((name) => /drafts?/i.test(name))).toEqual(["generateDraft"]);

    const selected: ContentProjectTarget[] = ["linkedin-standard-post", "email-newsletter"];
    const harness = fakeOutlineSetProviders();
    const { projects, project } = setupApprovedProject(selected, {
      outlineGenerator: harness.outlineGenerator,
    });
    await projects.generateOutlineSet(project.id);
    // The Outline Set creates Outline work only; Drafts stay per-action.
    expect(storedRevision(projects, project.id).drafts).toHaveLength(0);
  });
});

describe("Copy and Markdown exports (#132)", () => {
  it("renders Outline and Draft Markdown deterministically and retains the structured records", async () => {
    const selected: ContentProjectTarget[] = ["linkedin-standard-post", "email-newsletter"];
    const harness = fakeOutlineSetProviders();
    const postDraft = fakeDraftProvider("linkedin-standard-post");
    const { projects, project } = setupApprovedProject(selected, {
      outlineGenerator: harness.outlineGenerator,
      draftGenerator: draftGeneratorFor([postDraft]),
    });

    const set = await projects.generateOutlineSet(project.id);
    const outline = set.generated.find(
      (candidate) => candidate.target === "linkedin-standard-post",
    )!;
    projects.approveOutline(project.id, "linkedin-standard-post");
    const draft: ContentEngineDraft = await projects.generateDraft(
      project.id,
      "linkedin-standard-post",
    );

    const outlineMarkdown = platformOutlineMarkdown(outline);
    expect(outlineMarkdown).toBe(platformOutlineMarkdown(outline));
    expect(outlineMarkdown).toContain(`# ${outline.title}`);
    expect(outlineMarkdown).toContain(`- Thesis: ${outline.thesis}`);
    expect(outlineMarkdown).toContain(outline.ctaIntent!);
    for (const beat of outline.beats) {
      expect(outlineMarkdown).toContain(`${beat.position}. ${beat.direction}`);
      expect(outlineMarkdown).toContain(beat.evidence.claim);
    }
    expect(outlineMarkdown).toContain(SOURCE_ITEM.id);
    const draftMarkdown = contentEngineDraftMarkdown(draft);
    expect(draftMarkdown).toBe(contentEngineDraftMarkdown(draft));
    expect(draftMarkdown).toContain(draft.copy);
    expect(draftMarkdown).toContain("Frozen inputs preserve lineage.");
    expect(draftMarkdown).toContain("Supported");
    expect(draftMarkdown).toContain("Unsupported");
    expect(draftMarkdown).toContain(SOURCE_ITEM.id);

    // Structured JSON stays the product interface: the stored record is the
    // exact object the renderers read, not a Markdown replacement.
    const stored = storedRevision(projects, project.id);
    expect(stored.platformOutlines.find((candidate) => candidate.id === outline.id)).toEqual(
      outline,
    );
    expect(stored.drafts[0].copy).toBe(draft.copy);
    expect(stored.drafts[0].claims).toEqual(draft.claims);
    expect(stored.drafts[0].unsupportedClaimPolicy).toBe(CONTENT_ENGINE_UNSUPPORTED_CLAIM_POLICY);
    expect(draft.copy.startsWith("linkedin-standard-post copy from outline v1")).toBe(true);
  });
});
