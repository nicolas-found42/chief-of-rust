import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContentScoutHost } from "../../../apps/server/src/modules/content-scout/host";
import { openRuns, type Runs } from "../../../apps/server/src/runs";
import type { OpportunityRanker } from "../../../apps/server/src/modules/content-scout/ports";
import type { SourceAdapter } from "../../../apps/server/src/source-adapters/source-adapter";
import {
  contentProjectOpportunityStarter,
  type OpportunityProjectInput,
  type OpportunityProjects,
} from "../../../apps/server/src/content-projects/opportunity-projects";
import { WorkspaceContentProjects } from "../../../apps/server/src/content-projects/projects";
import { OwnerOnboarding } from "../../../apps/server/src/onboarding/owner";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspaceBrandProfileStore } from "../../../apps/server/src/brand-profile/store";
import type { RankedOpportunity } from "@chief-of-staff-demo/shared";
import { stubDraftGenerator, stubOutlineGenerator } from "./content-project-fixtures";

const NOW = new Date("2026-09-01T12:00:00.000Z");

function rssAdapter(): SourceAdapter {
  return {
    id: "rss",
    state: "available",
    version: "fixture-1",
    supports: (target) => target.adapterId === "rss",
    async collect({ target }) {
      return {
        kind: "completed",
        outcome: "items_found",
        checkpoint: "rss-checkpoint-1",
        items: [
          {
            id: "rss:story-2",
            externalId: "story-2",
            targetId: target.id,
            adapterId: "rss",
            canonicalUrl: "https://example.com/story-2",
            author: "Example Research",
            title: "An operator checklist for the verified change",
            body: "A second public source turns the verified change into operational steps.",
            description: null,
            publishedAt: "2026-09-01T09:00:00.000Z",
            discoveredAt: NOW.toISOString(),
            media: [],
            transcript: null,
            comments: [],
            evidence: [{ route: "fixture:rss", retrievedAt: NOW.toISOString() }],
            completeness: {
              title: "available",
              body: "available",
              description: "unavailable",
              transcript: "unsupported",
              comments: "unsupported",
              media: "unavailable",
            },
          },
          {
            id: "rss:story-1",
            externalId: "story-1",
            targetId: target.id,
            adapterId: "rss",
            canonicalUrl: "https://example.com/story-1",
            author: "Example Research",
            title: "A concrete change worth explaining",
            body: "The public source describes a verified change and its practical impact.",
            description: null,
            publishedAt: "2026-09-01T10:00:00.000Z",
            discoveredAt: NOW.toISOString(),
            media: [],
            transcript: null,
            comments: [],
            evidence: [{ route: "fixture:rss", retrievedAt: NOW.toISOString() }],
            completeness: {
              title: "available",
              body: "available",
              description: "unavailable",
              transcript: "unsupported",
              comments: "unsupported",
              media: "unavailable",
            },
          },
        ],
        diagnostic: {
          classification: "items_found",
          route: "fixture:rss",
          status: 200,
          contentType: "application/rss+xml",
          parserStage: "rss",
          responseHash: "rss-response-1",
          adapterVersion: "fixture-1",
          startedAt: NOW.toISOString(),
          finishedAt: NOW.toISOString(),
          retries: 0,
          affectedCapabilities: [],
          causeChain: [],
        },
      };
    },
  };
}

function opportunityFixture(
  id: string,
  title: string,
): Omit<RankedOpportunity, "sourceItemIds" | "sourceUrls"> {
  return {
    id,
    canonicalKey: `key-${id}`,
    title,
    angle: "practical_implication",
    angleDescription: `Explain the practical impact of ${title.toLowerCase()}.`,
    materialDevelopment: null,
    urgency: "Useful while the change is new.",
    explanation: "It matches the Brand Profile's educational positioning.",
    experimentalEvidence: false,
    confidence: 0.91,
    scores: {
      brandRelevance: 0.95,
      audienceUsefulness: 0.9,
      timeliness: 0.9,
      novelty: 0.8,
      evidenceStrength: 0.9,
      evidenceDiversity: 0.4,
      specificity: 0.9,
      originalPerspective: 0.8,
      packApplicability: 0.9,
      speculationRisk: 0.1,
    },
  };
}

