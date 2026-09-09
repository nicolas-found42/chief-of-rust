import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import fastify from "fastify";
import type { ContentScoutRunResult, SourceItem } from "@chief-of-staff-demo/shared";
import { SOURCE_BACKFILL_WINDOWS_DAYS } from "@chief-of-staff-demo/shared";
import { ContentScoutHost } from "../../../apps/server/src/modules/content-scout/host";
import type { OpportunityRanker } from "../../../apps/server/src/modules/content-scout/ports";
import type { SourceAdapter } from "../../../apps/server/src/source-adapters/source-adapter";
import { openRuns } from "../../../apps/server/src/runs";

const START = Date.parse("2026-08-25T12:00:00.000Z");

const noOpRanker: OpportunityRanker = {
  async rank() {
    return [];
  },
};

function backfillItem(targetId: string, now: Date): SourceItem {
  return {
    id: `${targetId}:story-1`,
    externalId: "story-1",
    targetId,
    adapterId: "rss",
    canonicalUrl: "https://example.com/story-1",
    author: "Example Research",
    title: "A verified change worth explaining",
    body: "The public source describes a verified change and its practical impact.",
    description: null,
    publishedAt: now.toISOString(),
    discoveredAt: now.toISOString(),
    media: [],
    transcript: null,
    comments: [],
    evidence: [{ route: "fixture:rss", retrievedAt: now.toISOString() }],
    completeness: {
      title: "available",
      body: "available",
      description: "unavailable",
      transcript: "unsupported",
      comments: "unsupported",
      media: "unavailable",
    },
  };
}

