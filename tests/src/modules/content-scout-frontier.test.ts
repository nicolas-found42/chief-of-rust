import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import fastify from "fastify";
import type {
  AdapterDiagnostic,
  ContentScoutRunResult,
  OpportunityScores,
  SourceCapability,
  SourceDiagnosticClassification,
  SourceItem,
} from "@chief-of-staff-demo/shared";
import { ContentScoutHost } from "../../../apps/server/src/modules/content-scout/host";
import type { OpportunityRanker } from "../../../apps/server/src/modules/content-scout/ports";
import type {
  SourceAdapter,
  SourceCollectionResult,
} from "../../../apps/server/src/source-adapters/source-adapter";
import { openRuns } from "../../../apps/server/src/runs";
import { ExternalRuntimeInspector } from "../../../apps/server/src/modules/content-scout/runtime";
import { RssSourceAdapter } from "../../../apps/server/src/source-adapters/rss";

const START = Date.parse("2026-08-25T12:00:00.000Z");

const noOpRanker: OpportunityRanker = {
  async rank() {
    return [];
  },
};

function acceptProfile(host: ContentScoutHost): void {
  host.acceptBrandProfile({
    markdown: "# Brand Profile\n\n## Positioning\nPractical guidance.\n",
    sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
  });
}

function diagnostic(
  outcome: AdapterDiagnostic["classification"],
  route: string,
  now: Date,
): AdapterDiagnostic {
  return {
    classification: outcome,
    route,
    status: outcome === "rate_limit" ? 429 : outcome === "parser_failure" ? 200 : 200,
    contentType: "application/rss+xml",
    parserStage: outcome === "parser_failure" ? "rss_parse" : "fetch",
    responseHash: `${outcome}-hash`,
    adapterVersion: "frontier-fixture-1",
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    retries: 0,
    affectedCapabilities: outcome === "items_found" ? [] : ["items"],
    causeChain: outcome === "items_found" ? [] : [outcome],
  };
}

const SCORES: OpportunityScores = {
  brandRelevance: 0.9,
  audienceUsefulness: 0.8,
  timeliness: 0.9,
  novelty: 0.7,
  evidenceStrength: 0.9,
  evidenceDiversity: 0.8,
  specificity: 0.9,
  originalPerspective: 0.7,
  packApplicability: 0.8,
  speculationRisk: 0.1,
};

function sourceItem(
  id: string,
  input: Partial<SourceItem> & Pick<SourceItem, "targetId" | "adapterId" | "canonicalUrl">,
): SourceItem {
  return {
    id,
    externalId: id,
    author: "Public author",
    title: "Regulators publish the Acme interoperability rule",
    body: "The published rule gives teams a concrete interoperability deadline and implementation detail.",
    description: null,
    publishedAt: "2026-08-25T10:00:00.000Z",
    discoveredAt: "2026-08-25T12:00:00.000Z",
    media: [],
    transcript: null,
    comments: [],
    evidence: [{ route: input.canonicalUrl, retrievedAt: "2026-08-25T12:00:00.000Z" }],
    completeness: {
      title: "available",
      body: "available",
      description: "unavailable",
      transcript: "unsupported",
      comments: "unsupported",
      media: "unavailable",
    },
    ...input,
  };
}