const ranker: OpportunityRanker = {
  async rank({ items }) {
    const byStory = (fragment: string) => {
      const owned = items.filter((item) => item.id.includes(fragment));
      return {
        sourceItemIds: owned.map((item) => item.id),
        sourceUrls: owned.map((item) => item.canonicalUrl),
      };
    };
    return [
      {
        ...opportunityFixture(
          "opportunity-1",
          "Explain what the verified change means in practice",
        ),
        ...byStory("story-1"),
      },
      {
        ...opportunityFixture(
          "opportunity-2",
          "Turn the verified change into an operator checklist",
        ),
        ...byStory("story-2"),
      },
    ];
  },
};

const projectInput: OpportunityProjectInput = {
  objective: "educate",
  audience: "Operations leads",
  constraints: [],
  targets: ["linkedin-standard-post"],
  researchMode: "existing-workspace-evidence",
  seedMaterial: [],
};

function makeWorkspace(input: {
  starter?: OpportunityProjects;
  isOwnerProfileConfirmed?: () => boolean;
}): {
  workspaceDir: string;
  runs: Runs;
  host: ContentScoutHost;
  projects: WorkspaceContentProjects;
  ownerOnboarding: OwnerOnboarding;
} {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-selection-"));
  const runs = openRuns(workspaceDir);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
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
    outlineGenerator: stubOutlineGenerator(),
    draftGenerator: stubDraftGenerator(),
    now: () => NOW,
  });
  const host = new ContentScoutHost({
    runs,
    workspaceDir,
    now: () => NOW,
    adapters: [rssAdapter()],
    ranker,
    opportunityProjects: input.starter ?? contentProjectOpportunityStarter(projects),
    isOwnerProfileConfirmed:
      input.isOwnerProfileConfirmed ?? (() => Boolean(ownerOnboarding.confirmed())),
    log: () => undefined,
  });
  host.acceptBrandProfile({
    markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
    sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
  });
  host.addSourceTarget({
    adapterId: "rss",
    label: "Example Research",
    url: "https://example.com/feed.xml",
  });
  return { workspaceDir, runs, host, projects, ownerOnboarding };
}

async function rankedShortlist(host: ContentScoutHost) {
  const runId = await host.scoutNow();
  await host.idle();
  const shortlist = host.activeShortlist();
  if (!shortlist) throw new Error("fixture produced no shortlist");
  return { runId, shortlist };
}

