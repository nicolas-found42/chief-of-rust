import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import fastify from "fastify";
import { ContentScoutHost } from "../../../apps/server/src/modules/content-scout/host";
import {
  ContentScoutCanaryStore,
  ContentScoutCanaryRunner,
} from "../../../apps/server/src/modules/content-scout/canary";
import { openRuns } from "../../../apps/server/src/runs";
import type {
  SourceAdapter,
  SourceCollectionResult,
} from "../../../apps/server/src/source-adapters/source-adapter";
import type { AdapterDiagnostic } from "@chief-of-staff-demo/shared";
import { CANARY_INTERVAL_MS, CANARY_MIN_TARGETS } from "@chief-of-staff-demo/shared";
import {
  evaluateLinkedInEvidenceGate,
  LinkedInComingLaterAdapter,
  type LinkedInCanaryEvidence,
} from "../../../apps/server/src/modules/content-scout/adapters/linkedin";
const START = new Date("2026-08-27T12:00:00.000Z");

function diagnostic(
  outcome: AdapterDiagnostic["classification"],
  route: string,
  now: Date,
): AdapterDiagnostic {
  return {
    classification: outcome,
    route,
    status: outcome === "blocked_access" ? 403 : outcome === "rate_limit" ? 429 : 200,
    contentType: "text/html",
    parserStage: "fetch",
    responseHash: `${outcome}-hash`,
    adapterVersion: "v-test",
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    retries: 0,
    affectedCapabilities: ["items"],
    causeChain: outcome === "items_found" ? [] : [outcome],
  };
}

function canaryAdapter(
  id: string,
  version: string,
  behavior: (target: { url: string }) => Promise<SourceCollectionResult>,
): SourceAdapter {
  return {
    id,
    state: id === "linkedin" ? "coming_later" : id === "reddit" ? "experimental" : "available",
    version,
    canaryTargets: [
      { adapterId: id, label: `${id} one`, url: `https://canary.example/${id}/one` },
      { adapterId: id, label: `${id} two`, url: `https://canary.example/${id}/two` },
      { adapterId: id, label: `${id} three`, url: `https://canary.example/${id}/three` },
    ],
    supports: (target) => target.adapterId === id,
    collect: async (request) => behavior({ url: request.target.url }),
  };
}

