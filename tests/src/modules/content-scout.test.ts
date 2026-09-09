import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ContentScoutHost } from "../../../apps/server/src/modules/content-scout/host";
import { openRuns } from "../../../apps/server/src/runs";
import type { OpportunityRanker } from "../../../apps/server/src/modules/content-scout/ports";
import type { OpportunityProjectInput } from "../../../apps/server/src/content-projects/opportunity-projects";
import type { SourceAdapter } from "../../../apps/server/src/source-adapters/source-adapter";
import { ConfigStore } from "../../../apps/server/src/config";
import type { RankedOpportunity } from "@chief-of-staff-demo/shared";

const NOW = new Date("2026-08-25T12:00:00.000Z");

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
            id: "rss:story-1",
            externalId: "story-1",
            targetId: target.id,
            adapterId: "rss",
            canonicalUrl: "https://example.com/story-1",
            author: "Example Research",
            title: "A concrete change worth explaining",
            body: "The public source describes a verified change and its practical impact. The change was measured across multiple independent outlets and showed consistent results for early adopters.",
            description: null,
            publishedAt: "2026-08-25T10:00:00.000Z",
            discoveredAt: NOW.toISOString(),
            media: [],
            transcript:
              "The transcript covers the verified change and its practical impact for early adopters. It remains bounded to the first relevant minutes.",
            comments: [
              {
                author: "Reader One",
                publishedAt: "2026-08-25T10:30:00.000Z",
                url: "https://example.com/story-1#comment-1",
                text: "Does this change apply to existing customers as well?",
                engagement: 12,
              },
              {
                author: "Reader Two",
                publishedAt: "2026-08-25T10:35:00.000Z",
                url: "https://example.com/story-1#comment-2",
                text: "I disagree with the timeline — the rollout was announced last quarter, not this week.",
                engagement: 8,
              },
            ],
            evidence: [{ route: "fixture:rss", retrievedAt: NOW.toISOString() }],
            completeness: {
              title: "available",
              body: "available",
              description: "unavailable",
              transcript: "available",
              comments: "available",
              media: "unavailable",
            },
            storyKey: "verified-change-practical-impact",
            claims: [
              {
                text: "The verified change improves practical outcomes for early adopters",
                state: "supported",
                sourceUrls: ["https://example.com/story-1"],
              },
            ],
          },
          {
            id: "rss:story-a",
            externalId: "story-a",
            targetId: target.id,
            adapterId: "rss",
            canonicalUrl: "https://example.com/story-a",
            author: "Example Research",
            title: "Corroborating evidence for the verified change",
            body: "A second outlet corroborates the verified change and adds implementation detail. The practical impact appears consistent across both sources and suggests a near-term adoption path.",
            description: null,
            publishedAt: "2026-08-25T09:00:00.000Z",
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
            storyKey: "verified-change-practical-impact",
            claims: [
              {
                text: "The verified change was corroborated by a second independent outlet",
                state: "supported",
                sourceUrls: ["https://example.com/story-a"],
              },
            ],
          },
          {
            id: "rss:story-b",
            externalId: "story-b",
            targetId: target.id,
            adapterId: "rss",
            canonicalUrl: "https://example.com/story-b",
            author: "Example Research",
            title: "Additional analysis of the verified change",
            body: "A third source provides additional analysis of the verified change. It notes implementation considerations and a measured timeline for broader rollout. The analysis highlights operational steps and expected milestones for teams planning adoption.",
            description: null,
            publishedAt: "2026-08-25T08:00:00.000Z",
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
            storyKey: "verified-change-practical-impact",
            claims: [
              {
                text: "A third source provides additional analysis supporting the verified change",
                state: "supported",
                sourceUrls: ["https://example.com/story-b"],
              },
            ],
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

function websiteAdapter(): SourceAdapter {
  return {
    id: "website",
    state: "available",
    version: "fixture-1",
    supports: (target) => target.adapterId === "website",
    async collect() {
      return {
        kind: "failed",
        outcome: "response_shape_change",
        items: [],
        checkpoint: null,
        diagnostic: {
          classification: "response_shape_change",
          route: "fixture:website",
          status: 200,
          contentType: "text/html",
          parserStage: "readability",
          responseHash: "web-response-1",
          adapterVersion: "fixture-1",
          startedAt: NOW.toISOString(),
          finishedAt: NOW.toISOString(),
          retries: 0,
          affectedCapabilities: ["body"],
          causeChain: ["Article body selector no longer matched."],
        },
      };
    },
  };
}

const ranker: OpportunityRanker = {
  async rank({ items, brandProfile }) {
    return [
      {
        id: "opportunity-1",
        canonicalKey: "verified-change-practical-impact",
        title: "Explain what the verified change means in practice",
        angle: "practical_implication",
        angleDescription: "Explain the practical impact of the verified change.",
        materialDevelopment: null,
        urgency: "Useful while the change is new.",
        explanation: "It matches the Brand Profile's educational positioning.",
        sourceItemIds: items.map((item) => item.id),
        sourceUrls: items.map((item) => item.canonicalUrl),
        experimentalEvidence: false,
        confidence: 0.91,
        scores: {
          brandRelevance: brandProfile.markdown.includes("educational") ? 0.95 : 0.5,
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

describe("ContentScoutHost", () => {
  it("keeps content generation blocked until the owner Profile is confirmed", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-owner-gate-"));
    const runs = openRuns(workspaceDir);
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [rssAdapter()],
      ranker,
      isOwnerProfileConfirmed: () => false,
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
    const runId = await host.scoutNow();
    await host.idle();
    const opportunityId = host.activeShortlist()!.opportunities[0].id;

    await expect(host.select(runId, [opportunityId], projectInput)).rejects.toThrow(
      /owner Profile/i,
    );

    expect(runs.detail(runId)?.status).toBe("blocked");
    expect(host.activeShortlist()?.runId).toBe(runId);
  });

  it("persists configured sources, produces a ranked shortlist, and durably blocks the Intake Run", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-scout-"));
    const runs = openRuns(workspaceDir);
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [rssAdapter(), websiteAdapter()],
      ranker,
      log: () => undefined,
    });

    const revision = host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: {
        websiteUrl: "https://company.example",
        includedUrls: ["https://company.example/"],
        excludedUrls: [],
      },
      note: "Initial accepted profile",
    });
    const rss = host.addSourceTarget({
      adapterId: "rss",
      label: "Example Research",
      url: "https://example.com/feed.xml",
    });
    host.addSourceTarget({
      adapterId: "website",
      label: "Example newsroom",
      url: "https://news.example/updates",
    });

    const runId = await host.scoutNow();
    await host.idle();

    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("blocked");
    expect(detail.wait).toMatchObject({
      stage: "selection",
      timeout: { kind: "none" },
    });
    expect(detail.events.map((event) => event.type)).toEqual([
      "created",
      "stage_started",
      "source_adapter_attempted",
      "source_adapter_completed",
      "source_adapter_attempted",
      "source_adapter_failed",
      "stage_started",
      "shortlist_ranked",
      "stage_started",
      "run_blocked",
    ]);

    const shortlist = host.activeShortlist();
    expect(shortlist).toMatchObject({
      runId,
      brandProfileRevisionId: revision.id,
      omittedCount: 0,
      opportunities: [
        {
          id: expect.stringMatching(/^opportunity-/),
          state: "ready",
          title: "Explain what the verified change means in practice",
        },
      ],
    });
    expect(host.listSourceTargets().find((target) => target.id === rss.id)?.checkpoint).toBe(
      "rss-checkpoint-1",
    );
    expect(detail.result).toMatchObject({
      adapters: [
        { adapterId: "rss", outcome: "items_found", itemsFound: 3 },
        { adapterId: "website", outcome: "response_shape_change", itemsFound: 0 },
      ],
      shortlist: { opportunityCount: 1 },
      warnings: 1,
    });

    const reconstructed = new ContentScoutHost({
      runs: openRuns(workspaceDir),
      workspaceDir,
      now: () => NOW,
      adapters: [rssAdapter(), websiteAdapter()],
      ranker,
      log: () => undefined,
    });
    expect(reconstructed.activeShortlist()).toEqual(shortlist);
  });

  it("suppresses an equivalent drafted opportunity for seven days across restart", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-cooldown-draft-"));
    const clock = { now: NOW };
    const runs = openRuns(workspaceDir);
    const createHost = () =>
      new ContentScoutHost({
        runs: openRuns(workspaceDir),
        workspaceDir,
        now: () => clock.now,
        adapters: [rssAdapter()],
        ranker,
        log: () => undefined,
      });
    const host = createHost();
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({ adapterId: "rss", label: "Feed", url: "https://example.com/feed" });

    const firstRunId = await host.scoutNow();
    await host.idle();
    const opportunityId = host.activeShortlist()!.opportunities[0].id;
    await host.select(firstRunId, [opportunityId], projectInput);
    await host.idle();

    clock.now = new Date("2026-08-26T12:00:00.000Z");
    const restarted = createHost();
    await restarted.scoutNow();
    await restarted.idle();

    expect(restarted.activeShortlist()!.opportunities).toEqual([]);
    expect(runs.detail(firstRunId)!.status).toBe("failed");
  });

  it.each([
    ["Dismiss this angle", "dismiss_angle"],
    ["Not relevant", "not_relevant"],
    ["Already covered", "already_covered"],
  ] as const)("suppresses an equivalent opportunity after %s", async (_label, decision) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-cooldown-dismiss-"));
    const clock = { now: NOW };
    const createHost = () =>
      new ContentScoutHost({
        runs: openRuns(workspaceDir),
        workspaceDir,
        now: () => clock.now,
        adapters: [rssAdapter()],
        ranker,
        log: () => undefined,
      });
    const host = createHost();
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({ adapterId: "rss", label: "Feed", url: "https://example.com/feed" });
    const firstRunId = await host.scoutNow();
    await host.idle();
    host.decideOpportunity(firstRunId, host.activeShortlist()!.opportunities[0].id, decision);

    clock.now = new Date("2026-08-26T12:00:00.000Z");
    const restarted = createHost();
    await restarted.scoutNow();
    await restarted.idle();

    expect(restarted.activeShortlist()!.opportunities).toEqual([]);
  });

  it("allows an equivalent opportunity when the seven-day cooldown expires", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-cooldown-expiry-"));
    const clock = { now: NOW };
    const adapter = rssAdapter();
    const collect = adapter.collect.bind(adapter);
    adapter.collect = async (request) => {
      const result = await collect(request);
      return {
        ...result,
        items: result.items.map((item) => ({ ...item, publishedAt: clock.now.toISOString() })),
      };
    };
    const host = new ContentScoutHost({
      runs: openRuns(workspaceDir),
      workspaceDir,
      now: () => clock.now,
      adapters: [adapter],
      ranker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({ adapterId: "rss", label: "Feed", url: "https://example.com/feed" });
    const firstRunId = await host.scoutNow();
    await host.idle();
    host.decideOpportunity(
      firstRunId,
      host.activeShortlist()!.opportunities[0].id,
      "already_covered",
    );

    clock.now = new Date("2026-09-01T12:00:00.000Z");
    await host.scoutNow();
    await host.idle();

    expect(host.activeShortlist()!.opportunities).toHaveLength(1);
  });

  it("allows and labels a genuinely different stored angle during cooldown", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-cooldown-angle-"));
    const clock = { now: NOW };
    let angle = {
      type: "practical_implication" as RankedOpportunity["angle"],
      description: "Explain the practical impact of the verified change.",
    };
    const angleRanker: OpportunityRanker = {
      async rank(input) {
        return (await ranker.rank(input)).map(
          (opportunity) =>
            Object.assign(opportunity, {
              angle: angle.type,
              angleDescription: angle.description,
              materialDevelopment: null,
            }) as RankedOpportunity,
        );
      },
    };
    const createHost = () =>
      new ContentScoutHost({
        runs: openRuns(workspaceDir),
        workspaceDir,
        now: () => clock.now,
        adapters: [rssAdapter()],
        ranker: angleRanker,
        log: () => undefined,
      });
    const host = createHost();
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({ adapterId: "rss", label: "Feed", url: "https://example.com/feed" });
    const firstRunId = await host.scoutNow();
    await host.idle();
    host.decideOpportunity(
      firstRunId,
      host.activeShortlist()!.opportunities[0].id,
      "dismiss_angle",
    );

    clock.now = new Date("2026-08-26T12:00:00.000Z");
    angle = {
      type: "practical_implication",
      description: "Explain the practical implications of the verified change.",
    };
    const restarted = createHost();
    await restarted.scoutNow();
    await restarted.idle();
    expect(restarted.activeShortlist()!.opportunities).toEqual([]);

    angle = {
      type: "tactical_advice",
      description: "Turn the verified change into an operator checklist.",
    };
    await restarted.scoutNow();
    await restarted.idle();

    expect(restarted.activeShortlist()!.opportunities).toMatchObject([
      {
        angle: "tactical_advice",
        earlyFollowUp: {
          kind: "different_angle",
          explanation: "Different angle: Turn the verified change into an operator checklist.",
        },
      },
    ]);
    expect(createHost().activeShortlist()).toEqual(restarted.activeShortlist());
  });

  it("requires new supporting evidence and an explanation for a material follow-up", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-cooldown-development-"));
    const clock = { now: NOW };
    let includeNewEvidence = false;
    let developmentExplanation = "";
    const adapter = rssAdapter();
    const collect = adapter.collect.bind(adapter);
    adapter.collect = async (request) => {
      const result = await collect(request);
      const original = result.items.map((item) => ({
        ...item,
        storyKey: "verified-change",
        publishedAt: clock.now.toISOString(),
      }));
      return {
        ...result,
        items: includeNewEvidence
          ? [
              ...original,
              {
                ...original[0],
                id: "rss:story-2",
                externalId: "story-2",
                canonicalUrl: "https://example.com/story-2",
                title: "A material update to the verified change",
              },
            ]
          : original,
      };
    };
    const developmentRanker: OpportunityRanker = {
      async rank(input) {
        return (await ranker.rank(input)).map((opportunity) =>
          Object.assign(opportunity, {
            angleDescription: "Explain the practical impact of the verified change.",
            materialDevelopment: developmentExplanation
              ? {
                  explanation: developmentExplanation,
                  sourceItemIds: ["rss:story-2"],
                }
              : null,
          }),
        );
      },
    };
    const host = new ContentScoutHost({
      runs: openRuns(workspaceDir),
      workspaceDir,
      now: () => clock.now,
      adapters: [adapter],
      ranker: developmentRanker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({ adapterId: "rss", label: "Feed", url: "https://example.com/feed" });
    const firstRunId = await host.scoutNow();
    await host.idle();
    host.decideOpportunity(
      firstRunId,
      host.activeShortlist()!.opportunities[0].id,
      "already_covered",
    );

    clock.now = new Date("2026-08-26T12:00:00.000Z");
    developmentExplanation = "The new source confirms the announced change now has a firm date.";
    await host.scoutNow();
    await host.idle();
    expect(host.activeShortlist()!.opportunities).toEqual([]);

    includeNewEvidence = true;
    developmentExplanation = "";
    await host.scoutNow();
    await host.idle();
    expect(host.activeShortlist()!.opportunities).toEqual([]);

    developmentExplanation = "The new source confirms the announced change now has a firm date.";
    await host.scoutNow();
    await host.idle();
    expect(host.activeShortlist()!.opportunities).toMatchObject([
      {
        earlyFollowUp: {
          kind: "material_development",
          explanation: "The new source confirms the announced change now has a firm date.",
        },
      },
    ]);
  });

  it("collapses missed daily and weekly periods and keeps their schedule receipts independent across DST", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-schedule-"));
    const runs = openRuns(workspaceDir);
    const configStore = new ConfigStore(join(workspaceDir, "config.json"));
    configStore.load();
    configStore.setModuleConfig("content-scout", {
      ...configStore.get().modules["content-scout"],
      timeZone: "America/New_York",
      dailyTime: "08:00",
      weeklyDiscoveryDay: 1,
      weeklyDiscoveryTime: "09:00",
    });
    // Tuesday after the 2026 fall-back: today's daily period and this week's
    // missed Monday discovery period are each due exactly once.
    const clock = new Date("2026-11-03T14:00:00.000Z");
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      configStore,
      now: () => clock,
      adapters: [rssAdapter()],
      ranker,
      discoverer: {
        async discover() {
          return [
            {
              adapterId: "website",
              label: "Suggested public source",
              url: "https://suggested.example/updates",
              discoveredBecause: "Fixture relationship",
              evidenceUrls: ["https://example.com/story-1"],
              similarityFactors: ["Educational focus"],
            },
          ];
        },
      },
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({
      adapterId: "rss",
      label: "Research",
      url: "https://example.com/feed.xml",
    });

    await host.checkSchedules();
    await host.idle();
    await host.checkSchedules();
    await host.idle();

    const scheduled = runs.list({ module: "content-scout" }).runs;
    expect(scheduled).toHaveLength(2);
    expect(scheduled.map((run) => [run.intake, run.status])).toEqual(
      expect.arrayContaining([
        ["source-discovery", "done"],
        ["daily-intake", "blocked"],
      ]),
    );
    expect(host.listSourceSuggestions()).toHaveLength(1);
    expect(host.scheduleState()).toEqual({
      lastSuccessfulIntakePeriod: "2026-11-03",
      lastSuccessfulDiscoveryPeriod: "2026-W45",
    });
  });

  it("scans and accepts a Brand Profile without mutating the prior revision", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-brand-scan-"));
    const runs = openRuns(workspaceDir);
    let crawlRequest: unknown;
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [rssAdapter()],
      ranker,
      brandProfileCrawler: {
        async crawl(input) {
          crawlRequest = input;
          return [
            {
              url: input.websiteUrl,
              title: "Company",
              depth: 0,
              included: true,
              exclusionReason: null,
              text: "Practical educational company facts.",
            },
            {
              url: `${input.websiteUrl}/blog`,
              title: "Blog",
              depth: 1,
              included: false,
              exclusionReason: "Default exclusion",
              text: "",
            },
          ];
        },
      },
      brandProfileProposer: {
        async propose() {
          return `# Brand Profile

## Summary
New website proposal

## Products
Workflow software

## Customers
Operations teams

## Customer problems
Fragmented work

## Positioning
Practical, educational guidance

## Differentiators
Local ownership

## Proof
Published customer evidence

## Competitors
Manual processes

## Voice
Direct

## Vocabulary
Use precise terms

## Prohibited claims
No unsupported guarantees

## Content themes
Operational clarity

## Avoided subjects
Unverified rumors

## Geographic or regulatory constraints
United States only
`;
        },
      },
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Summary\nOriginal website value\n\n## Voice\nWarm\n",
      sourceScan: {
        websiteUrl: "https://company.example",
        includedUrls: [],
        excludedUrls: [],
      },
    });
    const current = host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Summary\nMaintained operator value\n\n## Voice\nWarm\n",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });

    const runId = await host.scanBrandProfile("https://company.example");
    await host.idle();

    expect(crawlRequest).toEqual({
      websiteUrl: "https://company.example",
      maxPages: 25,
      maxDepth: 2,
    });
    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("done");
    expect(
      detail.events
        .filter((event) => event.type === "stage_started")
        .map((event) => event.detail?.stage),
    ).toEqual(["crawl", "propose"]);
    expect(host.currentBrandProfile()).toEqual(current);
    const proposal = host.brandProfileProposal()!;
    expect(proposal).toMatchObject({
      runId,
      basedOnRevisionId: current.id,
      pages: [{ included: true }, { included: false }],
    });
    expect(proposal.sectionDiffs.find((diff) => diff.section === "Summary")).toMatchObject({
      currentValue: "Maintained operator value",
      proposedValue: "New website proposal",
      status: "conflicting",
    });
    expect(proposal.sectionDiffs.every((diff) => diff.proposedValue.length > 0)).toBe(true);
    expect(proposal.sectionDiffs.find((diff) => diff.section === "Products")?.proposedValue).toBe(
      "Workflow software",
    );

    const app = Fastify();
    host.routes(app);
    // Regression: the state projection must carry the pending proposal — a
    // dropped field here leaves every scan invisible to the UI.
    const scanState = (await app.inject({ method: "GET", url: "/api/content-scout" })).json<{
      brandProfileProposal: { id: string } | null;
    }>();
    expect(scanState.brandProfileProposal?.id).toBe(proposal.id);
    const acceptedSections = proposal.sectionDiffs.map((diff) => diff.section);
    const response = await app.inject({
      method: "POST",
      url: `/api/content-scout/brand-profile/proposals/${proposal.id}/accept`,
      payload: { acceptedSections },
    });
    expect(response.statusCode).toBe(201);
    const accepted = host.currentBrandProfile()!;
    expect(accepted.markdown.match(/^## /gm)).toHaveLength(14);
    expect(accepted.markdown).toContain(
      "## Geographic or regulatory constraints\nUnited States only",
    );

    await app.close();
  });

  it("serves revision history and restores a past revision as a new current one", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-brand-history-"));
    const runs = openRuns(workspaceDir);
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [rssAdapter()],
      ranker,
      log: () => undefined,
    });
    const initial = host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Summary\nFirst version\n",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
      note: "Initial accepted website proposal",
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Summary\nSecond version\n",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
      note: "Manual revision",
    });

    const app = Fastify();
    host.routes(app);

    const listed = (await app.inject({ method: "GET", url: "/api/content-scout" })).json<{
      brandProfileRevisions: { id: string; note: string | null }[];
    }>();
    expect(listed.brandProfileRevisions.map((revision) => revision.id)).toEqual([
      initial.id,
      expect.any(String),
    ]);
    expect(listed.brandProfileRevisions[0]).not.toHaveProperty("markdown");

    const read = await app.inject({
      method: "GET",
      url: `/api/content-scout/brand-profile/revisions/${initial.id}`,
    });
    expect(read.statusCode).toBe(200);
    // Pin the endpoint's documented shape at the typed json<T> boundary.
    const stored = read.json<{ revision: { markdown: string } }>();
    expect(stored.revision.markdown).toContain("First version");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/content-scout/brand-profile/revisions/brand_absent",
        })
      ).statusCode,
    ).toBe(404);

    const restored = await app.inject({
      method: "POST",
      url: `/api/content-scout/brand-profile/revisions/${initial.id}/restore`,
      payload: {},
    });
    expect(restored.statusCode).toBe(201);
    const current = host.currentBrandProfile()!;
    expect(current.markdown).toContain("First version");
    expect(current.note).toBe(`Restored from ${initial.id}`);
    expect(current.id).not.toBe(initial.id);
    /* Restore appends; the stored revision it copied from survives untouched. */
    const reread = await app.inject({
      method: "GET",
      url: `/api/content-scout/brand-profile/revisions/${initial.id}`,
    });
    const untouched = reread.json<{ revision: { markdown: string } }>();
    expect(untouched.revision.markdown).toContain("First version");
    const after = (await app.inject({ method: "GET", url: "/api/content-scout" })).json<{
      brandProfileRevisions: unknown[];
    }>();
    expect(after.brandProfileRevisions).toHaveLength(3);

    await app.close();
  });

  it("supersedes an older blocked shortlist only after its replacement ranks successfully", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-supersede-"));
    const runs = openRuns(workspaceDir);
    let failRanking = false;
    const switchingRanker: OpportunityRanker = {
      async rank(input) {
        if (failRanking) throw new Error("ranking unavailable");
        return await ranker.rank(input);
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [rssAdapter()],
      ranker: switchingRanker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\nEducational guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({ adapterId: "rss", label: "Feed", url: "https://example.com/feed" });
    const oldRunId = await host.scoutNow();
    await host.idle();
    expect(runs.detail(oldRunId)!.status).toBe("blocked");

    failRanking = true;
    const failedReplacement = await host.scoutNow();
    await host.idle();
    expect(runs.detail(failedReplacement)!.status).toBe("failed");
    expect(runs.detail(oldRunId)!.status).toBe("blocked");
    expect(host.activeShortlist()?.runId).toBe(oldRunId);

    failRanking = false;
    const successfulReplacement = await host.scoutNow();
    await host.idle();
    expect(runs.detail(successfulReplacement)!.status).toBe("blocked");
    expect(runs.detail(oldRunId)!).toMatchObject({
      status: "skipped",
      skipReason: `Superseded by ${successfulReplacement}.`,
      wait: null,
    });
  });

  it("enriches only promising Source Items and records discarded items", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-enrichment-promise-"));
    const runs = openRuns(workspaceDir);
    const enrichedIds: string[] = [];
    const adapter: SourceAdapter = {
      id: "youtube",
      state: "available",
      version: "fixture-1",
      supports: (target) => target.adapterId === "youtube",
      async collect({ target }) {
        return {
          kind: "completed",
          outcome: "items_found",
          checkpoint: "yt-checkpoint",
          items: [
            {
              id: "yt:promising",
              externalId: "promising",
              targetId: target.id,
              adapterId: "youtube",
              canonicalUrl: "https://youtube.com/watch?v=promising",
              author: "Channel A",
              title: "A detailed interoperability walkthrough with practical steps",
              body: "This video explains the rule, the deadline, and concrete implementation steps that teams can follow. It is long enough to support transcript work.",
              description: null,
              publishedAt: "2026-08-25T10:00:00.000Z",
              discoveredAt: NOW.toISOString(),
              media: [{ type: "video", url: "https://youtube.com/watch?v=promising" }],
              transcript: null,
              comments: [],
              evidence: [{ route: "fixture:youtube", retrievedAt: NOW.toISOString() }],
              completeness: {
                title: "available",
                body: "available",
                description: "unavailable",
                transcript: "unavailable",
                comments: "unavailable",
                media: "available",
              },
            },
            {
              id: "yt:thin",
              externalId: "thin",
              targetId: target.id,
              adapterId: "youtube",
              canonicalUrl: "https://youtube.com/watch?v=thin",
              author: "Channel B",
              title: "News flash",
              body: "Brief update.",
              description: null,
              publishedAt: "2026-08-25T10:00:00.000Z",
              discoveredAt: NOW.toISOString(),
              media: [{ type: "video", url: "https://youtube.com/watch?v=thin" }],
              transcript: null,
              comments: [],
              evidence: [{ route: "fixture:youtube", retrievedAt: NOW.toISOString() }],
              completeness: {
                title: "available",
                body: "available",
                description: "unavailable",
                transcript: "unavailable",
                comments: "unavailable",
                media: "available",
              },
            },
          ],
          diagnostic: {
            classification: "items_found",
            route: "fixture:youtube",
            status: 200,
            contentType: "application/json",
            parserStage: "youtube",
            responseHash: "yt-response",
            adapterVersion: "fixture-1",
            startedAt: NOW.toISOString(),
            finishedAt: NOW.toISOString(),
            retries: 0,
            affectedCapabilities: [],
            causeChain: [],
          },
        };
      },
      async enrich(items) {
        for (const item of items) enrichedIds.push(item.id);
        return items.map((item) => ({
          ...item,
          transcript: item.id === "yt:promising" ? "Detailed transcript text." : null,
          comments:
            item.id === "yt:promising"
              ? [
                  {
                    author: "Viewer One",
                    publishedAt: "2026-08-25T11:00:00.000Z",
                    url: "https://youtube.com/watch?v=promising&lc=1",
                    text: "What does this mean for small teams?",
                    engagement: 12,
                  },
                  {
                    author: "Viewer Two",
                    publishedAt: "2026-08-25T11:05:00.000Z",
                    url: "https://youtube.com/watch?v=promising&lc=2",
                    text: "I disagree with the deadline assumption.",
                    engagement: 8,
                  },
                  {
                    author: "Viewer Three",
                    publishedAt: "2026-08-25T11:10:00.000Z",
                    url: "https://youtube.com/watch?v=promising&lc=3",
                    text: "Very useful summary.",
                    engagement: 45,
                  },
                ]
              : [],
          completeness: {
            ...item.completeness,
            transcript: "available",
            comments: "available",
          },
        }));
      },
    };
    const selectingRanker: OpportunityRanker = {
      async rank({ items }) {
        return items.map((item) => ({
          id: `opportunity-${item.id}`,
          canonicalKey: item.id,
          title: item.title ?? "Untitled",
          angle: "practical_implication",
          angleDescription: "Explain the practical impact.",
          materialDevelopment: null,
          urgency: "Now.",
          explanation: "Matches brand.",
          sourceItemIds: [item.id],
          sourceUrls: [item.canonicalUrl],
          experimentalEvidence: false,
          confidence: item.id === "yt:promising" ? 0.9 : 0.5,
          scores: {
            brandRelevance: 0.9,
            audienceUsefulness: 0.8,
            timeliness: 0.9,
            novelty: 0.7,
            evidenceStrength: item.id === "yt:promising" ? 0.9 : 0.4,
            evidenceDiversity: 0.5,
            specificity: 0.8,
            originalPerspective: 0.7,
            packApplicability: 0.8,
            speculationRisk: 0.1,
          },
        }));
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [adapter],
      ranker: selectingRanker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({
      adapterId: "youtube",
      label: "Fixture channel",
      url: "https://youtube.com/channel/fixture",
    });
    const runId = await host.scoutNow();
    await host.idle();

    expect(runs.detail(runId)!.status).toBe("blocked");
    expect(enrichedIds).toEqual(["yt:promising"]);
    const run = runs.open(runId)!;
    const discarded = JSON.parse(run.readArtifact("discarded-items.json")!) as { id: string }[];
    expect(discarded.map((item) => item.id)).toContain("yt:thin");
    const promising = JSON.parse(run.readArtifact("promising-items.json")!) as { id: string }[];
    expect(promising.map((item) => item.id)).toEqual(["yt:promising"]);
    const enriched = JSON.parse(run.readArtifact("enriched-source-items.json")!) as {
      id: string;
      comments: { text: string; engagement: number }[];
    }[];
    expect(enriched.map((item) => item.id)).toEqual(["yt:promising"]);
    expect(enriched[0].comments.map((comment) => comment.text)).toEqual([
      "What does this mean for small teams?",
      "I disagree with the deadline assumption.",
      "Very useful summary.",
    ]);
    expect(enriched[0].comments).toHaveLength(3);
    expect(runs.detail(runId)!.result).toMatchObject({ warnings: 0 });
  });

  it("keeps enrichment as a warning when evidence is otherwise sufficient", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-enrichment-warning-"));
    const runs = openRuns(workspaceDir);
    const adapter: SourceAdapter = {
      id: "youtube",
      state: "available",
      version: "fixture-1",
      supports: (target) => target.adapterId === "youtube",
      async collect({ target }) {
        return {
          kind: "completed",
          outcome: "items_found",
          checkpoint: "yt-checkpoint",
          items: [
            {
              id: "yt:good",
              externalId: "good",
              targetId: target.id,
              adapterId: "youtube",
              canonicalUrl: "https://youtube.com/watch?v=good",
              author: "Channel A",
              title: "A detailed interoperability walkthrough with practical steps",
              body: "This video explains the rule, the deadline, and concrete implementation steps that teams can follow. It includes examples and practical guidance throughout with additional context for operators planning their next content calendar release.",
              description: null,
              publishedAt: "2026-08-25T10:00:00.000Z",
              discoveredAt: NOW.toISOString(),
              media: [{ type: "video", url: "https://youtube.com/watch?v=good" }],
              transcript: null,
              comments: [],
              evidence: [{ route: "fixture:youtube", retrievedAt: NOW.toISOString() }],
              completeness: {
                title: "available",
                body: "available",
                description: "unavailable",
                transcript: "unavailable",
                comments: "unavailable",
                media: "available",
              },
            },
          ],
          diagnostic: {
            classification: "items_found",
            route: "fixture:youtube",
            status: 200,
            contentType: "application/json",
            parserStage: "youtube",
            responseHash: "yt-response",
            adapterVersion: "fixture-1",
            startedAt: NOW.toISOString(),
            finishedAt: NOW.toISOString(),
            retries: 0,
            affectedCapabilities: [],
            causeChain: [],
          },
        };
      },
      async enrich() {
        throw new Error("transcript service unavailable");
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [adapter],
      ranker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical, educational guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({
      adapterId: "youtube",
      label: "Fixture channel",
      url: "https://youtube.com/channel/fixture",
    });
    const runId = await host.scoutNow();
    await host.idle();

    expect(runs.detail(runId)!.status).toBe("blocked");
    expect(runs.detail(runId)!.result).toMatchObject({ warnings: 1 });
    const enriched = JSON.parse(runs.open(runId)!.readArtifact("enriched-source-items.json")!) as {
      id: string;
      completeness: {
        transcript: string;
        comments: string;
        title: string;
        body: string;
        description: string;
      };
    }[];
    expect(enriched[0].completeness).toMatchObject({
      transcript: "failed",
      comments: "failed",
    });
    expect(
      runs
        .detail(runId)!
        .events.some(
          (event) => event.type === "enrichment_failed" && event.detail?.adapterId === "youtube",
        ),
    ).toBe(true);
  });

  it("excludes ineligible items before expensive enrichment", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-eligibility-enrich-"));
    const runs = openRuns(workspaceDir);
    const enrichedIds: string[] = [];
    const adapter: SourceAdapter = {
      id: "rss",
      state: "available",
      version: "fixture-1",
      supports: (target) => target.adapterId === "rss",
      async collect({ target }) {
        const base = {
          targetId: target.id,
          adapterId: "rss",
          author: "Example",
          title: "A detailed interoperability walkthrough with practical steps",
          body: "This collected source explains the rule, the deadline, and concrete implementation steps that teams can follow with additional context for planning and execution across the next quarter.",
          description: null,
          discoveredAt: NOW.toISOString(),
          media: [],
          evidence: [{ route: "fixture:rss", retrievedAt: NOW.toISOString() }],
          completeness: {
            title: "available" as const,
            body: "available" as const,
            description: "unavailable" as const,
            transcript: "unavailable" as const,
            comments: "unavailable" as const,
            media: "unavailable" as const,
          },
        };
        return {
          kind: "completed",
          outcome: "items_found",
          checkpoint: "rss-checkpoint",
          items: [
            {
              id: "rss:good",
              externalId: "good",
              canonicalUrl: "https://example.com/a",
              publishedAt: "2026-08-25T10:00:00.000Z",
              transcript: null,
              comments: [],
              ...base,
            },
            {
              id: "rss:stale",
              externalId: "stale",
              canonicalUrl: "https://example.com/stale",
              publishedAt: "2026-08-10T10:00:00.000Z",
              transcript: null,
              comments: [],
              ...base,
              title: "Stale but detailed interoperability walkthrough with practical steps",
            },
            {
              id: "rss:prohibited",
              externalId: "prohibited",
              canonicalUrl: "https://example.com/prohibited",
              publishedAt: "2026-08-25T10:00:00.000Z",
              transcript: null,
              comments: [],
              ...base,
              body: "This collected source explains the rule and crypto scams with concrete implementation steps that teams can follow with additional context for planning and execution across the next quarter.",
            },
          ],
          diagnostic: {
            classification: "items_found",
            route: "fixture:rss",
            status: 200,
            contentType: "application/rss+xml",
            parserStage: "rss",
            responseHash: "rss-response",
            adapterVersion: "fixture-1",
            startedAt: NOW.toISOString(),
            finishedAt: NOW.toISOString(),
            retries: 0,
            affectedCapabilities: [],
            causeChain: [],
          },
        };
      },
      async enrich(items) {
        for (const item of items) enrichedIds.push(item.id);
        return items.map((item) => ({
          ...item,
          transcript: "Enriched transcript.",
          completeness: {
            ...item.completeness,
            transcript: "available" as const,
            comments: "available" as const,
          },
        }));
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [adapter],
      ranker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown:
        "# Brand Profile\n\n## Positioning\nPractical guidance.\n\n## Avoided subjects\n- crypto scams\n",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({
      adapterId: "rss",
      label: "Fixture",
      url: "https://example.com/feed.xml",
    });
    const archivedTargetId = "archived-target";
    // oxlint-disable-next-line typescript/unbound-method
    const originalCollect = adapter.collect;
    adapter.collect = async (input) => {
      const result = await originalCollect(input);
      result.items.push({
        id: "rss:archived",
        externalId: "archived",
        targetId: archivedTargetId,
        adapterId: "rss",
        canonicalUrl: "https://example.com/archived",
        author: "Example",
        title: "Archived target detailed walkthrough with practical steps",
        body: "This collected source explains the rule, the deadline, and concrete implementation steps that teams can follow with additional context for planning and execution across the next quarter.",
        description: null,
        publishedAt: "2026-08-25T10:00:00.000Z",
        discoveredAt: NOW.toISOString(),
        media: [],
        transcript: null,
        comments: [],
        evidence: [{ route: "fixture:rss", retrievedAt: NOW.toISOString() }],
        completeness: {
          title: "available",
          body: "available",
          description: "unavailable",
          transcript: "unavailable",
          comments: "unavailable",
          media: "unavailable",
        },
      });
      return result;
    };
    const archived = host.addSourceTarget({
      adapterId: "rss",
      label: "Archived",
      url: "https://example.com/archived.xml",
    });
    host.setSourceTargetState(archived.id, "archived");
    const realArchivedId = archived.id;
    // oxlint-disable-next-line typescript/unbound-method
    const priorCollect = adapter.collect;
    adapter.collect = async (input) => {
      const res = await priorCollect(input);
      const injected = res.items.find((i) => i.id === "rss:archived");
      if (injected) injected.targetId = realArchivedId;
      return res;
    };

    const runId = await host.scoutNow();
    await host.idle();

    expect(enrichedIds).toEqual(["rss:good"]);
    const run = runs.open(runId)!;
    const eligibility = JSON.parse(run.readArtifact("eligibility.json")!) as {
      exclusions: { sourceItemId: string; reason: string }[];
    };
    const reasons = Object.fromEntries(
      eligibility.exclusions.map((e) => [e.sourceItemId, e.reason]),
    );
    expect(reasons["rss:stale"]).toBe("stale");
    expect(reasons["rss:prohibited"]).toBe("prohibited_subject");
    expect(reasons["rss:archived"]).toBe("archived_target");
    const promising = JSON.parse(run.readArtifact("promising-items.json")!) as { id: string }[];
    expect(promising.map((p) => p.id)).toEqual(["rss:good"]);
    const discarded = JSON.parse(run.readArtifact("discarded-items.json")!) as { id: string }[];
    expect(discarded.map((d) => d.id)).not.toContain("rss:good");
  });
  it("keeps broken Substack enrichment a loud warning and preserves usable feed text", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-substack-enrichment-"));
    const runs = openRuns(workspaceDir);
    const adapter: SourceAdapter = {
      id: "substack",
      state: "available",
      version: "fixture-1",
      supports: (target) => target.adapterId === "substack",
      async collect({ target }) {
        return {
          kind: "completed",
          outcome: "items_found",
          checkpoint: "substack-checkpoint",
          items: [
            {
              id: "rss:substack-post",
              externalId: "substack-post",
              targetId: target.id,
              adapterId: "substack",
              canonicalUrl: "https://research-public.substack.com/p/a-text-only-post",
              author: "Research Author",
              title: "A text-only analysis of the verified change",
              body: "A text-only analysis explains the verified change and its practical impact for teams that plan adoption. The analysis walks through the deadline, the concrete implementation steps, and the measured rollout milestones that operators should expect during the next quarter and beyond.",
              description: null,
              publishedAt: "2026-08-25T10:00:00.000Z",
              discoveredAt: NOW.toISOString(),
              media: [],
              transcript: null,
              comments: [],
              evidence: [{ route: "fixture:substack", retrievedAt: NOW.toISOString() }],
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
            route: "fixture:substack",
            status: 200,
            contentType: "application/rss+xml",
            parserStage: "rss",
            responseHash: "substack-response",
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
    const enrichAdapter: SourceAdapter = {
      id: "substack",
      state: "available",
      version: "substack-public-page-v1",
      supports: () => false,
      async collect(): Promise<never> {
        throw new Error("collects nothing; Substack posts arrive through the RSS route");
      },
      async enrich() {
        throw new Error("post page unavailable");
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [adapter, enrichAdapter],
      ranker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({
      adapterId: "substack",
      label: "Research Substack",
      url: "https://research-public.substack.com/feed",
    });
    const runId = await host.scoutNow();
    await host.idle();

    expect(runs.detail(runId)!.status).toBe("blocked");
    expect(runs.detail(runId)!.result).toMatchObject({ warnings: 1 });
    expect(
      runs
        .detail(runId)!
        .events.some(
          (event) => event.type === "enrichment_failed" && event.detail?.adapterId === "substack",
        ),
    ).toBe(true);
    const enriched = JSON.parse(runs.open(runId)!.readArtifact("enriched-source-items.json")!) as {
      id: string;
      body: string;
      title: string;
      completeness: Record<string, string>;
    }[];
    expect(enriched[0]).toMatchObject({
      id: "rss:substack-post",
      title: "A text-only analysis of the verified change",
      completeness: { body: "available", media: "failed" },
    });
    expect(enriched[0].body).toContain("A text-only analysis explains the verified change");
  });

  it("caps comment enrichment at 50 and preserves questions and disagreement", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-comments-cap-"));
    const runs = openRuns(workspaceDir);
    const adapter: SourceAdapter = {
      id: "youtube",
      state: "available",
      version: "fixture-1",
      supports: (target) => target.adapterId === "youtube",
      async collect({ target }) {
        return {
          kind: "completed",
          outcome: "items_found",
          checkpoint: "yt-checkpoint",
          items: [
            {
              id: "yt:popular",
              externalId: "popular",
              targetId: target.id,
              adapterId: "youtube",
              canonicalUrl: "https://youtube.com/watch?v=popular",
              author: "Channel A",
              title: "A detailed interoperability walkthrough with practical steps",
              body: "This video explains the rule, the deadline, and concrete implementation steps that teams can follow with additional context for planning and execution across the next quarter and beyond.",
              description: null,
              publishedAt: "2026-08-25T10:00:00.000Z",
              discoveredAt: NOW.toISOString(),
              media: [{ type: "video", url: "https://youtube.com/watch?v=popular" }],
              transcript: null,
              comments: [],
              evidence: [{ route: "fixture:youtube", retrievedAt: NOW.toISOString() }],
              completeness: {
                title: "available",
                body: "available",
                description: "unavailable",
                transcript: "unavailable",
                comments: "unavailable",
                media: "available",
              },
            },
          ],
          diagnostic: {
            classification: "items_found",
            route: "fixture:youtube",
            status: 200,
            contentType: "application/json",
            parserStage: "youtube",
            responseHash: "yt-response",
            adapterVersion: "fixture-1",
            startedAt: NOW.toISOString(),
            finishedAt: NOW.toISOString(),
            retries: 0,
            affectedCapabilities: [],
            causeChain: [],
          },
        };
      },
      async enrich(items) {
        return items.map((item) => {
          const comments = [];
          for (let i = 0; i < 70; i += 1) {
            comments.push({
              author: `Viewer ${i}`,
              publishedAt: "2026-08-25T11:00:00.000Z",
              url: `https://youtube.com/watch?v=popular&lc=${i}`,
              text: `Popular agreement ${i} very useful.`,
              engagement: 100 - i,
            });
          }
          comments.push({
            author: "Questioner",
            publishedAt: "2026-08-25T11:30:00.000Z",
            url: "https://youtube.com/watch?v=popular&lc=q",
            text: "What does this mean for small teams?",
            engagement: 1,
          });
          comments.push({
            author: "Critic",
            publishedAt: "2026-08-25T11:31:00.000Z",
            url: "https://youtube.com/watch?v=popular&lc=d",
            text: "I disagree with the deadline assumption, it is misleading.",
            engagement: 2,
          });
          return {
            ...item,
            comments,
            completeness: {
              ...item.completeness,
              transcript: "available" as const,
              comments: "available" as const,
            },
          };
        });
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [adapter],
      ranker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({
      adapterId: "youtube",
      label: "Fixture",
      url: "https://youtube.com/channel/fixture",
    });
    const runId = await host.scoutNow();
    await host.idle();
    const enriched = JSON.parse(runs.open(runId)!.readArtifact("enriched-source-items.json")!) as {
      comments: { text: string }[];
    }[];
    expect(enriched[0].comments).toHaveLength(50);
    const texts = enriched[0].comments.map((c) => c.text);
    expect(texts).toContain("What does this mean for small teams?");
    expect(texts).toContain("I disagree with the deadline assumption, it is misleading.");
    expect(texts).toContain("Popular agreement 0 very useful.");
  });

  it("keeps unavailable, unsupported and failed transcript and comment states distinct", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-field-states-"));
    const runs = openRuns(workspaceDir);
    const adapter: SourceAdapter = {
      id: "youtube",
      state: "available",
      version: "fixture-1",
      supports: (target) => target.adapterId === "youtube",
      async collect({ target }) {
        return {
          kind: "completed",
          outcome: "items_found",
          checkpoint: "yt-checkpoint",
          items: [
            {
              id: "yt:unsupported",
              externalId: "unsupported",
              targetId: target.id,
              adapterId: "youtube",
              canonicalUrl: "https://youtube.com/watch?v=unsupported",
              author: "Channel A",
              title: "A detailed walkthrough with practical steps for operators",
              body: "This video explains the rule, the deadline, and concrete implementation steps that teams can follow with additional context for planning and execution across the next quarter and beyond for operators.",
              description: null,
              publishedAt: "2026-08-25T10:00:00.000Z",
              discoveredAt: NOW.toISOString(),
              media: [{ type: "video", url: "https://youtube.com/watch?v=unsupported" }],
              transcript: null,
              comments: [],
              evidence: [{ route: "fixture:youtube", retrievedAt: NOW.toISOString() }],
              completeness: {
                title: "available",
                body: "available",
                description: "unavailable",
                transcript: "unsupported",
                comments: "unsupported",
                media: "available",
              },
            },
            {
              id: "yt:unavailable",
              externalId: "unavailable",
              targetId: target.id,
              adapterId: "youtube",
              canonicalUrl: "https://youtube.com/watch?v=unavailable",
              author: "Channel B",
              title: "Another detailed walkthrough with practical steps for operators",
              body: "This video explains the process, the timeline, and concrete implementation steps that teams can follow with additional context for planning and execution across the next quarter and beyond for operators.",
              description: null,
              publishedAt: "2026-08-25T10:00:00.000Z",
              discoveredAt: NOW.toISOString(),
              media: [{ type: "video", url: "https://youtube.com/watch?v=unavailable" }],
              transcript: null,
              comments: [],
              evidence: [{ route: "fixture:youtube", retrievedAt: NOW.toISOString() }],
              completeness: {
                title: "available",
                body: "available",
                description: "unavailable",
                transcript: "unavailable",
                comments: "unavailable",
                media: "available",
              },
            },
          ],
          diagnostic: {
            classification: "items_found",
            route: "fixture:youtube",
            status: 200,
            contentType: "application/json",
            parserStage: "youtube",
            responseHash: "yt-response",
            adapterVersion: "fixture-1",
            startedAt: NOW.toISOString(),
            finishedAt: NOW.toISOString(),
            retries: 0,
            affectedCapabilities: [],
            causeChain: [],
          },
        };
      },
      async enrich() {
        throw new Error("enrichment unavailable");
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => NOW,
      adapters: [adapter],
      ranker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical guidance.",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    host.addSourceTarget({
      adapterId: "youtube",
      label: "Fixture",
      url: "https://youtube.com/channel/fixture",
    });
    const runId = await host.scoutNow();
    await host.idle();
    const enriched = JSON.parse(runs.open(runId)!.readArtifact("enriched-source-items.json")!) as {
      id: string;
      completeness: { transcript: string; comments: string };
    }[];
    const byId = Object.fromEntries(enriched.map((e) => [e.id, e.completeness]));
    expect(byId["yt:unsupported"]).toMatchObject({
      transcript: "unsupported",
      comments: "unsupported",
    });
    const full = JSON.parse(runs.open(runId)!.readArtifact("enriched-source-items.json")!) as {
      id: string;
      completeness: Record<string, string>;
    }[];
    const fullById = Object.fromEntries(full.map((e) => [e.id, e.completeness]));
    expect(fullById["yt:unavailable"].transcript).toBe("failed");
    expect(fullById["yt:unavailable"].comments).toBe("failed");
    expect(fullById["yt:unsupported"].transcript).toBe("unsupported");
    expect(fullById["yt:unsupported"].comments).toBe("unsupported");
    expect(runs.detail(runId)!.result).toMatchObject({ warnings: 1 });
  });
});