describe("Selecting a Content Opportunity starts a Content Project (#133)", () => {
  it("creates exactly one governed Project that records the relationship and generates nothing", async () => {
    const { runs, host, projects } = makeWorkspace({});
    const { runId, shortlist } = await rankedShortlist(host);
    const opportunity = shortlist.opportunities[0];

    await host.select(runId, [opportunity.id], projectInput);
    await host.idle();

    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("blocked");
    const project = projects.projectByOpportunity(opportunity.id);
    expect(project).not.toBeNull();
    expect(project!.revisions[0]).toMatchObject({
      subject: { kind: "topic", topic: opportunity.title },
      objective: "educate",
      audience: "Operations leads",
      targets: ["linkedin-standard-post"],
      researchMode: "existing-workspace-evidence",
      sourceOpportunity: {
        opportunityId: opportunity.id,
        runId,
        title: opportunity.title,
        angle: opportunity.angle,
        angleDescription: opportunity.angleDescription,
        sourceUrls: opportunity.sourceUrls,
        brandProfileRevisionId: shortlist.brandProfileRevisionId,
        recordedAt: NOW.toISOString(),
      },
    });
    /* The angle and the evidence URLs are carried into the Project as seed
       material, so the owner reviews them like any other input. */
    const seedMaterial = project!.revisions[0].seedMaterial;
    expect(seedMaterial).toEqual(expect.arrayContaining(opportunity.sourceUrls));
    expect(seedMaterial.some((line) => line.includes(opportunity.angleDescription))).toBe(true);
    expect(detail.result).toMatchObject({
      projects: [{ opportunityId: opportunity.id, projectId: project!.id, created: true }],
    });
    /* Nothing is generated at selection time: no Outline Charter, no Outline, no Draft. */
    expect(project!.revisions[0]).toMatchObject({
      outlineCharters: [],
      outlineCharterApprovals: [],
      platformOutlines: [],
      drafts: [],
    });
    expect(detail.events.filter((event) => event.type === "content_project_started")).toHaveLength(
      1,
    );
  });

  it("keeps every governed gate: the Project still requires evidence review and an approved Outline Charter", async () => {
    const { host, projects } = makeWorkspace({});
    const { runId, shortlist } = await rankedShortlist(host);
    const opportunity = shortlist.opportunities[0];

    await host.select(runId, [opportunity.id], projectInput);
    await host.idle();

    const project = projects.projectByOpportunity(opportunity.id)!;
    const readiness = projects.readiness(project.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.missingGates).toEqual(
      expect.arrayContaining(["content-voice", "evidence-review"]),
    );
    await expect(projects.generateOutline(project.id, "linkedin-standard-post")).rejects.toThrow(
      /needs these gates first|approved immutable Outline Charter/,
    );
  });

  it("recovers a selection after a restart without duplicating the Project", async () => {
    let releaseStart: (() => void) | null = null;
    const firstStartStarted = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let calls = 0;
    const hangingStarter: OpportunityProjects = {
      async start(input) {
        calls += 1;
        if (calls === 1) {
          releaseStart!();
          await new Promise<void>(() => undefined);
        }
        return { projectId: `project_${input.opportunityId}`, created: true };
      },
    };
    const { workspaceDir, runs, host, projects } = makeWorkspace({ starter: hangingStarter });
    const { runId, shortlist } = await rankedShortlist(host);
    const opportunity = shortlist.opportunities[0];

    await host.select(runId, [opportunity.id], projectInput);
    await firstStartStarted;
    expect(runs.detail(runId)!.status).toBe("running");

    /* The process dies while the first Project start is in flight; a new Host
       reconstructs the Run from its durable selection and must not create a
       second Project for the same Opportunity. */
    const restarted = new ContentScoutHost({
      runs: openRuns(workspaceDir),
      workspaceDir,
      now: () => NOW,
      adapters: [rssAdapter()],
      ranker,
      opportunityProjects: contentProjectOpportunityStarter(projects),
      isOwnerProfileConfirmed: () => true,
      log: () => undefined,
    });
    restarted.start();
    await restarted.idle();
    restarted.stop();

    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("blocked");
    const recovered = projects.projectByOpportunity(opportunity.id);
    expect(recovered).not.toBeNull();
    /* Exactly one Project exists for the Opportunity, and exactly one start event. */
    expect(detail.events.filter((event) => event.type === "content_project_started")).toHaveLength(
      1,
    );
    expect(detail.result).toMatchObject({
      projects: [{ opportunityId: opportunity.id, projectId: recovered!.id, created: true }],
    });
  });

  it("stops the second Project when owner confirmation is invalidated between opportunities", async () => {
    let confirmed = true;
    let markFirstDone!: () => void;
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      markFirstDone = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const created: string[] = [];
    const gatedStarter: OpportunityProjects = {
      async start(input) {
        created.push(input.opportunityId);
        if (created.length === 1) {
          markFirstDone();
          await firstReleased;
        }
        return { projectId: `project_${input.opportunityId}`, created: true };
      },
    };
    const { runs, host } = makeWorkspace({
      starter: gatedStarter,
      isOwnerProfileConfirmed: () => confirmed,
    });
    const { runId, shortlist } = await rankedShortlist(host);
    const [first, second] = shortlist.opportunities;

    await host.select(runId, [first.id, second.id], projectInput);
    await firstDone;
    confirmed = false;
    releaseFirst();
    await host.idle();

    const detail = runs.detail(runId)!;
    expect(created).toEqual([first.id]);
    expect(detail.failedStage).toBe("projects");
    expect(detail.events.at(-1)).toMatchObject({
      type: "run_failed",
      detail: { reason: expect.stringMatching(/owner_not_confirmed/) },
    });
  });

  it("blocks a selected Run retry when owner confirmation was invalidated", async () => {
    let confirmed = true;
    let starterCalls = 0;
    const failingStarter: OpportunityProjects = {
      async start() {
        starterCalls += 1;
        throw new Error("fixture project failure");
      },
    };
    const { runs, host } = makeWorkspace({
      starter: failingStarter,
      isOwnerProfileConfirmed: () => confirmed,
    });
    const { runId, shortlist } = await rankedShortlist(host);

    await host.select(runId, [shortlist.opportunities[0].id], projectInput);
    await host.idle();
    expect(runs.detail(runId)!.failedStage).toBe("projects");
    const callsBeforeRetry = starterCalls;

    confirmed = false;
    await host.retryRun(runId);
    await host.idle();

    expect(starterCalls).toBe(callsBeforeRetry);
    expect(runs.detail(runId)!.failedStage).toBe("projects");
    expect(runs.detail(runId)!.events.at(-1)).toMatchObject({
      type: "run_failed",
      detail: { reason: expect.stringMatching(/owner_not_confirmed/) },
    });
  });

  it("validates the governed Project inputs before recording a selection", async () => {
    const { host } = makeWorkspace({});
    const { runId, shortlist } = await rankedShortlist(host);
    const opportunity = shortlist.opportunities[0];

    await expect(
      host.select(runId, [opportunity.id], { ...projectInput, audience: "   " }),
    ).rejects.toThrow(/audience/i);
    await expect(
      host.select(runId, [opportunity.id], { ...projectInput, targets: [] }),
    ).rejects.toThrow(/target/i);
    await expect(
      host.select(runId, [opportunity.id], { ...projectInput, objective: "  " }),
    ).rejects.toThrow(/objective/i);
  });

  it("writes no Notion publication, no pack residue, and no remote deletion claim", async () => {
    const { runs, host } = makeWorkspace({});
    const { runId, shortlist } = await rankedShortlist(host);

    await host.select(runId, [shortlist.opportunities[0].id], projectInput);
    await host.idle();

    const detail = runs.detail(runId)!;
    expect(detail.events.filter((event) => /notion|content_draft|pack/i.test(event.type))).toEqual(
      [],
    );
    expect(detail.files.filter((file) => /notion|^draft-/i.test(file))).toEqual([]);
    expect(detail.result).not.toHaveProperty("packs");
    /* No governed method performs an outward Notion write: the starter's
       public surface is selection only, and the Project interface holds no
       publication method at all. */
    const projectMethods = Object.getOwnPropertyNames(WorkspaceContentProjects.prototype).filter(
      (name) => name !== "constructor",
    );
    expect(projectMethods.filter((name) => /notion|publish|page/i.test(name))).toEqual([]);
  });

  it("returns the same Project for a repeated starter call and refuses nothing silently", async () => {
    const { projects } = makeWorkspace({});
    const starter = contentProjectOpportunityStarter(projects);
    const input = {
      runId: "run_1",
      opportunityId: "opportunity-1",
      title: "Explain what the verified change means in practice",
      angle: "practical_implication" as const,
      angleDescription: "Explain the practical impact of the verified change.",
      urgency: "Useful while the change is new.",
      sourceUrls: ["https://example.com/story-1"],
      brandProfileRevisionId: "brand_1",
      project: projectInput,
    };
    const first = await starter.start(input);
    const second = await starter.start(input);
    expect(first.created).toBe(true);
    expect(second).toEqual({ projectId: first.projectId, created: false });
    expect(projects.projectByOpportunity("opportunity-1")!.id).toBe(first.projectId);
  });
});