function successCollect(now: Date): Promise<SourceCollectionResult> {
  return Promise.resolve({
    kind: "completed",
    outcome: "items_found",
    items: [
      {
        id: "canary:item:1",
        externalId: "1",
        targetId: "canary:test:one",
        adapterId: "test",
        canonicalUrl: "https://canary.example/test/one",
        author: "Public",
        title: "Canary item",
        body: "Evidence",
        description: null,
        publishedAt: now.toISOString(),
        discoveredAt: now.toISOString(),
        media: [],
        transcript: null,
        comments: [],
        evidence: [{ route: "https://canary.example/test/one", retrievedAt: now.toISOString() }],
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
    checkpoint: null,
    diagnostic: diagnostic("items_found", "https://canary.example/test/one", now),
  });
}

function emptyCollect(now: Date): Promise<SourceCollectionResult> {
  return Promise.resolve({
    kind: "completed",
    outcome: "legitimate_empty",
    items: [],
    checkpoint: null,
    diagnostic: diagnostic("legitimate_empty", "https://canary.example/test/one", now),
  });
}

function failedCollect(
  outcome: AdapterDiagnostic["classification"],
  now: Date,
): Promise<SourceCollectionResult> {
  return Promise.resolve({
    kind: "failed",
    outcome: outcome as Exclude<
      AdapterDiagnostic["classification"],
      "items_found" | "legitimate_empty" | "no_new_material"
    >,
    items: [],
    checkpoint: null,
    diagnostic: diagnostic(outcome, "https://canary.example/test/one", now),
  });
}

describe("Content Scout external canaries and release receipts", () => {
  it("defines at least three canary targets per adapter", async () => {
    const adapters: SourceAdapter[] = [
      canaryAdapter("rss", "v1", async () => successCollect(START)),
      canaryAdapter("website", "v1", async () => successCollect(START)),
      canaryAdapter("youtube", "v1", async () => successCollect(START)),
      canaryAdapter("reddit", "v1", async () => successCollect(START)),
      canaryAdapter("instagram", "v1", async () => successCollect(START)),
      canaryAdapter("tiktok", "v1", async () => successCollect(START)),
      canaryAdapter("linkedin", "v1", async () => successCollect(START)),
    ];
    for (const adapter of adapters) {
      expect(
        adapter.canaryTargets,
        `adapter ${adapter.id} should have canary targets`,
      ).toBeDefined();
      expect(adapter.canaryTargets!.length).toBeGreaterThanOrEqual(CANARY_MIN_TARGETS);
    }
  });

  it("runs canaries on schedule outside merge CI and uses the normal diagnostic contract", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-canary-sched-"));
    const runs = openRuns(workspaceDir);
    let calls = 0;
    const now = new Date(START.getTime());
    const adapter = canaryAdapter("rss", "rss-parser@3", async () => {
      calls += 1;
      return successCollect(now);
    });
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      adapters: [adapter],
      ranker: {
        async rank() {
          return [];
        },
      },
      now: () => new Date(now.getTime()),
      log: () => undefined,
    });

    // The schedule alone never starts a workspace off (issue #104): the first batch
    // is explicit, and it is what puts this workspace on the cadence.
    await host.checkCanarySchedule();
    expect(calls).toBe(0);
    await host.runCanaries();
    expect(calls).toBe(3); // 3 targets
    expect(host.canaryReceipts()).toHaveLength(3);
    const firstReceipt = host.canaryReceipts()[0];
    expect(firstReceipt.diagnostic.route).toBeTruthy();
    expect(firstReceipt.diagnostic.adapterVersion).toBe("rss-parser@3");
    expect(firstReceipt.outcome).toBe("items_found");

    // Within interval, schedule is not due.
    now.setTime(now.getTime() + CANARY_INTERVAL_MS - 1000);
    await host.checkCanarySchedule();
    expect(calls).toBe(3);
    expect(host.canaryReceipts()).toHaveLength(3);

    // After interval, it runs again.
    now.setTime(now.getTime() + 2000);
    await host.checkCanarySchedule();
    expect(calls).toBe(6);
    expect(host.canaryReceipts()).toHaveLength(6);
  });

  it("persists results by adapter version, target, capability, route, and time", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-canary-persist-"));
    const runs = openRuns(workspaceDir);
    const now = new Date(START.getTime());
    const adapter = canaryAdapter("website", "readability@0.6-browser-render@1", async (target) => {
      const route = `https://canary.example/website/${target.url.split("/").pop()}`;
      return {
        kind: "completed",
        outcome: "items_found",
        items: [
          {
            id: `item-${target.url}`,
            externalId: "1",
            targetId: "canary:website",
            adapterId: "website",
            canonicalUrl: target.url,
            author: "Pub",
            title: "t",
            body: "b",
            description: null,
            publishedAt: now.toISOString(),
            discoveredAt: now.toISOString(),
            media: [],
            transcript: null,
            comments: [],
            evidence: [{ route, retrievedAt: now.toISOString() }],
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
        checkpoint: null,
        diagnostic: diagnostic("items_found", route, now),
      };
    });
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      adapters: [adapter],
      ranker: {
        async rank() {
          return [];
        },
      },
      now: () => new Date(now.getTime()),
      log: () => undefined,
    });

    await host.runCanaries();
    const receipts = host.canaryReceipts();
    expect(receipts).toHaveLength(3);
    for (const receipt of receipts) {
      expect(receipt.adapterId).toBe("website");
      expect(receipt.adapterVersion).toBe("readability@0.6-browser-render@1");
      expect(receipt.target.url).toMatch(/https:\/\/canary\.example\/website\/(one|two|three)/);
      expect(receipt.capability).toBe("items");
      expect(receipt.route).toBeTruthy();
      expect(receipt.checkedAt).toBe(now.toISOString());
      expect(receipt.diagnostic).toBeDefined();
      expect(receipt.diagnostic.adapterVersion).toBe("readability@0.6-browser-render@1");
    }

    // Persisted file survives a new host instance (workspace is the source of truth).
    const persistedPath = join(workspaceDir, "content-scout", "canary-state.json");
    expect(existsSync(persistedPath)).toBe(true);
    const raw = readFileSync(persistedPath, "utf8");
    const parsed = JSON.parse(raw) as { receipts: unknown[]; lastRunAt: string };
    expect(parsed.receipts).toHaveLength(3);
    expect(parsed.lastRunAt).toBe(now.toISOString());

    // Second host sees the same persisted receipts (isolated persistence, reused diagnostics).
    const host2 = new ContentScoutHost({
      runs,
      workspaceDir,
      adapters: [adapter],
      ranker: {
        async rank() {
          return [];
        },
      },
      now: () => new Date(now.getTime()),
      log: () => undefined,
    });
    expect(host2.canaryReceipts()).toHaveLength(3);
    expect(host2.canaryReceipts()[0].target.url).toBe(receipts[0].target.url);
  });

  it("resets promotion and degraded state when the adapter version changes", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-canary-version-"));
    const runs = openRuns(workspaceDir);
    const now = new Date(START.getTime());
    const makeHost = (version: string) => {
      const adapter: SourceAdapter = {
        id: "rss",
        state: "available",
        version,
        canaryTargets: [
          { adapterId: "rss", label: "one", url: "https://canary.example/rss/one" },
          { adapterId: "rss", label: "two", url: "https://canary.example/rss/two" },
          { adapterId: "rss", label: "three", url: "https://canary.example/rss/three" },
        ],
        supports: (target) => target.adapterId === "rss",
        collect: async () => successCollect(now),
      };
      return new ContentScoutHost({
        runs,
        workspaceDir,
        adapters: [adapter],
        ranker: {
          async rank() {
            return [];
          },
        },
        now: () => new Date(now.getTime()),
        log: () => undefined,
      });
    };

    const hostV1 = makeHost("v1");
    // Need 3 successes per target to be promotion eligible.
    for (let i = 0; i < 3; i += 1) {
      now.setTime(now.getTime() + CANARY_INTERVAL_MS);
      await hostV1.runCanaries();
    }
    const healthV1 = hostV1.canaryHealth().find((entry) => entry.adapterId === "rss")!;
    expect(healthV1.promotionEligible).toBe(true);
    expect(healthV1.evidence.version).toBe("v1");

    // After version bump, the same persisted receipts must not count toward new version.
    const hostV2 = makeHost("v2");
    const healthV2Before = hostV2.canaryHealth().find((entry) => entry.adapterId === "rss")!;
    expect(healthV2Before.promotionEligible).toBe(false);
    expect(healthV2Before.evidence.successCount).toBe(0);
    expect(healthV2Before.lastSuccessAt).toBeNull();

    // One success on the new version is still not enough for promotion.
    now.setTime(now.getTime() + CANARY_INTERVAL_MS);
    await hostV2.runCanaries();
    const healthV2One = hostV2.canaryHealth().find((entry) => entry.adapterId === "rss")!;
    expect(healthV2One.promotionEligible).toBe(false);

    // After two more successes, the new version becomes eligible.
    now.setTime(now.getTime() + CANARY_INTERVAL_MS);
    await hostV2.runCanaries();
    now.setTime(now.getTime() + CANARY_INTERVAL_MS);
    await hostV2.runCanaries();
    const healthV2Eligible = hostV2.canaryHealth().find((entry) => entry.adapterId === "rss")!;
    expect(healthV2Eligible.promotionEligible).toBe(true);
    expect(healthV2Eligible.evidence.version).toBe("v2");
  });

  it("marks canary health as degraded and recovers after a later verified success", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-canary-health-"));
    const runs = openRuns(workspaceDir);
    const now = new Date(START.getTime());
    let shouldFail = false;
    const adapter = canaryAdapter("instagram", "instagram-instaloader-v1", async () => {
      if (shouldFail) return failedCollect("blocked_access", now);
      return successCollect(now);
    });
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      adapters: [adapter],
      ranker: {
        async rank() {
          return [];
        },
      },
      now: () => new Date(now.getTime()),
      log: () => undefined,
    });

    await host.runCanaries();
    let health = host.canaryHealth().find((entry) => entry.adapterId === "instagram")!;
    expect(health.degraded).toBe(false);
    expect(health.lastSuccessAt).toBe(now.toISOString());
    expect(health.lastFailureAt).toBeNull();

    // Failure makes the adapter degraded and visible in the merged health warning set.
    now.setTime(now.getTime() + CANARY_INTERVAL_MS);
    shouldFail = true;
    await host.runCanaries();
    health = host.canaryHealth().find((entry) => entry.adapterId === "instagram")!;
    expect(health.degraded).toBe(true);
    expect(health.lastFailureAt).toBe(now.toISOString());
    // The Settings and Health persisted warning is driven from canary health, not just Intake Runs.
    // The host's /api/content-scout health merges intake warnings with degraded canaries.
    // We verify the health object reflects degraded rather than inspecting the HTTP layer here,
    // but the same logic is exercised through the public host seam.

    // A later verified success clears the degraded flag (health indicator remains until recovery).
    now.setTime(now.getTime() + CANARY_INTERVAL_MS);
    shouldFail = false;
    await host.runCanaries();
    health = host.canaryHealth().find((entry) => entry.adapterId === "instagram")!;
    expect(health.degraded).toBe(false);
    expect(health.lastSuccessAt).toBe(now.toISOString());
  });

  it("marks mixed latest target results as degraded even when their timestamps match", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-canary-mixed-health-"));
    const runs = openRuns(workspaceDir);
    const failedTarget = "https://canary.example/rss/two";
    const adapter = canaryAdapter("rss", "v1", async ({ url }) =>
      url === failedTarget ? failedCollect("response_shape_change", START) : successCollect(START),
    );
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      adapters: [adapter],
      ranker: {
        async rank() {
          return [];
        },
      },
      now: () => START,
      log: () => undefined,
    });

    await host.runCanaries();

    const health = host.canaryHealth().find((entry) => entry.adapterId === "rss")!;
    expect(health.lastSuccessAt).toBe(START.toISOString());
    expect(health.lastFailureAt).toBe(START.toISOString());
    expect(health.degraded).toBe(true);
  });

  it("requires repeated successful canaries for promotion and does not hide behind legitimate-empty", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-canary-promo-"));
    const runs = openRuns(workspaceDir);
    const now = new Date(START.getTime());
    let mode: "success" | "empty" | "fail" = "success";
    const adapter = canaryAdapter("tiktok", "tiktok-yt-dlp-v1", async () => {
      if (mode === "empty") return emptyCollect(now);
      if (mode === "fail") return failedCollect("rate_limit", now);
      return successCollect(now);
    });
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      adapters: [adapter],
      ranker: {
        async rank() {
          return [];
        },
      },
      now: () => new Date(now.getTime()),
      log: () => undefined,
    });

    // One successful batch is not enough: promotion requires repeated canaries, not one sample.
    await host.runCanaries();
    let health = host.canaryHealth().find((entry) => entry.adapterId === "tiktok")!;
    expect(health.promotionEligible).toBe(false);
    expect(health.evidence.successCount).toBe(3); // 3 targets each succeeded once

    now.setTime(now.getTime() + CANARY_INTERVAL_MS);
    await host.runCanaries();
    health = host.canaryHealth().find((entry) => entry.adapterId === "tiktok")!;
    expect(health.promotionEligible).toBe(false);

    now.setTime(now.getTime() + CANARY_INTERVAL_MS);
    await host.runCanaries();
    health = host.canaryHealth().find((entry) => entry.adapterId === "tiktok")!;
    expect(health.promotionEligible).toBe(true);

    // Legitimate empty must not count as success: it hides breakage if treated as healthy.
    now.setTime(now.getTime() + CANARY_INTERVAL_MS);
    mode = "empty";
    await host.runCanaries();
    health = host.canaryHealth().find((entry) => entry.adapterId === "tiktok")!;
    expect(health.degraded).toBe(true);
    expect(health.promotionEligible).toBe(false);
    // The empty receipts are still persisted, but with legitimate_empty outcome, and health correctly treats them as non-success.
    const emptyReceipts = host
      .canaryReceipts()
      .filter((receipt) => receipt.outcome === "legitimate_empty");
    expect(emptyReceipts.length).toBe(3);
    expect(emptyReceipts.every((receipt) => receipt.itemsFound === 0)).toBe(true);

    // Canary failure is isolated: the runner still persists the failure receipt and does not throw, so CI would not fail.
    now.setTime(now.getTime() + CANARY_INTERVAL_MS);
    mode = "fail";
    await expect(host.runCanaries()).resolves.toHaveLength(3);
    const failureReceipts = host
      .canaryReceipts()
      .filter((receipt) => receipt.outcome === "rate_limit");
    expect(failureReceipts.length).toBe(3);
    health = host.canaryHealth().find((entry) => entry.adapterId === "tiktok")!;
    expect(health.degraded).toBe(true);
    expect(health.promotionEligible).toBe(false);
  });

  it("keeps canary execution and persistence isolated from Intake collection", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-canary-isolated-"));
    const runs = openRuns(workspaceDir);
    const now = new Date(START.getTime());
    const isolatedStore = new ContentScoutCanaryStore(workspaceDir, () => now);
    const runner = new ContentScoutCanaryRunner({
      adapters: [canaryAdapter("rss", "v1", async () => successCollect(now))],
      store: isolatedStore,
      now: () => now,
    });
    const receipts = await runner.runOnce();
    expect(receipts).toHaveLength(3);
    expect(isolatedStore.list()).toHaveLength(3);
    // ContentScoutStore's schedule and source-target state are untouched by canary writes.
    const host = new ContentScoutHost({
      runs,
      workspaceDir,
      adapters: [canaryAdapter("rss", "v1", async () => successCollect(now))],
      ranker: {
        async rank() {
          return [];
        },
      },
      now: () => now,
      log: () => undefined,
    });
    expect(host.scheduleState()).toEqual({
      lastSuccessfulIntakePeriod: null,
      lastSuccessfulDiscoveryPeriod: null,
    });
  });

  it("records clean-browser LinkedIn evidence in the shared canary store and exposes the gate", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-linkedin-canary-"));
    const now = new Date(START.getTime());
    const adapter = new LinkedInComingLaterAdapter(
      async (url) => ({
        url,
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><html><head><meta property="og:title" content="Public LinkedIn source"><meta property="og:description" content="A useful anonymous public company update with enough evidence to prove the normalized Source Item contract."></head><body></body></html>`,
      }),
      () => new Date(now.getTime()),
    );
    const host = new ContentScoutHost({
      runs: openRuns(workspaceDir),
      workspaceDir,
      adapters: [adapter],
      ranker: {
        async rank() {
          return [];
        },
      },
      now: () => new Date(now.getTime()),
      log: () => undefined,
    });

    await expect(adapter.collect()).rejects.toThrow("Coming later");
    await expect(host.runCanaries()).resolves.toHaveLength(3);
    now.setTime(now.getTime() + CANARY_INTERVAL_MS);
    await expect(host.runCanaries()).resolves.toHaveLength(3);

    expect(host.canaryReceipts()).toHaveLength(6);
    expect(existsSync(join(workspaceDir, "content-scout", "canary-state.json"))).toBe(true);
    expect(existsSync(join(workspaceDir, "content-scout", "linkedin-canaries.json"))).toBe(false);

    const app = fastify();
    host.routes(app);
    const response = await app.inject({ method: "GET", url: "/api/content-scout" });
    expect(response.statusCode).toBe(200);
    expect(response.json().linkedinEvidenceGate).toMatchObject({
      passed: true,
      adapterVersion: adapter.version,
      evidence: expect.arrayContaining([
        expect.objectContaining({ outcome: "items_found", hasUsefulItem: true }),
      ]),
    });
    expect(adapter.state).toBe("coming_later");
    await app.close();
  });

  it("records LinkedIn login walls and empty shells as failed proof, never empty success", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-linkedin-failed-proof-"));
    let status = 200;
    let body = '<html><body class="authwall">Sign in to LinkedIn</body></html>';
    const adapter = new LinkedInComingLaterAdapter(async (url) => ({
      url,
      status,
      contentType: "text/html",
      body,
    }));
    const store = new ContentScoutCanaryStore(workspaceDir, () => START);
    const runner = new ContentScoutCanaryRunner({ adapters: [adapter], store, now: () => START });

    const blocked = await runner.runOnce();
    expect(blocked).toHaveLength(3);
    expect(blocked.every((receipt) => receipt.outcome === "blocked_access")).toBe(true);
    expect(blocked.every((receipt) => receipt.outcome !== "legitimate_empty")).toBe(true);

    status = 999;
    const nonstandardLoginWall = await runner.runOnce();
    expect(nonstandardLoginWall.every((receipt) => receipt.outcome === "blocked_access")).toBe(
      true,
    );
    status = 200;

    body =
      '<html><head><meta property="og:title" content="LinkedIn Login"><meta property="og:description" content="Log In or Sign Up to view this useful-looking public company update on LinkedIn."></head></html>';
    const commonLoginWall = await runner.runOnce();
    expect(commonLoginWall.every((receipt) => receipt.outcome === "blocked_access")).toBe(true);

    body = "<html><head><title>LinkedIn</title></head><body><main></main></body></html>";
    const emptyShell = await runner.runOnce();
    expect(emptyShell).toHaveLength(3);
    expect(emptyShell.every((receipt) => receipt.outcome === "response_shape_change")).toBe(true);
    expect(emptyShell.every((receipt) => receipt.itemsFound === 0)).toBe(true);
  });

  it("rejects repeated useful evidence from a stale LinkedIn adapter version", () => {
    const adapter = new LinkedInComingLaterAdapter();
    const evidence = adapter.canaryTargets.flatMap((target) =>
      [0, 1].map((): LinkedInCanaryEvidence => ({
        targetUrl: target.url,
        adapterVersion: "linkedin-public-browser-v0",
        outcome: "items_found",
        itemsFound: 1,
        hasUsefulItem: true,
        observedAt: START.toISOString(),
        diagnostic: diagnostic("items_found", target.url, START),
      })),
    );

    expect(evaluateLinkedInEvidenceGate(evidence, () => START)).toMatchObject({
      passed: false,
      adapterVersion: "linkedin-public-browser-v0",
      reason: expect.stringContaining("stale adapter version"),
    });
  });

  it("announces the batch before it reaches the network (issue #104)", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-canary-announce-"));
    const now = new Date(START.getTime());
    const order: string[] = [];
    const runner = new ContentScoutCanaryRunner({
      adapters: [
        canaryAdapter("rss", "v1", async () => {
          order.push("contacted");
          return successCollect(now);
        }),
      ],
      store: new ContentScoutCanaryStore(workspaceDir, () => now),
      now: () => now,
      announce: (targetCount) => order.push(`announced:${targetCount}`),
    });

    await runner.runOnce();

    // Announced once, with the real target count, and before the first request left.
    expect(order[0]).toBe("announced:3");
    expect(order.filter((entry) => entry.startsWith("announced:"))).toHaveLength(1);
    expect(order.slice(1)).toEqual(["contacted", "contacted", "contacted"]);
  });

  it("contacts no targets for an adapter the workspace declined (issue #104)", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-canary-declined-"));
    const now = new Date(START.getTime());
    const contacted: string[] = [];
    const adapterFor = (id: string) =>
      canaryAdapter(id, "v1", async () => {
        contacted.push(id);
        return successCollect(now);
      });
    const store = new ContentScoutCanaryStore(workspaceDir, () => now);
    const runner = new ContentScoutCanaryRunner({
      adapters: [adapterFor("rss"), adapterFor("youtube")],
      store,
      now: () => now,
      disabledAdapters: () => ["youtube"],
    });

    const receipts = await runner.runOnce();

    expect(new Set(contacted)).toEqual(new Set(["rss"]));
    expect(receipts.every((receipt) => receipt.adapterId === "rss")).toBe(true);
    expect(receipts).toHaveLength(3);
  });

  it("honours a workspace-configured canary interval (issue #104)", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-canary-interval-"));
    let now = new Date(START.getTime());
    const oneHour = 60 * 60 * 1000;
    const store = new ContentScoutCanaryStore(workspaceDir, () => now);
    const runner = new ContentScoutCanaryRunner({
      adapters: [canaryAdapter("rss", "v1", async () => successCollect(now))],
      store,
      now: () => now,
      intervalMs: () => oneHour,
    });

    await runner.runOnce();
    expect(store.list()).toHaveLength(3);

    // The shipped 12-hour cadence would still be waiting here; this workspace is not.
    now = new Date(now.getTime() + oneHour - 1000);
    expect(await runner.checkSchedule()).toBeNull();
    now = new Date(now.getTime() + 2000);
    expect(await runner.checkSchedule()).toHaveLength(3);
    expect(oneHour).toBeLessThan(CANARY_INTERVAL_MS);
  });

  it("never fires the canary batch until someone asks for it once (issue #104)", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-canary-first-run-"));
    let now = new Date(START.getTime());
    const store = new ContentScoutCanaryStore(workspaceDir, () => now);
    const runner = new ContentScoutCanaryRunner({
      adapters: [canaryAdapter("rss", "v1", async () => successCollect(now))],
      store,
      now: () => now,
    });

    // A fresh workspace has never run: starting the Shell must generate no egress.
    expect(await runner.checkSchedule()).toBeNull();
    expect(store.list()).toHaveLength(0);
    expect(store.lastRunAt()).toBeNull();

    // Waiting does not earn it either — the first batch is the person's call, not the clock's.
    now = new Date(START.getTime() + CANARY_INTERVAL_MS * 3);
    expect(await runner.checkSchedule()).toBeNull();
    expect(store.list()).toHaveLength(0);

    // An explicit run is what establishes the cadence.
    expect(await runner.runOnce()).toHaveLength(3);
    expect(store.lastRunAt()).not.toBeNull();

    now = new Date(now.getTime() + 1000);
    expect(await runner.checkSchedule()).toBeNull();

    // Once established, automatic runs proceed on the interval as before.
    now = new Date(now.getTime() + CANARY_INTERVAL_MS);
    expect(await runner.checkSchedule()).toHaveLength(3);
  });
});