describe("Source Target backfills", () => {
  it("collects a supported window into a durable Run and never touches the Daily Intake checkpoint", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-backfill-supported-"));
    const runs = openRuns(workspaceDir);
    let nowMs = START;
    const rss: SourceAdapter = {
      id: "rss",
      state: "available",
      version: "fixture-1",
      backfillWindowsDays: SOURCE_BACKFILL_WINDOWS_DAYS,
      supports: (target) => target.adapterId === "rss",
      async collect({ target }) {
        const now = new Date(nowMs);
        return {
          kind: "completed",
          outcome: "items_found",
          checkpoint: `checkpoint-${nowMs}`,
          items: [backfillItem(target.id, now)],
          diagnostic: {
            classification: "items_found",
            route: "fixture:rss",
            status: 200,
            contentType: "application/rss+xml",
            parserStage: "rss",
            responseHash: "hash-1",
            adapterVersion: "fixture-1",
            startedAt: now.toISOString(),
            finishedAt: now.toISOString(),
            retries: 0,
            affectedCapabilities: [],
            causeChain: [],
          },
        };
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => new Date(nowMs),
      adapters: [rss],
      ranker: noOpRanker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical guidance.\n",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    const target = host.addSourceTarget({
      adapterId: "rss",
      label: "Example Research",
      url: "https://example.com/feed.xml",
    });

    // A prior Daily Intake sets the checkpoint the backfill must not disturb.
    await host.scoutNow();
    await host.idle();
    const dailyItemId = `${target.id}:story-1`;
    const checkpointBeforeBackfill = host
      .listSourceTargets()
      .find((candidate) => candidate.id === target.id)!.checkpoint;
    expect(checkpointBeforeBackfill).not.toBeNull();

    nowMs += 60_000;
    const runId = await host.backfillSourceTarget(target.id, 30);
    await host.idle();

    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("done");
    expect(detail.sourceUrl).toBe(target.url);
    expect(runs.open(runId)?.read().externalId).toBe(`${target.id}:30`);
    const result = detail.result as ContentScoutRunResult;
    expect(result.backfill).toEqual({
      targetId: target.id,
      windowDays: 30,
      adapterId: "rss",
      supported: true,
    });
    expect(result.adapters).toEqual([
      expect.objectContaining({ adapterId: "rss", outcome: "items_found", itemsFound: 1 }),
    ]);
    const items = JSON.parse(runs.open(runId)!.readArtifact("source-items.json")!) as SourceItem[];
    expect(items).toHaveLength(1);
    // Same Source Target + external id, so the identity is stable across a
    // Daily Intake collection and a backfill of the same evidence.
    expect(items[0].id).toBe(dailyItemId);

    const afterBackfill = host.listSourceTargets().find((candidate) => candidate.id === target.id)!;
    expect(afterBackfill.checkpoint).toBe(checkpointBeforeBackfill);
  });

  it("fails a window the Source Adapter does not declare as unsupported_capability instead of an empty success", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-backfill-unsupported-"));
    const runs = openRuns(workspaceDir);
    let calls = 0;
    const website: SourceAdapter = {
      id: "website",
      state: "available",
      version: "fixture-1",
      // No backfillWindowsDays declared: a single current-page snapshot has no history.
      supports: (target) => target.adapterId === "website",
      async collect() {
        calls += 1;
        throw new Error("The Adapter must not be called for an unsupported window.");
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => new Date(START),
      adapters: [website],
      ranker: noOpRanker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical guidance.\n",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    const target = host.addSourceTarget({
      adapterId: "website",
      label: "Example newsroom",
      url: "https://news.example/updates",
    });

    const runId = await host.backfillSourceTarget(target.id, 7);
    await host.idle();

    expect(calls).toBe(0);
    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("failed");
    expect(detail.failedStage).toBe("collect");
    expect(detail.failureHint).toContain("does not support");
    const result = detail.result as ContentScoutRunResult;
    expect(result.backfill).toEqual({
      targetId: target.id,
      windowDays: 7,
      adapterId: "website",
      supported: false,
    });
    expect(result.adapters).toEqual([
      expect.objectContaining({ adapterId: "website", outcome: "unsupported_capability" }),
    ]);
  });

  it("sanitizes a raw response body before it ever reaches a durable Run artifact", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-backfill-sanitized-diagnostic-"));
    const runs = openRuns(workspaceDir);
    const rss: SourceAdapter = {
      id: "rss",
      state: "available",
      version: "fixture-1",
      backfillWindowsDays: SOURCE_BACKFILL_WINDOWS_DAYS,
      supports: (target) => target.adapterId === "rss",
      async collect({ target }) {
        const now = new Date(START);
        return {
          kind: "failed",
          outcome: "parser_failure",
          items: [],
          checkpoint: null,
          diagnosticBody: {
            contentType: "text/html",
            body: "<html>authorization: Bearer secret-value changed shape</html>",
          },
          diagnostic: {
            classification: "parser_failure",
            route: target.url,
            status: 200,
            contentType: "text/html",
            parserStage: "rss_parse",
            responseHash: "hash-parser-failure",
            adapterVersion: "fixture-1",
            startedAt: now.toISOString(),
            finishedAt: now.toISOString(),
            retries: 0,
            affectedCapabilities: ["items"],
            causeChain: ["response shape changed"],
          },
        };
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => new Date(START),
      adapters: [rss],
      ranker: noOpRanker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical guidance.\n",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    const target = host.addSourceTarget({
      adapterId: "rss",
      label: "Example Research",
      url: "https://example.com/feed.xml",
    });

    const runId = await host.backfillSourceTarget(target.id, 7);
    await host.idle();

    expect(runs.detail(runId)?.status).toBe("failed");
    // The sanitized copy is retained through the usual retention path...
    expect(host.storageUse().categories.sanitizedDiagnostics.files).toBe(1);
    // ...and the raw secret never lands in the Run's own durable artifact.
    const progress = runs.open(runId)!.readArtifact("collection-progress.json")!;
    expect(progress).not.toContain("secret-value");
    expect(progress).not.toContain("diagnosticBody");
  });

  it("retries a transient failure inside the same Run before completing", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-backfill-partial-failure-"));
    const runs = openRuns(workspaceDir);
    let calls = 0;
    const rss: SourceAdapter = {
      id: "rss",
      state: "available",
      version: "fixture-1",
      backfillWindowsDays: SOURCE_BACKFILL_WINDOWS_DAYS,
      supports: (target) => target.adapterId === "rss",
      async collect({ target }) {
        calls += 1;
        const now = new Date(START);
        if (calls === 1) {
          return {
            kind: "failed",
            outcome: "rate_limit",
            items: [],
            checkpoint: null,
            diagnostic: {
              classification: "rate_limit",
              route: "fixture:rss",
              status: 429,
              contentType: "application/rss+xml",
              parserStage: "fetch",
              responseHash: "hash-429",
              adapterVersion: "fixture-1",
              startedAt: now.toISOString(),
              finishedAt: now.toISOString(),
              retries: 0,
              affectedCapabilities: ["items"],
              causeChain: ["HTTP 429"],
            },
          };
        }
        return {
          kind: "completed",
          outcome: "items_found",
          checkpoint: "checkpoint-recovered",
          items: [backfillItem(target.id, now)],
          diagnostic: {
            classification: "items_found",
            route: "fixture:rss",
            status: 200,
            contentType: "application/rss+xml",
            parserStage: "rss",
            responseHash: "hash-200",
            adapterVersion: "fixture-1",
            startedAt: now.toISOString(),
            finishedAt: now.toISOString(),
            retries: 0,
            affectedCapabilities: [],
            causeChain: [],
          },
        };
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => new Date(START),
      sleep: async () => undefined,
      adapters: [rss],
      ranker: noOpRanker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical guidance.\n",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    const target = host.addSourceTarget({
      adapterId: "rss",
      label: "Example Research",
      url: "https://example.com/feed.xml",
    });

    const runId = await host.backfillSourceTarget(target.id, 7);
    await host.idle();

    expect(calls).toBe(2);
    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("done");
    const result = detail.result as ContentScoutRunResult;
    expect(result.adapters[0]).toMatchObject({ outcome: "items_found", retries: 1, itemsFound: 1 });
    expect(result.adapters[0].attempts.map((attempt) => attempt.outcome)).toEqual([
      "rate_limit",
      "items_found",
    ]);
  });

  it("continues after exhausting attempts once retried manually", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-backfill-retry-"));
    const runs = openRuns(workspaceDir);
    let calls = 0;
    const rss: SourceAdapter = {
      id: "rss",
      state: "available",
      version: "fixture-1",
      backfillWindowsDays: SOURCE_BACKFILL_WINDOWS_DAYS,
      supports: (target) => target.adapterId === "rss",
      async collect({ target }) {
        calls += 1;
        if (calls <= 3) {
          throw new Error("fixture adapter crashed");
        }
        const now = new Date(START);
        return {
          kind: "completed",
          outcome: "items_found",
          checkpoint: "checkpoint-after-retry",
          items: [backfillItem(target.id, now)],
          diagnostic: {
            classification: "items_found",
            route: "fixture:rss",
            status: 200,
            contentType: "application/rss+xml",
            parserStage: "rss",
            responseHash: "hash-200",
            adapterVersion: "fixture-1",
            startedAt: now.toISOString(),
            finishedAt: now.toISOString(),
            retries: 0,
            affectedCapabilities: [],
            causeChain: [],
          },
        };
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => new Date(START),
      sleep: async () => undefined,
      adapters: [rss],
      ranker: noOpRanker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical guidance.\n",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    const target = host.addSourceTarget({
      adapterId: "rss",
      label: "Example Research",
      url: "https://example.com/feed.xml",
    });

    const runId = await host.backfillSourceTarget(target.id, 90);
    await host.idle();
    expect(calls).toBe(3);
    expect(runs.detail(runId)?.status).toBe("failed");

    await host.retryRun(runId);
    await host.idle();

    expect(calls).toBe(4);
    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("done");
    const result = detail.result as ContentScoutRunResult;
    expect(result.adapters[0]).toMatchObject({ outcome: "items_found", itemsFound: 1 });
    expect(result.adapters[0].attempts).toHaveLength(4);
  });

  it("recovers a backfill Run left running across a restart from its own externalId", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-backfill-restart-"));
    const runs = openRuns(workspaceDir);
    let calls = 0;
    const rss: SourceAdapter = {
      id: "rss",
      state: "available",
      version: "fixture-1",
      backfillWindowsDays: SOURCE_BACKFILL_WINDOWS_DAYS,
      supports: (target) => target.adapterId === "rss",
      async collect({ target }) {
        calls += 1;
        return {
          kind: "failed",
          outcome: "timeout",
          items: [],
          checkpoint: null,
          diagnostic: {
            classification: "timeout",
            route: target.url,
            status: null,
            contentType: null,
            parserStage: "fetch",
            responseHash: "",
            adapterVersion: "fixture-1",
            startedAt: new Date(START).toISOString(),
            finishedAt: new Date(START).toISOString(),
            retries: 0,
            affectedCapabilities: ["items"],
            causeChain: ["timeout"],
          },
        };
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => new Date(START),
      sleep: async () => undefined,
      adapters: [rss],
      ranker: noOpRanker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical guidance.\n",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    const target = host.addSourceTarget({
      adapterId: "rss",
      label: "Recovery fixture",
      url: "https://recovery.example/feed",
    });

    const run = runs.create({
      module: "content-scout",
      moduleVersion: 1,
      intake: "source-backfill",
      sourceUrl: target.url,
      externalId: `${target.id}:7`,
    });
    const attempts = [1, 2].map((attempt) => ({
      targetId: target.id,
      adapterId: "rss",
      attempt,
      startedAt: new Date(START).toISOString(),
      finishedAt: new Date(START).toISOString(),
      outcome: "timeout" as const,
      checkpointBefore: null,
      checkpointAfter: null,
      conditionalRequest: null,
      conditionalResponse: null,
      backoffMs: 500 * 2 ** (attempt - 1),
    }));
    const priorResult = {
      kind: "failed" as const,
      outcome: "timeout" as const,
      items: [],
      checkpoint: null,
      diagnostic: {
        classification: "timeout" as const,
        route: target.url,
        status: null,
        contentType: null,
        parserStage: "fetch" as const,
        responseHash: "",
        adapterVersion: "fixture-1",
        startedAt: new Date(START).toISOString(),
        finishedAt: new Date(START).toISOString(),
        retries: 1,
        affectedCapabilities: ["items"] as const,
        causeChain: ["timeout"],
      },
    };
    run.writeArtifact("collection-attempts.json", `${JSON.stringify(attempts)}\n`);
    run.writeArtifact(
      "collection-progress.json",
      `${JSON.stringify([{ targetId: target.id, result: priorResult, attempts }])}\n`,
    );
    run.started("collect");

    host.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await host.idle();
    host.stop();

    expect(calls).toBe(1);
    const recoveredAttempts = JSON.parse(run.readArtifact("collection-attempts.json")!) as {
      attempt: number;
    }[];
    expect(recoveredAttempts.map((attempt) => attempt.attempt)).toEqual([1, 2, 3]);
    expect(runs.detail(run.id)?.status).toBe("failed");
  });

  it("exposes the backfill action at the route boundary and enforces its guardrails", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-backfill-route-"));
    const runs = openRuns(workspaceDir);
    const rss: SourceAdapter = {
      id: "rss",
      state: "available",
      version: "fixture-1",
      backfillWindowsDays: SOURCE_BACKFILL_WINDOWS_DAYS,
      supports: (target) => target.adapterId === "rss",
      async collect({ target }) {
        const now = new Date(START);
        return {
          kind: "completed",
          outcome: "items_found",
          checkpoint: "checkpoint-1",
          items: [backfillItem(target.id, now)],
          diagnostic: {
            classification: "items_found",
            route: "fixture:rss",
            status: 200,
            contentType: "application/rss+xml",
            parserStage: "rss",
            responseHash: "hash-1",
            adapterVersion: "fixture-1",
            startedAt: now.toISOString(),
            finishedAt: now.toISOString(),
            retries: 0,
            affectedCapabilities: [],
            causeChain: [],
          },
        };
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => new Date(START),
      adapters: [rss],
      ranker: noOpRanker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nPractical guidance.\n",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    const active = host.addSourceTarget({
      adapterId: "rss",
      label: "Example Research",
      url: "https://example.com/feed.xml",
    });
    const archived = host.addSourceTarget({
      adapterId: "rss",
      label: "Archived Research",
      url: "https://example.com/archived.xml",
    });
    host.setSourceTargetState(archived.id, "archived");

    const app = fastify();
    host.routes(app);

    const listed = await app.inject({ method: "GET", url: "/api/content-scout" });
    const listedAdapters = listed.json<{
      adapters: { id: string; backfillWindowsDays: number[] }[];
    }>().adapters;
    expect(listedAdapters.find((adapter) => adapter.id === "rss")?.backfillWindowsDays).toEqual([
      ...SOURCE_BACKFILL_WINDOWS_DAYS,
    ]);

    const badWindow = await app.inject({
      method: "POST",
      url: `/api/content-scout/sources/${active.id}/backfill`,
      payload: { windowDays: 14 },
    });
    expect(badWindow.statusCode).toBe(400);

    const missing = await app.inject({
      method: "POST",
      url: "/api/content-scout/sources/does-not-exist/backfill",
      payload: { windowDays: 7 },
    });
    expect(missing.statusCode).toBe(404);

    const onArchived = await app.inject({
      method: "POST",
      url: `/api/content-scout/sources/${archived.id}/backfill`,
      payload: { windowDays: 7 },
    });
    expect(onArchived.statusCode).toBe(409);

    const ok = await app.inject({
      method: "POST",
      url: `/api/content-scout/sources/${active.id}/backfill`,
      payload: { windowDays: 7 },
    });
    expect(ok.statusCode).toBe(201);
    const { runId } = ok.json<{ runId: string }>();
    await host.idle();
    await app.close();

    expect(runs.detail(runId)?.status).toBe("done");
    expect(runs.open(runId)?.read().externalId).toBe(`${active.id}:7`);
  });
});
