import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import {
  CONTENT_ENGINE_UNSUPPORTED_CLAIM_POLICY,
  type ContentEngineDraft,
  type ContentProjectPromptEvidence,
  type OutlineCharter,
  type PlatformOutline,
} from "@chief-of-staff-demo/shared";
import {
  DIAGNOSTIC,
  NOW,
  SOURCE_ITEM,
  SOURCE_ITEM_2,
  stubDraftGenerator,
  stubOutlineGenerator,
} from "./content-project-fixtures";
import { WorkspaceBrandProfileStore } from "../../../apps/server/src/brand-profile/store";
import {
  createModelDraftGenerator,
  createModelOutlineGenerator,
  MAX_GENERATION_INSTRUCTION_LENGTH,
  type ContentEngineDraftGenerator,
  type DraftGenerationRequest,
  type OutlineGenerationRequest,
  type PlatformOutlineGenerator,
  type PlatformOutlineResult,
} from "../../../apps/server/src/content-projects/generation";
import type { CompleteJson } from "../../../apps/server/src/llm/providers";
import {
  ContentProjectError,
  WorkspaceContentProjects,
} from "../../../apps/server/src/content-projects/projects";
import { OwnerOnboarding } from "../../../apps/server/src/onboarding/owner";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";

interface SetupOptions {
  outlineGenerator?: PlatformOutlineGenerator;
  draftGenerator?: ContentEngineDraftGenerator;
}

function setup(options: SetupOptions = {}) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "content-outlines-"));
  const personStore = new PersonProfileStore(workspaceDir);
  const people = new WorkspacePersonProfiles({
    store: personStore,
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
    outlineGenerator: options.outlineGenerator ?? stubOutlineGenerator(),
    draftGenerator: options.draftGenerator ?? stubDraftGenerator(),
    now: () => NOW,
  });
  return { workspaceDir, people, owner, brandProfiles, projects };
}