describe("Content Scout frontier contracts", () => {
  it("bounds Source Target collection, honors host backoff, persists conditional state, and records every isolated attempt", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-frontier-collection-"));
    const runs = openRuns(workspaceDir);
    let nowMs = START;
    let active = 0;
    let maxActive = 0;
    const activeByHost = new Map<string, number>();
    let maxSameHost = 0;
    const attempts = new Map<string, number>();
    const conditionalRequests = new Map<
      string,
      { etag: string | null; lastModified: string | null } | null
    >();
    const sleeps: number[] = [];

    const adapter: SourceAdapter = {
      id: "rss",
      state: "available",
      version: "frontier-fixture-1",
      supports: (target) => target.adapterId === "rss",
      async collect(request) {
        const host = new URL(request.target.url).hostname;
        const conditionals =
          (
            request as typeof request & {
              conditional: { etag: string | null; lastModified: string | null } | null;
            }
          ).conditional ?? null;
        conditionalRequests.set(request.target.url, conditionals);
        const count = (attempts.get(request.target.url) ?? 0) + 1;
        attempts.set(request.target.url, count);
        if (request.target.url.endsWith("/throws")) {
          throw new Error("fixture adapter crashed");
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        const hostActive = (activeByHost.get(host) ?? 0) + 1;
        activeByHost.set(host, hostActive);
        maxSameHost = Math.max(maxSameHost, hostActive);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        activeByHost.set(host, hostActive - 1);

        if (request.target.url.endsWith("/retry") && count === 1) {
          const result: SourceCollectionResult = {
            kind: "failed",
            outcome: "rate_limit",
            items: [],
            checkpoint: null,
            diagnostic: {
              ...diagnostic("rate_limit", request.target.url, new Date(nowMs)),
              retryAfterMs: 3_000,
            },
          };
          return result;
        }
        if (request.target.url.endsWith("/malformed")) {
          return {
            kind: "failed",
            outcome: "parser_failure",
            items: [],
            checkpoint: null,
            diagnosticBody: {
              contentType: "text/html",
              body: "<html>authorization: Bearer secret-value changed shape</html>",
            },
            diagnostic: diagnostic("parser_failure", request.target.url, new Date(nowMs)),
          };
        }
        return {
          kind: "completed",
          outcome: "items_found",
          items: [],
          checkpoint: `checkpoint-${request.target.url}`,
          conditional: {
            etag: `etag-${request.target.url}`,
            lastModified: "Tue, 25 Aug 2026 12:00:00 GMT",
          },
          diagnostic: diagnostic("items_found", request.target.url, new Date(nowMs)),
        };
      },
    };

    const makeHost = () =>
      new ContentScoutHost({
        runs,
        workspaceDir,
        now: () => new Date(nowMs),
        sleep: async (milliseconds: number) => {
          sleeps.push(milliseconds);
          nowMs += milliseconds;
        },
        adapters: [adapter],
        ranker: noOpRanker,
        log: () => undefined,
      });

    const host = makeHost();
    acceptProfile(host);
    for (const url of [
      "https://one.example/retry",
      "https://one.example/second",
      "https://one.example/third",
      "https://two.example/fourth",
      "https://three.example/fifth",
      "https://four.example/malformed",
      "https://five.example/throws",
    ]) {
      host.addSourceTarget({ adapterId: "rss", label: url, url });
    }
    host.addSourceTarget({
      adapterId: "future-route",
      label: "Unavailable adapter fixture",
      url: "https://six.example/unavailable",
    });

    const runId = await host.scoutNow();
    await host.idle();

    expect(runs.detail(runId)?.status).toBe("blocked");
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxSameHost).toBe(1);
    expect(sleeps).toContain(3_000);
    expect(attempts.get("https://one.example/retry")).toBe(2);
    expect(runs.detail(runId)?.result).toMatchObject({
      adapters: expect.arrayContaining([
        expect.objectContaining({
          adapterId: "rss",
          targetsAttempted: 7,
          retries: 3,
          errorClassifications: ["parser_failure", "internal_failure"],
          attempts: expect.arrayContaining([
            expect.objectContaining({ attempt: 1, outcome: "rate_limit" }),
            expect.objectContaining({
              attempt: 2,
              outcome: "items_found",
              checkpointAfter: "checkpoint-https://one.example/retry",
            }),
            expect.objectContaining({ outcome: "parser_failure" }),
            expect.objectContaining({ outcome: "internal_failure", attempt: 3 }),
          ]),
        }),
        expect.objectContaining({
          adapterId: "future-route",
          state: "coming_later",
          outcome: "unsupported_capability",
        }),
      ]),
    });
    expect(runs.open(runId)?.readArtifact("collection-attempts.json")).toContain(
      '"outcome": "rate_limit"',
    );
    expect(host.storageUse().categories.sanitizedDiagnostics.files).toBe(1);
    const diagnosticDirectory = join(
      workspaceDir,
      "content-scout",
      "temporary",
      "sanitized-diagnostics",
    );
    const retainedDiagnostic = readFileSync(
      join(diagnosticDirectory, readdirSync(diagnosticDirectory)[0]),
      "utf8",
    );
    expect(retainedDiagnostic).toContain("[response body omitted; bytes:");
    expect(retainedDiagnostic).not.toMatch(/secret-value|authorization|Bearer/);

    const reconstructed = makeHost();
    const retryTarget = reconstructed
      .listSourceTargets()
      .find((target) => target.url === "https://one.example/retry");
    expect(retryTarget).toMatchObject({
      checkpoint: "checkpoint-https://one.example/retry",
      conditional: {
        etag: "etag-https://one.example/retry",
        lastModified: "Tue, 25 Aug 2026 12:00:00 GMT",
      },
    });

    await reconstructed.scoutNow();
    await reconstructed.idle();
    expect(conditionalRequests.get("https://one.example/retry")).toEqual({
      etag: "etag-https://one.example/retry",
      lastModified: "Tue, 25 Aug 2026 12:00:00 GMT",
    });
  });

  it("classifies a missing RSS Source Target permanently and does not retry it", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-frontier-rss-not-found-"));
    const runs = openRuns(workspaceDir);
    let fetches = 0;
    const adapter = new RssSourceAdapter(
      async () => {
        fetches += 1;
        return {
          url: "https://a16z.com/feed/",
          status: 404,
          contentType: "text/html",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body: "Not found",
        };
      },
      () => new Date(START),
    );
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => new Date(START),
      sleep: async () => undefined,
      adapters: [adapter],
      ranker: noOpRanker,
      log: () => undefined,
    });
    acceptProfile(host);
    host.addSourceTarget({ adapterId: "rss", label: "a16z", url: "https://a16z.com/feed/" });

    const runId = await host.scoutNow();
    await host.idle();

    expect(fetches).toBe(1);
    expect(
      runs
        .detail(runId)!
        .events.filter((event) => event.type === "source_adapter_attempted")
        .map((event) => event.detail?.outcome),
    ).toEqual(["not_found"]);
  });

  it("persists one sanitized Source Adapter summary without losing per-Source-Target attempt receipts", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-frontier-diagnostics-"));
    const runs = openRuns(workspaceDir);
    const adapter: SourceAdapter = {
      id: "rss",
      state: "available",
      version: "frontier-fixture-1",
      supports: (target) => target.adapterId === "rss",
      async collect({ target }) {
        if (target.url.endsWith("/healthy")) {
          return {
            kind: "completed",
            outcome: "no_new_material",
            items: [],
            checkpoint: "healthy-checkpoint",
            diagnostic: {
              ...diagnostic(
                "no_new_material",
                "https://collector.example/private-route-secret/feed?session=session-route-secret&topic=ai#private",
                new Date(START),
              ),
              affectedCapabilities: ["items"],
              causeChain: [],
            },
          };
        }
        return {
          kind: "failed",
          outcome: "parser_failure",
          items: [],
          checkpoint: null,
          diagnostic: {
            ...diagnostic("parser_failure", target.url, new Date(START + 1_000)),
            causeChain: [
              "authorization: Bearer cause-secret",
              "Private response included alice@example.com and an account-specific excerpt.",
            ],
            headers: { cookie: "session=undeclared-cookie-secret" },
            responseExcerpt: "undeclared private response secret",
          } as AdapterDiagnostic,
          diagnosticBody: {
            contentType: "text/html; boundary=content-type-secret",
            body: "private response body",
          },
        };
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => new Date(START),
      adapters: [adapter],
      ranker: noOpRanker,
      log: () => undefined,
    });
    acceptProfile(host);
    const healthy = host.addSourceTarget({
      adapterId: "rss",
      label: "Healthy feed",
      url: "https://healthy.example/healthy",
    });
    const degraded = host.addSourceTarget({
      adapterId: "rss",
      label: "Changed feed",
      url: "https://changed.example/malformed",
    });

    const runId = await host.scoutNow();
    await host.idle();

    const result = runs.detail(runId)?.result as ContentScoutRunResult;
    expect(result.adapters).toHaveLength(1);
    expect(result.adapters[0]).toMatchObject({
      adapterId: "rss",
      targetsAttempted: 2,
      retries: 0,
      lastSuccessfulRequest: {
        at: new Date(START).toISOString(),
      },
      errorClassifications: ["parser_failure"],
      attempts: expect.arrayContaining([
        expect.objectContaining({
          targetId: healthy.id,
          diagnostic: expect.objectContaining({
            classification: "no_new_material",
            status: 200,
            contentType: "application/rss+xml",
            parserStage: "fetch",
            responseHash: expect.any(String),
            adapterVersion: "frontier-fixture-1",
            startedAt: new Date(START).toISOString(),
            finishedAt: new Date(START).toISOString(),
            causeChain: [],
          }),
        }),
        expect.objectContaining({
          targetId: degraded.id,
          diagnostic: expect.objectContaining({
            classification: "parser_failure",
            causeChain: [
              expect.stringMatching(/^credential_material_redacted \(cause 1, sha256:/),
              expect.stringMatching(/^private_response_redacted \(cause 2, sha256:/),
            ],
          }),
        }),
      ]),
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private-route-secret|session-route-secret|cause-secret|alice@example\.com|account-specific|#private|undeclared-cookie-secret|undeclared private response secret/,
    );
    expect(result.adapters[0]?.lastSuccessfulRequest?.route).toMatch(
      /^https:\/\/collector\.example\/.+\/feed\?redacted=&topic=$/,
    );
    expect(result.adapters[0]?.attempts[1]?.diagnostic).not.toHaveProperty("headers");
    expect(result.adapters[0]?.attempts[1]?.diagnostic).not.toHaveProperty("responseExcerpt");
    const retainedRecord = JSON.parse(
      readFileSync(
        join(
          workspaceDir,
          "content-scout",
          "temporary",
          "sanitized-diagnostics",
          readdirSync(join(workspaceDir, "content-scout", "temporary", "sanitized-diagnostics"))[0],
        ),
        "utf8",
      ),
    ) as { contentType: string; body: string };
    expect(retainedRecord.contentType).toBe("text/html");
    expect(JSON.stringify(retainedRecord)).not.toContain("content-type-secret");
  });

  it("keeps degraded Source Adapter health across restart and other Source Targets until verified recovery", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-frontier-health-"));
    let experimentalHealthy = false;
    let recoveredAffectedCapabilities: SourceCapability[] = ["comments"];
    const available: SourceAdapter = {
      id: "rss",
      state: "available",
      version: "frontier-fixture-1",
      supports: (target) => target.adapterId === "rss",
      async collect({ target }) {
        return {
          kind: "completed",
          outcome: "no_new_material",
          items: [],
          checkpoint: "rss-checkpoint",
          diagnostic: {
            ...diagnostic("no_new_material", target.url, new Date(START)),
            affectedCapabilities: ["items"],
            causeChain: [],
          },
        };
      },
    };
    const experimental: SourceAdapter = {
      id: "instagram",
      state: "experimental",
      version: "frontier-fixture-1",
      supports: (target) => target.adapterId === "instagram",
      async collect({ target }) {
        if (experimentalHealthy || target.url.endsWith("/healthy")) {
          return {
            kind: "completed",
            outcome: "no_new_material",
            items: [],
            checkpoint: "instagram-checkpoint",
            diagnostic: {
              ...diagnostic("no_new_material", target.url, new Date(START + 2_000)),
              affectedCapabilities: target.url.endsWith("/healthy")
                ? []
                : recoveredAffectedCapabilities,
              causeChain: [],
            },
          };
        }
        return {
          kind: "failed",
          outcome: "response_shape_change",
          items: [],
          checkpoint: null,
          diagnostic: {
            ...diagnostic("response_shape_change", target.url, new Date(START)),
            affectedCapabilities: ["items", "comments"],
          },
        };
      },
    };
    const makeHost = () =>
      new ContentScoutHost({
        runs: openRuns(workspaceDir),
        workspaceDir,
        now: () => new Date(START),
        adapters: [available, experimental],
        ranker: noOpRanker,
        log: () => undefined,
      });
    const readHealth = async (host: ContentScoutHost) => {
      const app = fastify();
      host.routes(app);
      const response = await app.inject({ method: "GET", url: "/api/content-scout" });
      await app.close();
      expect(response.statusCode).toBe(200);
      return response.json().health as {
        runId: string | null;
        warnings: {
          adapterId: string;
          outcome: SourceDiagnosticClassification;
          affectedCapabilities: SourceCapability[];
        }[];
      };
    };

    const firstHost = makeHost();
    acceptProfile(firstHost);
    firstHost.addSourceTarget({
      adapterId: "rss",
      label: "Available feed",
      url: "https://available.example/feed",
    });
    const experimentalTarget = firstHost.addSourceTarget({
      adapterId: "instagram",
      label: "Experimental public account",
      url: "https://instagram.example/public-account",
    });
    firstHost.addSourceTarget({
      adapterId: "instagram",
      label: "Healthy Experimental public account",
      url: "https://instagram.example/healthy",
    });
    const degradedRunId = await firstHost.scoutNow();
    await firstHost.idle();

    const reconstructed = makeHost();
    expect(await readHealth(reconstructed)).toMatchObject({
      runId: degradedRunId,
      warnings: [
        {
          adapterId: "instagram",
          outcome: "response_shape_change",
          affectedCapabilities: ["items", "comments"],
        },
      ],
    });

    reconstructed.setSourceTargetState(experimentalTarget.id, "archived");
    await reconstructed.scoutNow();
    await reconstructed.idle();
    expect(await readHealth(reconstructed)).toMatchObject({
      runId: degradedRunId,
      warnings: [expect.objectContaining({ adapterId: "instagram" })],
    });

    reconstructed.setSourceTargetState(experimentalTarget.id, "active");
    experimentalHealthy = true;
    await reconstructed.scoutNow();
    await reconstructed.idle();
    expect(await readHealth(reconstructed)).toMatchObject({
      runId: degradedRunId,
      warnings: [
        expect.objectContaining({ adapterId: "instagram", affectedCapabilities: ["comments"] }),
      ],
    });

    recoveredAffectedCapabilities = [];
    await reconstructed.scoutNow();
    await reconstructed.idle();
    expect(await readHealth(reconstructed)).toMatchObject({ runId: null, warnings: [] });
  });

  it("uses the latest Source Target observation when an older Run is retried", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-frontier-late-retry-"));
    const runs = openRuns(workspaceDir);
    let nowMs = START;
    let adapterHealthy = false;
    const adapter: SourceAdapter = {
      id: "rss",
      state: "available",
      version: "frontier-fixture-1",
      supports: (target) => target.adapterId === "rss",
      async collect({ target }) {
        return adapterHealthy
          ? {
              kind: "completed",
              outcome: "no_new_material",
              items: [],
              checkpoint: "recovered",
              diagnostic: {
                ...diagnostic("no_new_material", target.url, new Date(nowMs)),
                affectedCapabilities: [],
                causeChain: [],
              },
            }
          : {
              kind: "failed",
              outcome: "parser_failure",
              items: [],
              checkpoint: null,
              diagnostic: diagnostic("parser_failure", target.url, new Date(START + 86_400_000)),
            };
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => new Date(nowMs),
      adapters: [adapter],
      ranker: noOpRanker,
      log: () => undefined,
    });
    acceptProfile(host);
    host.addSourceTarget({
      adapterId: "rss",
      label: "Late retry feed",
      url: "https://late-retry.example/feed",
    });

    const olderRunId = await host.scoutNow();
    await host.idle();
    nowMs += 1_000;
    await host.scoutNow();
    await host.idle();
    nowMs += 1_000;
    adapterHealthy = true;
    await host.retryRun(olderRunId);
    await host.idle();

    const app = fastify();
    host.routes(app);
    const response = await app.inject({ method: "GET", url: "/api/content-scout" });
    await app.close();
    expect(response.json().health).toMatchObject({
      runId: null,
      warnings: [],
      runtimeWarnings: [],
    });
  });

  it("retains diagnostics, last success, and degraded health when no Available Source Adapter completes", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-frontier-failed-health-"));
    const runs = openRuns(workspaceDir);
    let adapterHealthy = true;
    const adapter: SourceAdapter = {
      id: "rss",
      state: "available",
      version: "frontier-fixture-1",
      supports: (target) => target.adapterId === "rss",
      async collect({ target }) {
        if (adapterHealthy) {
          return {
            kind: "completed",
            outcome: "no_new_material",
            items: [],
            checkpoint: "working-checkpoint",
            diagnostic: {
              ...diagnostic("no_new_material", target.url, new Date(START)),
              affectedCapabilities: ["items"],
              causeChain: [],
            },
          };
        }
        return {
          kind: "failed",
          outcome: "parser_failure",
          items: [],
          checkpoint: null,
          diagnostic: diagnostic("parser_failure", target.url, new Date(START)),
        };
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => new Date(START),
      adapters: [adapter],
      ranker: noOpRanker,
      log: () => undefined,
    });
    acceptProfile(host);
    host.addSourceTarget({
      adapterId: "rss",
      label: "Broken feed",
      url: "https://broken.example/feed",
    });

    const successfulRunId = await host.scoutNow();
    await host.idle();
    expect(runs.detail(successfulRunId)?.result).toMatchObject({
      adapters: [expect.objectContaining({ affectedCapabilities: ["items"] })],
    });
    adapterHealthy = false;
    const runId = await host.scoutNow();
    await host.idle();

    expect(runs.detail(runId)).toMatchObject({
      status: "failed",
      result: {
        adapters: [
          expect.objectContaining({
            adapterId: "rss",
            targetsAttempted: 1,
            errorClassifications: ["parser_failure"],
            lastSuccessfulRequest: expect.objectContaining({
              at: new Date(START).toISOString(),
            }),
          }),
        ],
        warnings: 1,
      },
    });
    const app = fastify();
    host.routes(app);
    const response = await app.inject({ method: "GET", url: "/api/content-scout" });
    await app.close();
    expect(response.json().health).toMatchObject({
      runId,
      warnings: [expect.objectContaining({ adapterId: "rss", outcome: "parser_failure" })],
    });
  });

  it("excludes deterministic ineligible evidence and gives one cross-adapter story a stable identity", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-frontier-identity-"));
    const runs = openRuns(workspaceDir);
    let archivedTargetId = "";
    let rankedItemIds: string[] = [];
    let rankedStoryGroups: { canonicalKey: string; sourceItemIds: string[] }[] = [];

    const available: SourceAdapter = {
      id: "rss",
      state: "available",
      version: "fixture-1",
      supports: (target) => target.adapterId === "rss",
      async collect({ target }) {
        const items = [
          sourceItem("eligible-rss", {
            targetId: target.id,
            adapterId: "rss",
            canonicalUrl: "https://wire.example/acme-rule",
            title: "37,000 people watched Infinite Slop so I registered InfiniteSlop.ai",
          }),
          sourceItem("stale", {
            targetId: target.id,
            adapterId: "rss",
            canonicalUrl: "https://wire.example/stale",
            publishedAt: "2026-08-10T10:00:00.000Z",
          }),
          sourceItem("archived", {
            targetId: archivedTargetId,
            adapterId: "rss",
            canonicalUrl: "https://wire.example/archived",
          }),
          sourceItem("prohibited", {
            targetId: target.id,
            adapterId: "rss",
            canonicalUrl: "https://wire.example/gambling",
            title: "A gambling promotion",
            body: "This gambling promotion is detailed enough to otherwise pass evidence checks.",
          }),
          sourceItem("inaccessible", {
            targetId: target.id,
            adapterId: "rss",
            canonicalUrl: "https://wire.example/inaccessible",
            title: null,
            body: null,
            evidence: [],
            completeness: {
              title: "failed",
              body: "failed",
              description: "failed",
              transcript: "unsupported",
              comments: "unsupported",
              media: "unavailable",
            },
          }),
          sourceItem("unsupported-claim", {
            targetId: target.id,
            adapterId: "rss",
            canonicalUrl: "https://wire.example/unsupported",
            body: "This rule guarantees every implementation will be profitable.",
          }),
        ];
        return {
          kind: "completed" as const,
          outcome: "items_found" as const,
          items,
          checkpoint: "rss-checkpoint",
          diagnostic: diagnostic("items_found", target.url, new Date(START)),
        };
      },
    };
    const experimental: SourceAdapter = {
      id: "instagram",
      state: "experimental",
      version: "fixture-1",
      supports: (target) => target.adapterId === "instagram",
      async collect({ target }) {
        return {
          kind: "completed",
          outcome: "items_found",
          items: [
            sourceItem("eligible-instagram", {
              targetId: target.id,
              adapterId: "instagram",
              canonicalUrl: "https://instagram.example/p/acme-rule",
              title: "I built Infinite Slop, an infinite interactive AI generated live stream",
            }),
            sourceItem("exact-url-duplicate", {
              targetId: target.id,
              adapterId: "instagram",
              canonicalUrl: "https://wire.example/acme-rule",
              title: "Acme interoperability deadline explained",
            }),
          ],
          checkpoint: "instagram-checkpoint",
          diagnostic: diagnostic("items_found", target.url, new Date(START)),
        };
      },
    };
    const enforcingRanker: OpportunityRanker = {
      async rank(input) {
        rankedItemIds = input.items.map((item) => item.id).sort();
        rankedStoryGroups = (
          input as typeof input & {
            storyGroups: { canonicalKey: string; sourceItemIds: string[] }[];
          }
        ).storyGroups;
        return [
          {
            id: "model-card-a",
            canonicalKey: "model-chosen-key-a",
            title: "What the Acme rule changes",
            angle: "practical_implication",
            angleDescription: "Explain what the Acme rule changes in practice.",
            materialDevelopment: null,
            urgency: "The deadline is new.",
            explanation: "Concrete implementation guidance.",
            sourceItemIds: ["eligible-rss"],
            sourceUrls: ["https://wire.example/acme-rule"],
            experimentalEvidence: false,
            confidence: 0.9,
            scores: SCORES,
          },
          {
            id: "model-card-b",
            canonicalKey: "model-chosen-key-b",
            title: "Another copy of the Acme rule",
            angle: "practical_implication",
            angleDescription: "Explain what the Acme rule changes in practice.",
            materialDevelopment: null,
            urgency: "Also new.",
            explanation: "Same story from another source.",
            sourceItemIds: ["eligible-instagram"],
            sourceUrls: ["https://instagram.example/p/acme-rule"],
            experimentalEvidence: false,
            confidence: 0.8,
            scores: SCORES,
          },
          {
            id: "model-card-c",
            canonicalKey: "model-chosen-key-c",
            title: "A forecast based on the Acme rule",
            angle: "forecast",
            angleDescription: "Forecast how the Acme rule changes implementation plans.",
            materialDevelopment: null,
            urgency: "A distinct forward-looking angle.",
            explanation: "The materially different angle is recorded.",
            sourceItemIds: ["eligible-rss", "eligible-instagram"],
            sourceUrls: ["https://wire.example/acme-rule", "https://instagram.example/p/acme-rule"],
            experimentalEvidence: false,
            confidence: 0.75,
            scores: SCORES,
          },
        ];
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => new Date(START),
      adapters: [available, experimental],
      ranker: enforcingRanker,
      log: () => undefined,
    });
    host.acceptBrandProfile({
      markdown:
        "# Brand Profile\n\n## Positioning\nPractical guidance.\n\n## Avoided subjects\n- gambling\n",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    const archived = host.addSourceTarget({
      adapterId: "rss",
      label: "Archived",
      url: "https://archived.example/feed",
    });
    archivedTargetId = archived.id;
    host.setSourceTargetState(archived.id, "archived");
    host.addSourceTarget({ adapterId: "rss", label: "Wire", url: "https://wire.example/feed" });
    host.addSourceTarget({
      adapterId: "instagram",
      label: "Public account",
      url: "https://instagram.example/public-account",
    });

    const firstRunId = await host.scoutNow();
    await host.idle();

    expect(rankedItemIds).toEqual(["eligible-instagram", "eligible-rss"]);
    expect(rankedStoryGroups).toEqual([
      expect.objectContaining({
        sourceItemIds: ["eligible-rss", "eligible-instagram"],
      }),
    ]);
    const first = host.activeShortlist()!;
    expect(first.runId).toBe(firstRunId);
    expect(first.opportunities).toHaveLength(2);
    expect(first.opportunities.map((item) => item.angle).sort()).toEqual([
      "forecast",
      "practical_implication",
    ]);
    expect(first.opportunities[0]).toMatchObject({
      sourceItemIds: ["eligible-rss", "eligible-instagram"],
      sourceUrls: ["https://wire.example/acme-rule", "https://instagram.example/p/acme-rule"],
      experimentalEvidence: true,
      scores: SCORES,
    });
    expect(runs.open(firstRunId)?.readArtifact("eligibility.json")).toContain('"reason": "stale"');

    const identityByAngle = new Map(
      first.opportunities.map((opportunity) => [opportunity.angle, opportunity.id]),
    );
    await host.scoutNow();
    await host.idle();
    expect(
      new Map(
        host
          .activeShortlist()!
          .opportunities.map((opportunity) => [opportunity.angle, opportunity.id]),
      ),
    ).toEqual(identityByAngle);

    const instagramTarget = host
      .listSourceTargets()
      .find((target) => target.adapterId === "instagram")!;
    host.setSourceTargetState(instagramTarget.id, "archived");
    await host.scoutNow();
    await host.idle();
    expect(
      new Map(
        host
          .activeShortlist()!
          .opportunities.map((opportunity) => [opportunity.angle, opportunity.id]),
      ),
    ).toEqual(identityByAngle);
  });

  it("continues recovered collection inside the original retry budget", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-frontier-recovery-"));
    const runs = openRuns(workspaceDir);
    let calls = 0;
    const adapter: SourceAdapter = {
      id: "rss",
      state: "available",
      version: "fixture-1",
      supports: (target) => target.adapterId === "rss",
      async collect({ target }) {
        calls += 1;
        return {
          kind: "failed",
          outcome: "timeout",
          items: [],
          checkpoint: null,
          diagnostic: diagnostic("timeout", target.url, new Date(START)),
        };
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => new Date(START),
      sleep: async () => undefined,
      adapters: [adapter],
      ranker: noOpRanker,
      log: () => undefined,
    });
    acceptProfile(host);
    const target = host.addSourceTarget({
      adapterId: "rss",
      label: "Recovery fixture",
      url: "https://recovery.example/feed",
    });
    const run = runs.create({
      module: "content-scout",
      moduleVersion: 1,
      intake: "daily-intake",
      sourceUrl: null,
      externalId: null,
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
    const priorResult: SourceCollectionResult = {
      kind: "failed",
      outcome: "timeout",
      items: [],
      checkpoint: null,
      diagnostic: diagnostic("timeout", target.url, new Date(START)),
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

    await host.retryRun(run.id);
    await host.idle();
    expect(calls).toBe(4);
    const manuallyRetriedAttempts = JSON.parse(run.readArtifact("collection-attempts.json")!) as {
      attempt: number;
    }[];
    expect(manuallyRetriedAttempts.map((attempt) => attempt.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(runs.detail(run.id)?.result).toMatchObject({
      adapters: [
        expect.objectContaining({
          retries: 5,
          attempts: [
            expect.objectContaining({ attempt: 1 }),
            expect.objectContaining({ attempt: 2 }),
            expect.objectContaining({ attempt: 3 }),
            expect.objectContaining({ attempt: 4 }),
            expect.objectContaining({ attempt: 5 }),
            expect.objectContaining({ attempt: 6 }),
          ],
        }),
      ],
    });
  });

  it("accounts for storage and cleans only expired temporary data across restart", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-frontier-retention-"));
    const runs = openRuns(workspaceDir);
    let nowMs = Date.parse("2026-07-01T12:00:00.000Z");
    const makeHost = () =>
      new ContentScoutHost({
        runs,
        workspaceDir,
        now: () => new Date(nowMs),
        adapters: [],
        ranker: noOpRanker,
        log: () => undefined,
      });
    const host = makeHost();
    const profile = host.acceptBrandProfile({
      markdown: "# Brand Profile\n\n## Positioning\nDurable profile history.\n",
      sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    });
    const source = host.addSourceTarget({
      adapterId: "rss",
      label: "Durable source history",
      url: "https://example.com/feed",
    });
    host.recordSanitizedDiagnostic({
      id: "old-body",
      contentType: "text/html",
      body: "<html>old sanitized response</html>",
    });
    host.recordTemporaryMedia({ id: "old-failed-media", outcome: "failed", bytes: "old media" });
    expect(
      host.recordTemporaryMedia({
        id: "processed-media",
        outcome: "processed",
        bytes: "must be removed immediately",
      }),
    ).toEqual({ retained: false });
    host.retainEvidenceTranscript({
      id: "brief-transcript",
      text: "Durable derived transcript used by an immutable Opportunity Charter.",
    });

    nowMs = Date.parse("2026-07-31T12:00:01.000Z");
    host.recordSanitizedDiagnostic({
      id: "recent-body",
      contentType: "application/json",
      body: '{"safe":"recent"}',
    });
    host.recordTemporaryMedia({
      id: "recent-failed-media",
      outcome: "failed",
      bytes: "recent failed media",
    });
    host.setSourceTargetState(source.id, "archived");

    const run = runs.create({
      module: "content-scout",
      moduleVersion: 1,
      intake: "daily-intake",
      sourceUrl: null,
      externalId: null,
    });
    run.writeArtifact("adapter-diagnostics.json", '{"immutable":true}\n');
    run.finished({ status: "done", summary: "Immutable Run evidence" });
    const runEvidence = run.readArtifact("adapter-diagnostics.json");

    const before = host.storageUse();
    expect(before.categories).toMatchObject({
      durableRecords: { files: expect.any(Number), bytes: expect.any(Number) },
      sanitizedDiagnostics: { files: 2, bytes: expect.any(Number) },
      temporaryMedia: { files: 2, bytes: expect.any(Number) },
      retainedEvidenceTranscripts: { files: 1, bytes: expect.any(Number) },
    });
    const preview = host.previewTemporaryCleanup();
    expect(preview).toMatchObject({
      scope: "expired_temporary_data",
      items: expect.arrayContaining([
        expect.objectContaining({ category: "sanitized_diagnostics", id: "old-body" }),
        expect.objectContaining({ category: "temporary_media", id: "old-failed-media" }),
      ]),
    });
    expect(preview.items.map((item) => item.id)).not.toEqual(
      expect.arrayContaining(["recent-body", "recent-failed-media", "brief-transcript"]),
    );

    const reconstructed = makeHost();
    expect(reconstructed.storageUse().categories).toMatchObject({
      sanitizedDiagnostics: { files: 1 },
      temporaryMedia: { files: 1 },
      retainedEvidenceTranscripts: { files: 1 },
    });
    expect(reconstructed.currentBrandProfile()?.id).toBe(profile.id);
    expect(reconstructed.listSourceTargets()).toEqual([
      expect.objectContaining({ id: source.id, state: "archived" }),
    ]);
    expect(runs.open(run.id)?.readArtifact("adapter-diagnostics.json")).toBe(runEvidence);
    expect(() =>
      reconstructed.recordTemporaryMedia({
        id: "../outside-workspace",
        outcome: "failed",
        bytes: "unsafe",
      }),
    ).toThrow(/safe identifier/i);
  });

  it("reports pinned external runtime capabilities and explicit missing-tool diagnostics through Health", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-frontier-runtime-"));
    const runs = openRuns(workspaceDir);
    const commands: string[] = [];
    const commandResults = new Map([
      ["chromium --version", "Chromium 140.0.7339.80"],
      ["python3 --version", "Python 3.11.2"],
      ["ffmpeg -version", "ffmpeg version 5.1.7"],
      ["yt-dlp --version", "2026.08.20"],
      ["whisper-cli --help", "whisper.cpp v1.7.6"],
    ]);
    const runtimeInspector = {
      async inspect() {
        const definitions = [
          ["browser.chromium", "browser", "chromium", ["--version"]],
          ["python.interpreter", "python", "python3", ["--version"]],
          ["media.ffmpeg", "media", "ffmpeg", ["-version"]],
          ["media.yt-dlp", "media", "yt-dlp", ["--version"]],
          ["transcription.whisper-cpp", "transcription", "whisper-cli", ["--help"]],
          ["python.pyktok", "python", "pyktok", ["--version"]],
        ] as const;
        return await Promise.all(
          definitions.map(async ([id, category, command, args]) => {
            const invocation = `${command} ${args.join(" ")}`;
            commands.push(invocation);
            const output = commandResults.get(invocation);
            return {
              id,
              category,
              state: output ? ("available" as const) : ("unavailable" as const),
              version: output ?? null,
              requiredBy: id === "python.pyktok" ? ["TikTok Experimental enrichment"] : [],
              diagnostic: {
                classification: output
                  ? ("runtime_available" as const)
                  : ("runtime_unavailable" as const),
                command: invocation,
                checkedAt: new Date(START).toISOString(),
                causeChain: output ? [] : ["Executable was not found in the production runtime."],
              },
            };
          }),
        );
      },
    };
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      now: () => new Date(START),
      adapters: [],
      ranker: noOpRanker,
      runtimeInspector,
      log: () => undefined,
    });
    const app = fastify();
    host.routes(app);
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/api/content-scout" });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.runtimeCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "browser.chromium",
          state: "available",
          version: "Chromium 140.0.7339.80",
        }),
        expect.objectContaining({
          id: "python.pyktok",
          state: "unavailable",
          diagnostic: expect.objectContaining({
            classification: "runtime_unavailable",
            causeChain: ["Executable was not found in the production runtime."],
          }),
        }),
      ]),
    );
    expect(body.health.runtimeWarnings).toEqual(["python.pyktok"]);
    expect(commands).toEqual([
      "chromium --version",
      "python3 --version",
      "ffmpeg -version",
      "yt-dlp --version",
      "whisper-cli --help",
      "pyktok --version",
    ]);
  });

  it("smoke-checks each production command boundary once without a live source call", async () => {
    const calls: string[] = [];
    const outputByCommand = new Map([
      ["chromium --version", "Chromium 153.0.8010.12"],
      ["python3 --version", "Python 3.12.3"],
      [
        "python3 -c import importlib.metadata; print(importlib.metadata.version('youtube-transcript-api'))",
        "1.2.2",
      ],
      ["ffmpeg -version", "ffmpeg version 6.1.1-3ubuntu5"],
      ["yt-dlp --version", "2025.08.22"],
      ["/bin/cat /usr/local/share/content-scout/whisper-cpp-version", "v1.7.6"],
    ]);
    const inspector = new ExternalRuntimeInspector(
      () => new Date(START),
      async (command, args) => {
        const invocation = [command, ...args].join(" ");
        calls.push(invocation);
        if (command === "instaloader") throw new Error("spawn instaloader ENOENT");
        return { stdout: `${outputByCommand.get(invocation) ?? "unexpected"}\n`, stderr: "" };
      },
    );

    const first = await inspector.inspect();
    const second = await inspector.inspect();

    expect(second).toEqual(first);
    expect(first).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "python.instaloader",
          state: "unavailable",
          diagnostic: expect.objectContaining({ classification: "runtime_unavailable" }),
        }),
        expect.objectContaining({ id: "browser.chromium", state: "available" }),
        expect.objectContaining({ id: "transcription.whisper-cpp", state: "available" }),
        expect.objectContaining({
          id: "python.pyktok",
          state: "unsupported",
          diagnostic: expect.objectContaining({ classification: "runtime_unsupported" }),
        }),
      ]),
    );
    expect(calls).toEqual([
      "chromium --version",
      "python3 --version",
      "python3 -c import importlib.metadata; print(importlib.metadata.version('youtube-transcript-api'))",
      "instaloader --version",
      "ffmpeg -version",
      "yt-dlp --version",
      "/bin/cat /usr/local/share/content-scout/whisper-cpp-version",
    ]);
  });
});