/** A ready Project revision: gates present, evidence frozen, Brief proposed and approved. */
function setupApprovedProject(options: SetupOptions = {}) {
  const ctx = setup(options);
  const { projects, owner, brandProfiles } = ctx;
  projects.approveContentVoice(owner.id, "Clear, practical, and evidence-led.");
  brandProfiles.accept({
    markdown: "# Brand Profile\n\n## Voice\nUseful and specific.",
    sourceScan: {
      websiteUrl: "https://brand.example/",
      includedUrls: ["https://brand.example/"],
      excludedUrls: [],
    },
  });
  const project = projects.create({
    subject: { kind: "topic", topic: "Immutable approved inputs beat in-app editors" },
    objective: "establish-authority",
    audience: "Engineering leaders",
    constraints: ["Separate facts from author claims"],
    targets: ["linkedin-standard-post"],
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
  return { ...ctx, project, brief };
}

interface OutlineProviderHarness {
  provider: PlatformOutlineGenerator;
  calls: OutlineGenerationRequest[];
}

function fakeOutlineProvider(
  respond: () => PlatformOutlineResult = () => ({
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
  }),
): OutlineProviderHarness {
  const calls: OutlineGenerationRequest[] = [];
  return {
    calls,
    provider: {
      async generate(request) {
        calls.push(structuredClone(request));
        return respond();
      },
    },
  };
}

interface DraftProviderHarness {
  provider: ContentEngineDraftGenerator;
  calls: DraftGenerationRequest[];
}

function fakeDraftProvider(
  respond: (request: DraftGenerationRequest) => {
    copy: string;
    productionNotes: string[];
    claims: { text: string; sourceItemIds: string[] }[];
  } = (request) => ({
    copy: `Draft from outline v${request.outline.version}: ${request.outline.thesis}`,
    productionNotes: ["Paste-ready copy."],
    claims: [
      {
        text: "Frozen inputs preserve lineage.",
        sourceItemIds: [SOURCE_ITEM.id],
      },
      { text: "An author-supplied flourish.", sourceItemIds: [] },
      { text: "A claim citing an unknown item.", sourceItemIds: ["source_404"] },
    ],
  }),
): DraftProviderHarness {
  const calls: DraftGenerationRequest[] = [];
  return {
    calls,
    provider: {
      async generate(request) {
        calls.push(structuredClone(request));
        return respond(request);
      },
    },
  };
}

describe("WorkspaceContentProjects Platform Outline generation (#131)", () => {
  it("refuses to generate until an Outline Charter is explicitly approved, then records every approved input", async () => {
    const outline = fakeOutlineProvider();
    const { projects, project, brief } = setupApprovedProject({
      outlineGenerator: outline.provider,
    });

    const gated = setup({ outlineGenerator: outline.provider });
    gated.projects.approveContentVoice(gated.owner.id, "Voice.");
    gated.brandProfiles.accept({
      markdown: "# Brand Profile\n\n## Voice\nVoice.",
      sourceScan: {
        websiteUrl: "https://brand.example/",
        includedUrls: ["https://brand.example/"],
        excludedUrls: [],
      },
    });
    const gatedProject = gated.projects.create({
      subject: { kind: "topic", topic: "Gate before generation" },
      objective: "educate",
      audience: "Operators",
      constraints: [],
      targets: ["linkedin-standard-post"],
      researchMode: "no-external-research",
      seedMaterial: [],
    });
    gated.projects.attachEvidence(gatedProject.id, {
      sourceItems: [],
      diagnostics: [],
    });
    gated.projects.freezeEvidence(gatedProject.id, {
      includedSourceItemIds: [],
      noExternalResearchAcknowledged: true,
    });
    gated.projects.proposeOutlineCharter(gatedProject.id, {
      thesis: "Unapproved Briefs cannot start generation.",
      angle: "Prove the approval gate.",
      claims: [],
      evidenceMap: [],
      ctaIntent: null,
    });
    await expect(
      gated.projects.generateOutline(gatedProject.id, "linkedin-standard-post"),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({
        code: "outline-generation-blocked",
      }),
    );

    const generated = await projects.generateOutline(project.id, "linkedin-standard-post");
    expect(generated).toMatchObject({
      projectId: project.id,
      projectRevision: 1,
      target: "linkedin-standard-post",
      outlineCharterId: brief.id,
      outlineCharterVersion: brief.version,
      version: 1,
      instruction: null,
      title: "A grounded case for immutable inputs",
      hookDirection: "Open with the reproducibility failure the owner knows.",
      thesis: brief.thesis,
      ctaIntent: brief.ctaIntent,
      constraints: ["Separate facts from author claims"],
      targetLength: "900 to 1,200 characters",
      generatedAt: NOW.toISOString(),
    });
    expect(generated.beats.map((beat) => beat.position)).toEqual([1, 2]);
    expect(generated.beats[0]?.evidence).toEqual({
      claim: "Frozen inputs preserve lineage.",
      sourceItemIds: [SOURCE_ITEM.id],
    });
    expect(generated.warnings.length).toBeGreaterThan(0);
    expect(generated.productionNotes).toEqual(["Draft the hook last."]);

    // Generation is prompted with the frozen public-evidence projection only.
    expect(outline.calls).toHaveLength(1);
    expect(Object.keys(outline.calls[0].evidence).sort()).toEqual(
      [
        "projectId",
        "projectRevision",
        "sourceItems",
        "brandVoice",
        "contentVoice",
        "profileProjections",
        "userMaterial",
      ].sort(),
    );
    expect(outline.calls[0].brief).toMatchObject({ id: brief.id, thesis: brief.thesis });

    const stored = projects.get(project.id)!.revisions[0];
    expect(stored.platformOutlines).toHaveLength(1);
    expect(stored.platformOutlines[0]).toEqual(generated);
  });

  it("rejects an outline that cites evidence outside the approved Brief's evidence map or carries no beats", async () => {
    const badCitation = fakeOutlineProvider(() => ({
      title: "Bad citation",
      hookDirection: "Hook",
      targetLength: "900 characters",
      beats: [
        {
          direction: "Beat",
          evidence: { claim: "Not frozen.", sourceItemIds: ["source_404"] },
          examples: [],
        },
      ],
      warnings: [],
      productionNotes: [],
    }));
    const { projects, project } = setupApprovedProject({
      outlineGenerator: badCitation.provider,
    });
    await expect(
      projects.generateOutline(project.id, "linkedin-standard-post"),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({
        code: "invalid-provider-result",
      }),
    );
    expect(projects.get(project.id)!.revisions[0].platformOutlines).toHaveLength(0);

    /* source_2 is frozen but the approved Brief's evidence map does not
       include it, so an Outline beat citing it must be refused too. */
    const unapprovedCitation = fakeOutlineProvider(() => ({
      title: "Unapproved citation",
      hookDirection: "Hook",
      targetLength: "900 characters",
      beats: [
        {
          direction: "Beat",
          evidence: { claim: "Frozen but not approved.", sourceItemIds: [SOURCE_ITEM_2.id] },
          examples: [],
        },
      ],
      warnings: [],
      productionNotes: [],
    }));
    const third = setupApprovedProject({ outlineGenerator: unapprovedCitation.provider });
    await expect(
      third.projects.generateOutline(third.project.id, "linkedin-standard-post"),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({
        code: "invalid-provider-result",
      }),
    );
    expect(third.projects.get(third.project.id)!.revisions[0].platformOutlines).toHaveLength(0);

    const noBeats = fakeOutlineProvider(() => ({
      title: "No beats",
      hookDirection: "Hook",
      targetLength: "900 characters",
      beats: [],
      warnings: [],
      productionNotes: [],
    }));
    const second = setupApprovedProject({ outlineGenerator: noBeats.provider });
    await expect(
      second.projects.generateOutline(second.project.id, "linkedin-standard-post"),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({
        code: "invalid-provider-result",
      }),
    );
  });

  it("refuses a target the revision did not select", async () => {
    const { projects, project } = setupApprovedProject();
    await expect(projects.generateOutline(project.id, "email-newsletter")).rejects.toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({
        code: "outline-not-supported",
      }),
    );
  });

  it("appends a new immutable Outline version for a bounded regeneration instruction and never edits the previous result", async () => {
    const outline = fakeOutlineProvider();
    const { projects, project } = setupApprovedProject({ outlineGenerator: outline.provider });
    const first = await projects.generateOutline(project.id, "linkedin-standard-post");
    const firstSnapshot = structuredClone(first);

    for (const badInstruction of ["   ", "x".repeat(MAX_GENERATION_INSTRUCTION_LENGTH + 1)]) {
      await expect(
        projects.generateOutline(project.id, "linkedin-standard-post", {
          instruction: badInstruction,
        }),
      ).rejects.toThrowError(
        expect.objectContaining<Partial<ContentProjectError>>({
          code: "invalid-project-input",
        }),
      );
    }

    const second = await projects.generateOutline(project.id, "linkedin-standard-post", {
      instruction: "Lead with the approval gate, then the reproducibility payoff.",
    });
    expect(second.version).toBe(2);
    expect(second.instruction).toBe(
      "Lead with the approval gate, then the reproducibility payoff.",
    );
    expect(second.title).toBe("A grounded case for immutable inputs");
    expect(first).toEqual(firstSnapshot);
    expect(projects.get(project.id)!.revisions[0].platformOutlines.map((o) => o.version)).toEqual([
      1, 2,
    ]);
  });

  it("does not land an outline on a revision created while generation was in flight", async () => {
    let projectsRef: WorkspaceContentProjects | null = null;
    let projectIdRef: string | null = null;
    const racing: OutlineProviderHarness = {
      calls: [],
      provider: {
        async generate() {
          projectsRef!.reviseIntent(projectIdRef!, { audience: "Changed mid flight" });
          return {
            title: "Landed late",
            hookDirection: "Hook",
            targetLength: "900 characters",
            beats: [
              {
                direction: "Beat",
                evidence: {
                  claim: "Frozen inputs preserve lineage.",
                  sourceItemIds: [SOURCE_ITEM.id],
                },
                examples: [],
              },
            ],
            warnings: [],
            productionNotes: [],
          };
        },
      },
    };
    const { projects, project } = setupApprovedProject({ outlineGenerator: racing.provider });
    projectsRef = projects;
    projectIdRef = project.id;
    await expect(
      projects.generateOutline(project.id, "linkedin-standard-post"),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({
        code: "outline-generation-blocked",
      }),
    );
    expect(projects.get(project.id)!.revisions.at(-1)!.platformOutlines).toHaveLength(0);
  });
});

describe("WorkspaceContentProjects Content Engine Draft generation (#131)", () => {
  it("generates a Draft only from an approved Platform Outline version and pins thesis, evidence, and the unsupported-claim policy", async () => {
    const outline = fakeOutlineProvider();
    const draft = fakeDraftProvider();
    const { projects, project, brief } = setupApprovedProject({
      outlineGenerator: outline.provider,
      draftGenerator: draft.provider,
    });

    await expect(projects.generateDraft(project.id, "linkedin-standard-post")).rejects.toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({
        code: "draft-generation-blocked",
      }),
    );

    const generatedOutline = await projects.generateOutline(project.id, "linkedin-standard-post");
    await expect(projects.generateDraft(project.id, "linkedin-standard-post")).rejects.toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({
        code: "draft-generation-blocked",
      }),
    );

    projects.approveOutline(project.id, "linkedin-standard-post");
    const first = await projects.generateDraft(project.id, "linkedin-standard-post");
    expect(first).toMatchObject({
      projectId: project.id,
      projectRevision: 1,
      target: "linkedin-standard-post",
      platformOutlineId: generatedOutline.id,
      outlineVersion: generatedOutline.version,
      version: 1,
      instruction: null,
      copy: `Draft from outline v1: ${brief.thesis}`,
      thesis: brief.thesis,
      evidence: brief.evidenceMap,
      unsupportedClaimPolicy: CONTENT_ENGINE_UNSUPPORTED_CLAIM_POLICY,
      productionNotes: ["Paste-ready copy."],
    });
    expect(first.claims).toEqual([
      { text: "Frozen inputs preserve lineage.", sourceItemIds: [SOURCE_ITEM.id], supported: true },
      { text: "An author-supplied flourish.", sourceItemIds: [], supported: false },
      { text: "A claim citing an unknown item.", sourceItemIds: ["source_404"], supported: false },
    ]);

    // One Draft for one target per action: the draft cites exactly one outline version.
    expect(draft.calls[0].outline.id).toBe(generatedOutline.id);
    const stored = projects.get(project.id)!.revisions[0];
    expect(stored.drafts).toHaveLength(1);
    expect(stored.drafts[0]).toEqual(first);
  });

  it("appends immutable Draft versions and cannot drift the approved thesis, evidence, or unsupported-claim policy", async () => {
    const outline = fakeOutlineProvider();
    const draft = fakeDraftProvider();
    const { projects, project, brief } = setupApprovedProject({
      outlineGenerator: outline.provider,
      draftGenerator: draft.provider,
    });
    await projects.generateOutline(project.id, "linkedin-standard-post");
    projects.approveOutline(project.id, "linkedin-standard-post");
    const first = await projects.generateDraft(project.id, "linkedin-standard-post");
    const firstSnapshot = structuredClone(first);

    const second = await projects.generateDraft(project.id, "linkedin-standard-post", {
      instruction:
        "Rewrite the thesis, cite the approved evidence as altered, and mark every claim supported.",
    });
    expect(second.version).toBe(2);
    expect(second.instruction).toBe(
      "Rewrite the thesis, cite the approved evidence as altered, and mark every claim supported.",
    );
    expect(second.thesis).toBe(brief.thesis);
    expect(second.evidence).toEqual(brief.evidenceMap);
    expect(second.unsupportedClaimPolicy).toBe(CONTENT_ENGINE_UNSUPPORTED_CLAIM_POLICY);
    expect(second.claims.every((claim) => typeof claim.supported === "boolean")).toBe(true);
    expect(second.claims.filter((claim) => !claim.supported).length).toBeGreaterThan(0);
    expect(first).toEqual(firstSnapshot);
    expect(projects.get(project.id)!.revisions[0].drafts.map((d) => d.version)).toEqual([1, 2]);
  });

  it("rejects a draft whose provider returned no copy", async () => {
    const outline = fakeOutlineProvider();
    const emptyDraft = fakeDraftProvider(() => ({
      copy: "   ",
      productionNotes: [],
      claims: [],
    }));
    const { projects, project } = setupApprovedProject({
      outlineGenerator: outline.provider,
      draftGenerator: emptyDraft.provider,
    });
    await projects.generateOutline(project.id, "linkedin-standard-post");
    projects.approveOutline(project.id, "linkedin-standard-post");
    await expect(projects.generateDraft(project.id, "linkedin-standard-post")).rejects.toThrowError(
      expect.objectContaining<Partial<ContentProjectError>>({
        code: "invalid-provider-result",
      }),
    );
    expect(projects.get(project.id)!.revisions[0].drafts).toHaveLength(0);
  });
});

describe("Content Engine generation performs no outward write (#131)", () => {
  it("creates no Notion page, publication record, schedule, or analytics record", async () => {
    const outline = fakeOutlineProvider();
    const draft = fakeDraftProvider();
    const { workspaceDir, projects, project } = setupApprovedProject({
      outlineGenerator: outline.provider,
      draftGenerator: draft.provider,
    });
    await projects.generateOutline(project.id, "linkedin-standard-post");
    projects.approveOutline(project.id, "linkedin-standard-post");
    await projects.generateDraft(project.id, "linkedin-standard-post");

    const engineDir = join(workspaceDir, "content-engine");
    expect(readdirSync(engineDir)).toEqual(["projects.json"]);

    const state = JSON.parse(readFileSync(join(engineDir, "projects.json"), "utf8")) as {
      projects: Array<{
        revisions: Array<{
          platformOutlines: PlatformOutline[];
          drafts: ContentEngineDraft[];
        }>;
      }>;
    };
    const revision = state.projects[0].revisions[0];
    const outwardPattern = /notion|publica|schedul|analytic|publish/i;
    for (const record of [...revision.platformOutlines, ...revision.drafts]) {
      expect(Object.keys(record).some((key) => outwardPattern.test(key))).toBe(false);
    }
    expect(existsSync(join(engineDir, "outlines"))).toBe(false);
    expect(existsSync(join(engineDir, "drafts"))).toBe(false);
    expect(revision.platformOutlines).toHaveLength(1);
    expect(revision.drafts).toHaveLength(1);
  });
});

describe("Model-backed generation (#131)", () => {
  it("answers in the Platform Outline Result Shape and refuses a shape failure", async () => {
    const calls: unknown[] = [];
    const completeJson: CompleteJson = async (request) => {
      calls.push(request);
      return {
        title: "The approved path",
        hookDirection: "Open with the gate.",
        targetLength: "900 characters",
        beats: [
          {
            direction: "Beat one",
            evidence: { claim: "Frozen inputs preserve lineage.", sourceItemIds: [SOURCE_ITEM.id] },
            examples: [],
          },
        ],
        warnings: [],
        productionNotes: [],
      };
    };
    const generator = createModelOutlineGenerator(() => completeJson);
    const brief = fromPartial<OutlineCharter>({ thesis: "T", evidenceMap: [], version: 1 });
    const result = await generator.generate({
      target: "linkedin-standard-post",
      brief,
      evidence: fromPartial<ContentProjectPromptEvidence>({ projectId: "project_1" }),
      instruction: null,
    });
    expect(result.title).toBe("The approved path");
    expect(calls).toHaveLength(1);

    const broken = createModelOutlineGenerator(() => async () => ({ title: "" }));
    await expect(
      broken.generate({
        target: "linkedin-standard-post",
        brief,
        evidence: fromPartial<ContentProjectPromptEvidence>({ projectId: "project_1" }),
        instruction: null,
      }),
    ).rejects.toThrow();
  });

  it("answers in the Draft Result Shape and passes the outline for grounding", async () => {
    const seenRequests: unknown[] = [];
    const completeJson: CompleteJson = async (request) => {
      seenRequests.push(request);
      return {
        copy: "Finished post copy.",
        productionNotes: [],
        claims: [{ text: "Frozen inputs preserve lineage.", sourceItemIds: [SOURCE_ITEM.id] }],
      };
    };
    const generator = createModelDraftGenerator(() => completeJson);
    const result = await generator.generate({
      target: "linkedin-standard-post",
      brief: fromPartial<OutlineCharter>({ thesis: "T", evidenceMap: [] }),
      outline: fromPartial<PlatformOutline>({ id: "outline_1", thesis: "T", version: 2 }),
      evidence: fromPartial<ContentProjectPromptEvidence>({ projectId: "project_1" }),
      instruction: "Tighten the hook.",
    });
    expect(result.copy).toBe("Finished post copy.");
    const request = seenRequests[0] as { user: string; system: string };
    expect(request.system).toContain("linkedin-standard-post");
    expect(request.user).toContain("outline_1");
    expect(request.user).toContain("Tighten the hook.");
  });
});
