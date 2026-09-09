import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import { ContentResearchHost } from "../../../apps/server/src/modules/content-research/host";
import { ContentResearchProfileRefusal } from "../../../apps/server/src/modules/content-research/host";
import { ContentResearchStore } from "../../../apps/server/src/modules/content-research/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import {
  CONTENT_RESEARCH_BACKFILL_INTAKE,
  CONTENT_RESEARCH_DISCOVERY_INTAKE,
  CONTENT_RESEARCH_INTAKE,
  contentResearchBackfillModule,
  contentResearchModule,
  peopleDiscoveryModule,
} from "../../../apps/server/src/modules/content-research/module";
import { CONTENT_RESEARCH_MODULE_ID } from "@chief-of-staff-demo/shared";
import type { RecoveryState } from "../../../apps/server/src/engine/module";
import type { RunMeta } from "@chief-of-staff-demo/shared";
import type { PeopleDiscoverer } from "../../../apps/server/src/modules/content-research/ports";
import {
  feedsDeclaredIn,
  type FeedDiscoverer,
} from "../../../apps/server/src/source-adapters/feeds";
import { openRuns } from "../../../apps/server/src/runs";
import type {
  SourceAdapter,
  SourceCollectionResult,
} from "../../../apps/server/src/source-adapters/source-adapter";
import type { NamedPerson, PersonProfileProjection, SourceItem } from "@chief-of-staff-demo/shared";

const NOW = new Date("2026-08-30T08:00:00.000Z");

/* A clock the test moves, so 48h checkpoints and backfill windows are deterministic. */
let current = new Date(NOW);
const now = (): Date => new Date(current);

function makeItem(input: {
  url: string;
  title: string;
  adapterId: string;
  publishedAt?: string;
  counts?: { views?: number; hnPoints?: number; redditScore?: number };
}): SourceItem {
  return {
    id: `item_${input.url}`,
    externalId: input.url,
    targetId: "fixture-target",
    adapterId: input.adapterId,
    canonicalUrl: input.url,
    author: "Fixture Author",
    title: input.title,
    body: `Body of ${input.title}`,
    description: null,
    publishedAt: input.publishedAt ?? "2026-08-29T10:00:00.000Z",
    discoveredAt: now().toISOString(),
    media: [],
    transcript: null,
    comments: [],
    evidence: [{ route: `fixture:${input.adapterId}`, retrievedAt: now().toISOString() }],
    completeness: {
      title: "available",
      body: "available",
      description: "unavailable",
      transcript: "unavailable",
      comments: "unavailable",
      media: "unavailable",
    },
    /* Engagement rides the shared SourceItem contract, exactly as the RSS,
       YouTube, Reddit and HN adapters report it — an item without counts is a
       platform that publishes none. */
    ...(input.counts ? { engagement: input.counts } : {}),
  };
}

type RecordedCall = {
  targetId: string;
  since: string;
  until: string;
  checkpoint: string | null;
  conditional: { etag: string | null; lastModified: string | null } | null;
};

function makeAdapter(input: {
  id: string;
  itemsFor: (personId: string) => SourceItem[];
  backfillWindowsDays?: readonly (7 | 30 | 90)[];
  failWith?: SourceCollectionResult;
}): SourceAdapter & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    id: input.id,
    state: "available",
    version: "fixture-1",
    ...(input.backfillWindowsDays ? { backfillWindowsDays: input.backfillWindowsDays } : {}),
    calls,
    supports: (target) => target.adapterId === input.id,
    async collect({ target, since, until, checkpoint, conditional }) {
      calls.push({
        targetId: target.id,
        since,
        until,
        checkpoint: checkpoint ?? null,
        conditional: conditional ?? null,
      });
      if (input.failWith) return input.failWith;
      const personId = target.id.split("__")[0] ?? "";
      const items = input.itemsFor(personId);
      return {
        kind: "completed",
        outcome: items.length > 0 ? "items_found" : "legitimate_empty",
        checkpoint: until,
        conditional: { etag: `W/"${input.id}-etag"`, lastModified: null },
        items,
        diagnostic: {
          classification: items.length > 0 ? "items_found" : "legitimate_empty",
          route: `fixture:${input.id}`,
          status: 200,
          contentType: "application/json",
          parserStage: "adapter_boundary",
          responseHash: "fixture-hash",
          adapterVersion: "fixture-1",
          startedAt: now().toISOString(),
          finishedAt: now().toISOString(),
          retries: 0,
          affectedCapabilities: [],
          causeChain: [],
        },
      };
    },
  };
}

function rateLimitedResult(): SourceCollectionResult {
  return {
    kind: "failed",
    outcome: "rate_limit",
    items: [],
    checkpoint: null,
    diagnostic: {
      classification: "rate_limit",
      route: "fixture:reddit",
      status: 429,
      contentType: null,
      parserStage: "fetch",
      responseHash: "",
      adapterVersion: "fixture-1",
      startedAt: now().toISOString(),
      finishedAt: now().toISOString(),
      retries: 0,
      affectedCapabilities: [],
      causeChain: ["HTTP 429"],
    },
  };
}

function makeHookExtractor() {
  const calls: { personName: string; titles: (string | null)[] }[] = [];
  return {
    calls,
    async extract(input: { personName: string; items: { title: string | null }[] }) {
      calls.push({ personName: input.personName, titles: input.items.map((i) => i.title) });
      return { hook: `why ${input.personName} landed`, evidenceQuote: "a verbatim line" };
    },
  };
}

/**
 * A Sheet that actually remembers what was written, because the ledger upsert is
 * a read-then-write: a retry has to see the rows the first attempt left behind
 * before we can claim it creates only what is missing.
 */
function makeSheets() {
  const appended: (string | number)[][][] = [];
  const updated: { rowNumber: number; values: (string | number)[] }[] = [];
  const tabs: string[] = [];
  const rows = new Map<string, (string | number)[][]>();
  let created = 0;
  return {
    appended,
    updated,
    tabs,
    rowsIn: (tab: string) => rows.get(tab) ?? [],
    createdCount: () => created,
    factory: () => ({
      ok: true as const,
      client: {
        createSpreadsheet: async () => {
          created += 1;
          return { id: `sheet-${created}`, url: `https://sheets.example/sheet-${created}` };
        },
        ensureTab: async (_id: string, title: string, header: string[]) => {
          tabs.push(title);
          if (!rows.has(title)) rows.set(title, [header]);
        },
        readRows: async (_id: string, tab: string) => rows.get(tab) ?? null,
        appendRows: async (_id: string, tab: string, newRows: (string | number)[][]) => {
          appended.push(newRows);
          rows.set(tab, [...(rows.get(tab) ?? []), ...newRows]);
        },
        updateRow: async (
          _id: string,
          tab: string,
          rowNumber: number,
          values: (string | number)[],
        ) => {
          updated.push({ rowNumber, values });
          const existing = [...(rows.get(tab) ?? [])];
          existing[rowNumber - 1] = values;
          rows.set(tab, existing);
        },
        isMissing: () => false,
      },
      spreadsheet: null,
    }),
  };
}

function makeGmail(options: { failFirst?: number } = {}) {
  const drafts: { to: string; subject: string; body: string }[] = [];
  let attempts = 0;
  return {
    drafts,
    factory: () => ({
      ok: true as const,
      client: {
        createDraft: async (draft: { to: string; subject: string; body: string }) => {
          attempts += 1;
          if (options.failFirst !== undefined && attempts <= options.failFirst) {
            throw new Error("gmail temporarily unavailable");
          }
          drafts.push(draft);
          return `draft-${attempts}`;
        },
      },
    }),
  };
}

interface HarnessOptions {
  adapters: (SourceAdapter & { calls?: RecordedCall[] })[];
  hookExtractor?: ReturnType<typeof makeHookExtractor>;
  discoverer?: PeopleDiscoverer;
  sheets?: ReturnType<typeof makeSheets>;
  gmail?: ReturnType<typeof makeGmail>;
  discoverFeeds?: FeedDiscoverer;
  searchPublic?: (query: string) => Promise<{ title: string; url: string; snippet: string }[]>;
  ownerEmail?: string | null;
  profileProjection?: (profileId: string) => PersonProfileProjection | null;
}

/**
 * Creates the confirmed Profile a watch is backed by, then the watch itself.
 * The seam under test (#134) takes a Profile id, never a bare name.
 */
function watchProfile(
  host: ContentResearchHost,
  people: WorkspacePersonProfiles,
  input: {
    fullName: string;
    email?: string;
    handleHints?: NamedPerson["handleHints"];
    discoveredSourceTargets?: NamedPerson["discoveredSourceTargets"];
  },
): NamedPerson {
  const profile = people.create({
    fullName: input.fullName,
    primaryEmail:
      input.email ?? `${input.fullName.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`,
  });
  return host.addPerson({
    profileId: profile.id,
    ...(input.handleHints ? { handleHints: input.handleHints } : {}),
    ...(input.discoveredSourceTargets
      ? { discoveredSourceTargets: input.discoveredSourceTargets }
      : {}),
  });
}

function makeHarness(options: HarnessOptions) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-research-"));
  const runs = openRuns(workspaceDir);
  const hookExtractor = options.hookExtractor ?? makeHookExtractor();
  const sheets = options.sheets ?? makeSheets();
  const gmail = options.gmail ?? makeGmail();
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    /* An empty registry list is the explicit claim that this test Workspace
       holds no other Profile references; the lifecycle tests compose theirs. */
    lifecycle: [],
    now,
  });
  const profileProjection =
    options.profileProjection ?? ((profileId: string) => people.project("public-safe", profileId));
  const host = new ContentResearchHost({
    runs,
    workspaceDir,
    adapters: options.adapters,
    hookExtractor,
    ...(options.discoverer ? { discoverer: options.discoverer } : {}),
    discoverFeeds: options.discoverFeeds ?? (async () => []),
    searchPublic: options.searchPublic ?? (async () => []),
    sheetsFactory: sheets.factory,
    gmailFactory: gmail.factory,
    getOwnerEmail: () =>
      options.ownerEmail === undefined ? "owner@example.com" : options.ownerEmail,
    now,
    profileProjection,
    log: () => {},
    sleep: () => Promise.resolve(),
  });
  return { workspaceDir, runs, host, people, profileProjection, hookExtractor, sheets, gmail };
}

interface RunResultShape {
  reports: {
    personId: string;
    personName: string;
    items: {
      canonicalUrl: string;
      platform: string;
      resonanceScore: number;
      resonanceBasis: string;
      weightedCount: number;
    }[];
  }[];
  adapters: { adapterId: string; outcome: string; errorClassifications: string[] }[];
  ledgerRows: { personId: string; canonicalUrl: string; platform: string }[];
}

function readResult(runs: ReturnType<typeof openRuns>, runId: string): RunResultShape {
  return JSON.parse(runs.open(runId)?.readArtifact("result.json") ?? "{}") as RunResultShape;
}

describe("Content Research", () => {
  it("daily run: per-person reports, global dedup with per-person attribution, ledger rows, owner draft", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const hn = makeAdapter({ id: "hn", itemsFor: () => [], backfillWindowsDays: [7, 30, 90] });
    const { workspaceDir, runs, host, gmail, people } = makeHarness({ adapters: [rss, hn] });

    const ben = watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    const ava = watchProfile(host, people, {
      fullName: "Ava",
      handleHints: { blogRssHints: ["https://ava.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({
        url: "https://example.com/co-authored",
        title: "Co-authored post",
        adapterId: "rss",
        counts: { views: 50 },
      }),
    ]);
    perPerson.set(ava.id, [
      makeItem({
        url: "https://example.com/co-authored",
        title: "Co-authored post",
        adapterId: "rss",
        counts: { views: 90 },
      }),
      makeItem({
        url: "https://ava.example/own",
        title: "Ava alone",
        adapterId: "rss",
        counts: { views: 5 },
      }),
    ]);

    const runId = await host.researchNow();
    await host.idle();

    expect(runs.open(runId)?.read().status).toBe("done");
    const result = readResult(runs, runId);
    expect(result.reports).toHaveLength(2);
    const benReport = result.reports.find((r) => r.personId === ben.id);
    const avaReport = result.reports.find((r) => r.personId === ava.id);
    // The co-authored URL is attributed to both people…
    expect(benReport?.items.map((i) => i.canonicalUrl)).toContain(
      "https://example.com/co-authored",
    );
    expect(avaReport?.items.map((i) => i.canonicalUrl)).toContain(
      "https://example.com/co-authored",
    );
    // …but stored once globally.
    expect(readdirSync(join(workspaceDir, "content-research", "items"))).toHaveLength(2);

    // The ledger keeps one row per (person, canonicalUrl) — both rows for the shared post.
    const coAuthoredRows = result.ledgerRows.filter(
      (r) => r.canonicalUrl === "https://example.com/co-authored",
    );
    expect(coAuthoredRows.map((r) => r.personId).sort()).toEqual([ava.id, ben.id].sort());
    // One owner-only draft digest was created.
    expect(gmail.drafts).toHaveLength(1);
    expect(gmail.drafts[0]?.to).toBe("owner@example.com");
  });

  it("does not create the owner-only Gmail draft without a confirmed owner identity", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const { runs, host, gmail, people } = makeHarness({ adapters: [rss], ownerEmail: null });
    const ben = watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({
        url: "https://ben.example/post",
        title: "Ben's post",
        adapterId: "rss",
        counts: { views: 10 },
      }),
    ]);

    const runId = await host.researchNow();
    await host.idle();

    expect(runs.detail(runId)?.status).toBe("done");
    expect(gmail.drafts).toEqual([]);
    expect(runs.detail(runId)?.events).toContainEqual(
      expect.objectContaining({ type: "gmail_skipped", detail: { reason: "owner_missing" } }),
    );
  });

  it("daily run: the next Run asks conditionally with what the last one was told", async () => {
    /* Source Targets are re-derived from a Person's hints every Run, so the
       validators have to be remembered against the URL or every fetch is
       unconditional (spec #116 story 8). */
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { host, people } = makeHarness({ adapters: [rss] });
    watchProfile(host, people, {
      fullName: "Ada",
      handleHints: { blogRssHints: ["https://ada.example/feed"] },
    });

    await host.researchNow();
    await host.idle();
    const first = rss.calls.find((c) => c.targetId.endsWith("__0"));
    expect(first?.conditional).toBeNull();
    expect(first?.checkpoint).toBeNull();

    rss.calls.length = 0;
    await host.researchNow();
    await host.idle();
    const second = rss.calls.find((c) => c.targetId.endsWith("__0"));
    expect(second?.conditional).toEqual({ etag: 'W/"rss-etag"', lastModified: null });
    expect(second?.checkpoint).not.toBeNull();
  });

  it("daily run: a URL reaching two people by different adapters keeps each person's own platform", async () => {
    /* Dedup is global on canonicalUrl, so the shared post is stored once — but
       Ben found it on his feed and Ava on her channel, and labelling Ava's copy
       "rss" because Ben was seen first would misreport where it resonated. */
    const shared = {
      url: "https://example.com/shared",
      title: "Shared post",
      counts: { views: 100 },
    };
    const rss = makeAdapter({
      id: "rss",
      itemsFor: (pid) => (pid === benId ? [makeItem({ ...shared, adapterId: "rss" })] : []),
    });
    const youtube = makeAdapter({
      id: "youtube",
      itemsFor: (pid) => (pid === avaId ? [makeItem({ ...shared, adapterId: "youtube" })] : []),
    });
    const { runs, host, people } = makeHarness({ adapters: [rss, youtube] });

    const ben = watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    const ava = watchProfile(host, people, {
      fullName: "Ava",
      handleHints: { blogRssHints: [], youtubeChannelId: "UC_ava" },
    });
    const benId = ben.id;
    const avaId = ava.id;

    const runId = await host.researchNow();
    await host.idle();

    const result = readResult(runs, runId);
    const platformFor = (personId: string) =>
      result.reports
        .find((r) => r.personId === personId)
        ?.items.find((i) => i.canonicalUrl === shared.url)?.platform;

    expect(platformFor(benId)).toBe("rss");
    expect(platformFor(avaId)).toBe("youtube");
  });

  it("daily run: hook extraction is one call per person and never sees the other person's items", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const hooks = makeHookExtractor();
    const { runs, host, hookExtractor, people } = makeHarness({
      adapters: [rss],
      hookExtractor: hooks,
    });

    const ben = watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    const ava = watchProfile(host, people, {
      fullName: "Ava",
      handleHints: { blogRssHints: ["https://ava.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({ url: "https://ben.example/post", title: "Ben's post", adapterId: "rss" }),
    ]);
    perPerson.set(ava.id, [
      makeItem({ url: "https://ava.example/post", title: "Ava's post", adapterId: "rss" }),
    ]);

    const runId = await host.researchNow();
    await host.idle();

    expect(runs.open(runId)?.read().status).toBe("done");
    expect(hookExtractor.calls).toHaveLength(2);
    expect(hookExtractor.calls.find((c) => c.personName === "Ben")?.titles).toEqual(["Ben's post"]);
    expect(hookExtractor.calls.find((c) => c.personName === "Ava")?.titles).toEqual(["Ava's post"]);
  });

  it("48h overlap checkpoint advances: the second daily run looks back from the checkpoint, not another 7 days", async () => {
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { runs, host, people } = makeHarness({ adapters: [rss] });
    watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });

    const first = await host.researchNow();
    await host.idle();
    expect(runs.open(first)?.read().status).toBe("done");
    // The first run scans the prior 7 days.
    expect(rss.calls[0]?.since).toBe(
      new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    );
    expect(host.getDailyCheckpoint()).toBe(NOW.toISOString());

    current = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const second = await host.researchNow();
    await host.idle();
    expect(runs.open(second)?.read().status).toBe("done");
    // The second run: checkpoint minus the 48h overlap.
    expect(rss.calls.at(-1)?.since).toBe(
      new Date(NOW.getTime() - 48 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("backfill: an unsupported window fails explicitly; a supported window passes a genuine historical since", async () => {
    const rss = makeAdapter({ id: "rss", itemsFor: () => [], backfillWindowsDays: [7] });
    const { runs, host, people } = makeHarness({ adapters: [rss] });
    watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });

    const refused = await host.backfillNow(30);
    await host.idle();
    expect(runs.open(refused)?.read().status).toBe("failed");
    expect(runs.open(refused)?.read().failureHint).toContain("backfill");

    const ok = await host.backfillNow(7);
    await host.idle();
    expect(runs.open(ok)?.read().status).toBe("done");
    expect(rss.calls.at(-1)?.since).toBe(
      new Date(current.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("one adapter rate-limited: the Run still completes and the other platform's evidence survives", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const sick = makeAdapter({ id: "reddit", itemsFor: () => [], failWith: rateLimitedResult() });
    const { runs, host, people } = makeHarness({ adapters: [rss, sick] });
    const ben = watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({ url: "https://ben.example/post", title: "Ben's post", adapterId: "rss" }),
    ]);

    const runId = await host.researchNow();
    await host.idle();

    expect(runs.open(runId)?.read().status).toBe("done");
    const result = readResult(runs, runId);
    expect(result.reports[0]?.items.map((i) => i.canonicalUrl)).toEqual([
      "https://ben.example/post",
    ]);
    const reddit = result.adapters.find((a) => a.adapterId === "reddit");
    expect(reddit?.outcome).toBe("rate_limit");
    expect(reddit?.errorClassifications).toContain("rate_limit");
  });

  it("velocity: with a 90-day baseline the score is a z-score against the person, not the raw count", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const { workspaceDir, runs, host, people } = makeHarness({ adapters: [rss] });
    const ben = watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({
        url: "https://ben.example/spike",
        title: "Ben's spike",
        adapterId: "rss",
        counts: { views: 105 },
      }),
    ]);
    // The person's 90-day baseline: quiet days around 100 views.
    new ContentResearchStore(workspaceDir, now).recordBaseline(ben.id, [100, 102]);

    const runId = await host.researchNow();
    await host.idle();

    const result = readResult(runs, runId);
    const scored = result.reports[0]?.items[0];
    expect(scored).toBeDefined();
    expect(scored.weightedCount).toBe(105);
    // mean 101, sample stdDev sqrt(2): a spike above the person, not a big raw number.
    expect(scored.resonanceScore).toBeCloseTo((105 - 101) / Math.SQRT2, 5);
  });

  it("resonance ranking orders each person's report by score", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const { runs, host, people } = makeHarness({ adapters: [rss] });
    const ben = watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({
        url: "https://ben.example/low",
        title: "Low",
        adapterId: "rss",
        counts: { views: 3 },
      }),
      makeItem({
        url: "https://ben.example/high",
        title: "High",
        adapterId: "rss",
        counts: { views: 300 },
      }),
      makeItem({
        url: "https://ben.example/mid",
        title: "Mid",
        adapterId: "rss",
        counts: { views: 30 },
      }),
    ]);

    const runId = await host.researchNow();
    await host.idle();

    const result = readResult(runs, runId);
    const scores = result.reports[0]?.items.map((i) => i.resonanceScore) ?? [];
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(result.reports[0]?.items[0]?.canonicalUrl).toBe("https://ben.example/high");
  });

  it("local report survives a Google partial failure; the retry creates only what is missing", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const sheets = makeSheets();
    const gmail = makeGmail({ failFirst: 1 });
    const { runs, host, people } = makeHarness({ adapters: [rss], sheets, gmail });
    const ben = watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({
        url: "https://ben.example/post",
        title: "Ben's post",
        adapterId: "rss",
        counts: { views: 10 },
      }),
    ]);

    const runId = await host.researchNow();
    await host.idle();

    // The first attempt failed at Gmail — but the local report is already readable.
    expect(runs.open(runId)?.read().status).toBe("failed");
    const partial = readResult(runs, runId);
    expect(partial.reports).toHaveLength(1);
    expect(partial.ledgerRows).toHaveLength(1);

    await host.retryRun(runId);
    await host.idle();

    expect(runs.open(runId)?.read().status).toBe("done");
    // The Sheet rows went up exactly once across both attempts; the draft only on the retry.
    expect(sheets.appended).toHaveLength(1);
    expect(gmail.drafts).toHaveLength(1);
    expect(gmail.drafts[0]?.to).toBe("owner@example.com");
  });

  it("a Home notification fires when at least one person has new resonance", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const { runs, host, people } = makeHarness({ adapters: [rss] });
    const ben = watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({
        url: "https://ben.example/post",
        title: "Ben's post",
        adapterId: "rss",
        counts: { views: 10 },
      }),
    ]);

    const runId = await host.researchNow();
    await host.idle();

    const events = runs.detail(runId)?.events ?? [];
    const notification = events.find((e) => e.type === "home_notification");
    expect(String(notification?.detail?.message)).toContain("Ben");
  });

  it("people discovery: public search for co-mentions reaches the proposer, and a sick search still runs", async () => {
    /* Story 21 sources candidates from co-mentions found by public search, not
       from what the model happens to recall. */
    const queries: string[] = [];
    let seen: { title: string; url: string; snippet: string }[] = [];
    const discoverer: PeopleDiscoverer = {
      discover: async (input) => {
        seen = input.searchResults;
        return [];
      },
    };
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { host, people } = makeHarness({
      adapters: [rss],
      discoverer,
      searchPublic: async (query) => {
        queries.push(query);
        return [{ title: "Ada and Grace", url: "https://example.com/a", snippet: "co-mention" }];
      },
    });
    watchProfile(host, people, { fullName: "Ada", handleHints: { blogRssHints: [] } });

    await host.discoverNow();
    await host.idle();

    expect(queries.some((q) => q.includes("Ada"))).toBe(true);
    expect(seen.map((r) => r.url)).toEqual(["https://example.com/a"]);

    // A search route that throws narrows the evidence rather than failing the Run.
    const sick = makeHarness({
      adapters: [makeAdapter({ id: "rss", itemsFor: () => [] })],
      discoverer,
      searchPublic: async () => {
        throw new Error("search unavailable");
      },
    });
    watchProfile(sick.host, sick.people, { fullName: "Ada", handleHints: { blogRssHints: [] } });
    const sickRunId = await sick.host.discoverNow();
    await sick.host.idle();
    expect(sick.runs.open(sickRunId)?.read().status).toBe("done");
  });

  it("people discovery: proposes, approves into a watched person, dismisses against re-suggestion, restores", async () => {
    const discoverer: PeopleDiscoverer = {
      discover: async (input) => {
        expect(input.approvedPeople.map((p) => p.name)).toContain("Ben");
        return [
          {
            name: "Grace Hopper",
            reason: "co-mentioned by Ben",
            supportingUrls: ["https://ben.example/post"],
            relationshipToBrand: "admired systems pioneer",
            source: "co-mention",
          },
        ];
      },
    };
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { runs, host, people } = makeHarness({ adapters: [rss], discoverer });
    watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });

    const runId = await host.discoverNow();
    await host.idle();
    expect(runs.open(runId)?.read().status).toBe("done");

    const suggestions = host.listSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.state).toBe("pending");
    expect(suggestions[0]?.relationshipToBrand).toBe("admired systems pioneer");

    // Approve: the operator selects an existing Profile (or creates and
    // confirms one) — then the watch is created (#134).
    const graceProfile = people.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
    });
    host.decideSuggestion(suggestions[0].id, "approved", null, graceProfile.id);
    expect(host.listPeople().map((p) => p.name)).toContain("Grace Hopper");
    expect(host.listPeople().find((p) => p.name === "Grace Hopper")?.profileId).toBe(
      graceProfile.id,
    );

    // A second discovery run does not re-suggest someone already watched.
    const second = await host.discoverNow();
    await host.idle();
    expect(runs.open(second)?.read().status).toBe("done");
    expect(host.listSuggestions()).toHaveLength(1);
  });

  it("people discovery: a dismissed suggestion blocks re-suggestion while dismissed and restores afterwards", async () => {
    const name = { value: "Radia Perlman" };
    const discoverer: PeopleDiscoverer = {
      discover: async () => [
        {
          name: name.value,
          reason: "cited in collected items",
          supportingUrls: ["https://example.com/radia"],
          relationshipToBrand: "related pioneer",
          source: "co-mention",
        },
      ],
    };
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { host, people } = makeHarness({ adapters: [rss], discoverer });
    watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });

    await host.discoverNow();
    await host.idle();
    const pending = host.listSuggestions().find((s) => s.name === "Radia Perlman");
    expect(pending?.state).toBe("pending");
    host.decideSuggestion(pending!.id, "dismissed", "not relevant");

    // Re-proposed while dismissed: not saved again.
    await host.discoverNow();
    await host.idle();
    const afterDismiss = host.listSuggestions().filter((s) => s.name === "Radia Perlman");
    expect(afterDismiss).toHaveLength(1);
    expect(afterDismiss[0]?.state).toBe("dismissed");

    // Restoring makes the person eligible again.
    host.restoreSuggestion(afterDismiss[0].id);
    expect(host.listSuggestions().find((s) => s.name === "Radia Perlman")?.state).toBe("pending");
  });

  it("the cross-Run index groups reports by person, newest report first", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const { host, people } = makeHarness({ adapters: [rss] });
    const ben = watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({
        url: "https://ben.example/post",
        title: "Ben's post",
        adapterId: "rss",
        counts: { views: 10 },
      }),
    ]);

    await host.researchNow();
    await host.idle();
    current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
    await host.researchNow();
    await host.idle();

    const index = host.getIndex();
    expect(index.byPerson).toHaveLength(1);
    expect(index.byPerson[0]?.personName).toBe("Ben");
    expect(index.byPerson[0]?.reports).toHaveLength(2);
    expect(
      index.byPerson[0]?.reports[0].generatedAt >= index.byPerson[0].reports[1].generatedAt,
    ).toBe(true);
    expect(index.runs).toHaveLength(2);
  });

  it("target derivation watches a person by name on Reddit, HN, and Google News without any URL being pasted", async () => {
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const reddit = makeAdapter({ id: "reddit", itemsFor: () => [] });
    const hn = makeAdapter({ id: "hn", itemsFor: () => [], backfillWindowsDays: [7, 30, 90] });
    const news = makeAdapter({ id: "news", itemsFor: () => [] });
    const { host, people } = makeHarness({ adapters: [rss, reddit, hn, news] });
    const ava = watchProfile(host, people, { fullName: "Ava", handleHints: { blogRssHints: [] } });

    await host.researchNow();
    await host.idle();

    expect(reddit.calls.some((c) => c.targetId.startsWith(ava.id))).toBe(true);
    expect(hn.calls.some((c) => c.targetId.startsWith(ava.id))).toBe(true);
    expect(news.calls.some((c) => c.targetId.startsWith(ava.id))).toBe(true);
    // No RSS target exists without a hint — and none is invented.
    expect(rss.calls.filter((c) => c.targetId.startsWith(ava.id))).toHaveLength(0);
  });

  it("feed discovery reads the feeds a site declares about itself and ignores anything else", () => {
    const html = `
      <html><head>
        <link rel="alternate" type="application/rss+xml" title="Ben's blog" href="/feed.xml">
        <link rel="alternate" type="application/atom+xml" href="https://cdn.example/atom">
        <link rel="alternate" type="text/html" href="/amp">
        <link rel="stylesheet" type="application/rss+xml" href="/not-a-feed">
        <link rel="alternate" type="application/rss+xml" href="/feed.xml">
      </head></html>`;
    expect(feedsDeclaredIn(html, "https://ben.example/")).toEqual([
      { url: "https://ben.example/feed.xml", title: "Ben's blog" },
      { url: "https://cdn.example/atom", title: null },
    ]);
  });

  it("adding a person resolves the feeds their site declares, and the daily run then collects them", async () => {
    const asked: string[] = [];
    const discoverFeeds: FeedDiscoverer = async (site) => {
      asked.push(site);
      return site === "https://ben.example/"
        ? [{ url: "https://ben.example/feed.xml", title: "Ben's blog" }]
        : [];
    };
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { host, people } = makeHarness({ adapters: [rss], discoverFeeds });

    const ben = watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/some/post"] },
    });
    const resolved = await host.resolveSourceTargets(ben.id);

    expect(asked).toEqual(["https://ben.example/"]);
    expect(resolved.discoveredSourceTargets).toEqual([
      {
        adapterId: "rss",
        url: "https://ben.example/feed.xml",
        label: "Ben's blog",
      },
    ]);

    await host.researchNow();
    await host.idle();
    expect(rss.calls.some((call) => call.targetId.startsWith(ben.id))).toBe(true);
  });

  it("a site that cannot be reached leaves the person watched, without inventing a feed", async () => {
    const discoverFeeds: FeedDiscoverer = async () => {
      throw new Error("ENOTFOUND");
    };
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { host, people } = makeHarness({ adapters: [rss], discoverFeeds });
    const ben = watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/"] },
    });

    const resolved = await host.resolveSourceTargets(ben.id);
    expect(resolved.discoveredSourceTargets).toEqual([]);
    expect(host.listPeople().map((p) => p.name)).toEqual(["Ben"]);
  });

  it("approving a suggestion watches the person's supporting sites and resolves their feeds in one step", async () => {
    const discoverFeeds: FeedDiscoverer = async (site) =>
      site === "https://grace.example/" ? [{ url: "https://grace.example/rss", title: null }] : [];
    const discoverer: PeopleDiscoverer = {
      discover: async () => [
        {
          name: "Grace Hopper",
          reason: "co-mentioned by Ben",
          supportingUrls: ["https://grace.example/posts/compilers"],
          relationshipToBrand: "admired systems pioneer",
          source: "co-mention",
        },
      ],
    };
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { host, people } = makeHarness({ adapters: [rss], discoverer, discoverFeeds });
    watchProfile(host, people, { fullName: "Ben", handleHints: { blogRssHints: [] } });

    await host.discoverNow();
    await host.idle();
    const suggestion = host.listSuggestions()[0];
    const graceProfile = people.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
    });
    host.decideSuggestion(suggestion.id, "approved", null, graceProfile.id);

    const grace = host.listPeople().find((p) => p.name === "Grace Hopper")!;
    // The supporting URL's site is watched straight away…
    expect(grace.discoveredSourceTargets).toEqual([
      { adapterId: "website", url: "https://grace.example/", label: "Grace Hopper website" },
    ]);
    // …and resolving adds the feed that site declares.
    const resolved = await host.resolveSourceTargets(grace.id);
    expect(resolved.discoveredSourceTargets.map((t) => `${t.adapterId} ${t.url}`)).toEqual([
      "website https://grace.example/",
      "rss https://grace.example/rss",
    ]);
  });

  it("counts a platform reports drive the ranking, and a platform reporting none does not outrank them", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const youtube = makeAdapter({ id: "youtube", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const { runs, host, people } = makeHarness({ adapters: [rss, youtube] });
    const ben = watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"], youtubeChannelId: "UCben" },
    });
    perPerson.set(ben.id, [
      // An RSS post: Substack publishes no engagement counts at all.
      makeItem({ url: "https://ben.example/post", title: "Quiet post", adapterId: "rss" }),
      // A video YouTube reports real numbers for.
      makeItem({
        url: "https://www.youtube.com/watch?v=abc",
        title: "Busy video",
        adapterId: "youtube",
        counts: { views: 4000 },
      }),
    ]);

    const runId = await host.researchNow();
    await host.idle();

    const items = readResult(runs, runId).reports[0]?.items ?? [];
    expect(items[0]?.canonicalUrl).toBe("https://www.youtube.com/watch?v=abc");
    expect(items[0]?.weightedCount).toBe(4000);
    // The post with no reported counts scores zero rather than a made-up number.
    expect(items.find((i) => i.canonicalUrl === "https://ben.example/post")?.weightedCount).toBe(0);
  });
});

describe("Content Research recovery ownership", () => {
  /* The daily, backfill and discovery Runners share one Module id, so the
     Runner's module-scoped recovery scan hands the daily Module every Content
     Research Run. Adopting another Intake's Run re-collected every adapter
     under it and published a second time. planRecovery reads only the durable
     record, so the Module's collaborators are never reached. */
  const module = contentResearchModule(fromPartial({}));

  const runAwaitingRecovery = (intake: string) =>
    fromPartial<RecoveryState>({
      module: CONTENT_RESEARCH_MODULE_ID,
      intake,
      status: "running",
      files: [],
    });

  const failedRun = (intake: string) =>
    fromPartial<RunMeta>({
      module: CONTENT_RESEARCH_MODULE_ID,
      intake,
      status: "failed",
      failedStage: "collect",
      externalId: "backfill:90",
    });

  it("retries its own daily Run but never another Intake's Run", () => {
    /* retryRun asks each Runner in turn, so a Module that answers for an
       Intake it does not own re-runs a backfill as a daily Run — advancing the
       daily checkpoint and the 90-day baseline off a 90-day window. */
    expect(module.planRetry(failedRun(CONTENT_RESEARCH_INTAKE))).toMatchObject({
      fromStage: "collect",
    });
    expect(module.planRetry(failedRun(CONTENT_RESEARCH_DISCOVERY_INTAKE))).toBe(null);
    expect(module.planRetry(failedRun(CONTENT_RESEARCH_BACKFILL_INTAKE))).toBe(null);
  });

  it("each Intake's Module answers only for its own failed Runs", () => {
    const backfill = contentResearchBackfillModule(fromPartial({}));
    const discovery = peopleDiscoveryModule(fromPartial({}));

    expect(backfill.planRetry(failedRun(CONTENT_RESEARCH_BACKFILL_INTAKE))).toBeTruthy();
    expect(backfill.planRetry(failedRun(CONTENT_RESEARCH_INTAKE))).toBe(null);
    expect(backfill.planRetry(failedRun(CONTENT_RESEARCH_DISCOVERY_INTAKE))).toBe(null);

    expect(discovery.planRetry(failedRun(CONTENT_RESEARCH_DISCOVERY_INTAKE))).toBeTruthy();
    expect(discovery.planRetry(failedRun(CONTENT_RESEARCH_INTAKE))).toBe(null);
    expect(discovery.planRetry(failedRun(CONTENT_RESEARCH_BACKFILL_INTAKE))).toBe(null);
  });

  it("recovers its own daily Run but never another Intake's Run", () => {
    expect(module.planRecovery?.(runAwaitingRecovery(CONTENT_RESEARCH_INTAKE))).toMatchObject({
      fromStage: "collect",
    });
    expect(module.planRecovery?.(runAwaitingRecovery(CONTENT_RESEARCH_DISCOVERY_INTAKE))).toBe(
      null,
    );
    expect(module.planRecovery?.(runAwaitingRecovery(CONTENT_RESEARCH_BACKFILL_INTAKE))).toBe(null);
  });
});

describe("Profile-backed watches (#134)", () => {
  it("refuses to watch a name without a confirmed Profile", () => {
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { host } = makeHarness({ adapters: [rss] });

    expect(() => host.addPerson({})).toThrow(
      new ContentResearchProfileRefusal(
        "profile-required",
        "A watch needs a confirmed Profile id.",
      ),
    );
    expect(() => host.addPerson({ profileId: "person_does_not_exist" })).toThrow(
      new ContentResearchProfileRefusal(
        "profile-not-found",
        "No active Person Profile with that id — create and confirm one before watching.",
      ),
    );
    /* The refusal leaves no half-created watch behind. */
    expect(host.listPeople()).toEqual([]);
  });

  it("backs the watch with the Profile: the name is the public-safe projection's, and one Profile is one watch", () => {
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { host, people } = makeHarness({ adapters: [rss] });

    const person = watchProfile(host, people, { fullName: "Ada Lovelace" });
    expect(person.profileId).toBe(people.get(person.profileId)!.id);
    expect(person.name).toBe("Ada Lovelace");
    expect(person.pausedAt).toBeNull();

    /* Watching the same Profile twice returns the existing watch — the
       confirmed identity, not the name, is the watch's key. Two distinct
       Profiles that happen to share a name are two watches. */
    const again = host.addPerson({ profileId: person.profileId });
    expect(again.id).toBe(person.id);
    const twinProfile = people.create({
      fullName: "Ada Lovelace",
      primaryEmail: "ada.twin@example.com",
    });
    const twin = host.addPerson({ profileId: twinProfile.id });
    expect(twin.id).not.toBe(person.id);
    expect(host.listPeople()).toHaveLength(2);
  });

  it("approving a Person Suggestion requires selecting a confirmed Profile first", async () => {
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const discoverer: PeopleDiscoverer = {
      discover: async () => [
        {
          name: "Grace Hopper",
          reason: "co-mentioned with Ada",
          supportingUrls: ["https://grace.example/post"],
          relationshipToBrand: "peer",
          source: "llm-public-search",
        },
      ],
    };
    const { host, people } = makeHarness({ adapters: [rss], discoverer });
    watchProfile(host, people, { fullName: "Ada Lovelace" });
    await host.discoverNow();
    await host.idle();
    const [suggestion] = host.listSuggestions();

    /* A name-only approval creates nothing: the decision is refused until a
       Profile is selected or created and confirmed. */
    expect(() => host.decideSuggestion(suggestion.id, "approved", null)).toThrow(
      ContentResearchProfileRefusal,
    );
    expect(() =>
      host.decideSuggestion(suggestion.id, "approved", null, "person_does_not_exist"),
    ).toThrow(ContentResearchProfileRefusal);
    expect(suggestion.state).toBe("pending");
    expect(host.listPeople()).toHaveLength(1);
    const profile = people.create({ fullName: "Grace Hopper" });
    const approved = host.decideSuggestion(suggestion.id, "approved", null, profile.id);
    expect(approved.state).toBe("approved");
    const watched = host.listPeople().find((p) => p.profileId === profile.id);
    expect(watched?.name).toBe("Grace Hopper");
    expect(watched?.discoveredSourceTargets.map((t) => t.url)).toEqual(["https://grace.example/"]);
  });

  it("each Run pins the exact Profile revision and public-safe projection it used", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const { runs, host, people } = makeHarness({ adapters: [rss] });
    watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set("ben", [
      makeItem({ url: "https://ben.example/a", title: "A", adapterId: "rss" }),
    ]);

    const first = await host.researchNow();
    await host.idle();
    const firstResult = JSON.parse(runs.open(first)!.readArtifact("result.json")!) as {
      profilePins: {
        personId: string;
        profileId: string;
        profileRevision: number;
        projection: { purpose: string; profileRevision: number; fullName: string | null };
      }[];
    };
    expect(firstResult.profilePins).toHaveLength(1);
    const pin = firstResult.profilePins[0];
    expect(pin.profileId).toMatch(/^person_/);
    expect(pin.profileRevision).toBe(1);
    expect(pin.projection.purpose).toBe("public-safe");
    expect(pin.projection.fullName).toBe("Ben");

    /* A correction files a new revision; the next Run pins that exact revision
       and its projection, not whatever is current when the report is read. */
    people.correct(pin.profileId, { fullName: "Benjamin" });
    perPerson.set("ben", []);
    const second = await host.researchNow();
    await host.idle();
    const secondResult = JSON.parse(runs.open(second)!.readArtifact("result.json")!) as {
      profilePins: {
        profileRevision: number;
        projection: { profileRevision: number; fullName: string | null };
      }[];
    };
    expect(secondResult.profilePins[0].profileRevision).toBe(2);
    expect(secondResult.profilePins[0].projection.fullName).toBe("Benjamin");
    /* The first Run's pin is untouched history. */
    expect(firstResult.profilePins[0].projection.fullName).toBe("Ben");
  });

  it("a Run skips a person whose Profile is no longer projectable and still completes", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const { runs, host, people } = makeHarness({ adapters: [rss] });
    const ben = watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({ url: "https://ben.example/a", title: "A", adapterId: "rss" }),
    ]);

    people.archive(ben.profileId);
    const runId = await host.researchNow();
    await host.idle();

    expect(runs.open(runId)?.read().status).toBe("done");
    const events = runs.detail(runId)!.events.map((event) => event.type);
    expect(events).toContain("profile_projection_unavailable");
    const result = JSON.parse(runs.open(runId)!.readArtifact("result.json")!) as {
      reports: unknown[];
      profilePins: unknown[];
    };
    expect(result.reports).toEqual([]);
    expect(result.profilePins).toEqual([]);
  });

  it("pausing a watch stops its collection without touching its baseline, and resume reactivates it", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const { runs, host, people } = makeHarness({ adapters: [rss] });
    const ben = watchProfile(host, people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({ url: "https://ben.example/a", title: "A", adapterId: "rss" }),
    ]);

    const first = await host.researchNow();
    await host.idle();
    expect(readResult(runs, first).reports).toHaveLength(1);

    host.pauseWatch(ben.id);
    perPerson.set(ben.id, [
      makeItem({ url: "https://ben.example/b", title: "B", adapterId: "rss" }),
    ]);
    const second = await host.researchNow();
    await host.idle();
    expect(readResult(runs, second).reports).toEqual([]);
    expect(host.listPeople()).toEqual([]); /* paused watches are not scheduled */
    expect(host.listAllPeople().find((p) => p.id === ben.id)?.pausedAt).not.toBeNull();

    host.resumeWatch(ben.id);
    expect(host.listPeople()).toHaveLength(1);
  });
  it("post-reset: a clean Workspace opens a new ledger Sheet; old remote outputs are neither cleared nor reconciled", async () => {
    const perPerson = new Map<string, SourceItem[]>();
    const rss = makeAdapter({ id: "rss", itemsFor: (pid) => perPerson.get(pid) ?? [] });
    const sheets = makeSheets();
    const before = makeHarness({ adapters: [rss], sheets });
    const ben = watchProfile(before.host, before.people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set(ben.id, [
      makeItem({ url: "https://ben.example/a", title: "A", adapterId: "rss" }),
    ]);
    await before.host.researchNow();
    await before.host.idle();
    expect(sheets.createdCount()).toBe(1);

    /* A reset Workspace holds no ledger reference, so the next Run asks for a
       clean new Sheet and seeds it from the Run's own rows — it never reaches
       back into the old spreadsheet to clear or reconcile it. */
    const after = makeHarness({ adapters: [rss], sheets });
    const benAfter = watchProfile(after.host, after.people, {
      fullName: "Ben",
      handleHints: { blogRssHints: ["https://ben.example/feed"] },
    });
    perPerson.set(benAfter.id, [
      makeItem({ url: "https://ben.example/a", title: "A", adapterId: "rss" }),
    ]);
    await after.host.researchNow();
    await after.host.idle();

    expect(sheets.createdCount()).toBe(2);
    /* The new Sheet was populated from this Run; nothing was written twice. */
    expect(sheets.appended.at(-1)).toHaveLength(1);
  });

  it("a pre-#134 watch row without pausedAt/profileId keys is still an active watch", async () => {
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { runs, host, people, workspaceDir } = makeHarness({ adapters: [rss] });
    /* A people.json row persisted before #134 carries neither profileId nor
       pausedAt; the upgrade must not silently un-watch it (#134 review P1). */
    mkdirSync(join(workspaceDir, "content-research"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "content-research", "people.json"),
      `${JSON.stringify(
        {
          people: [
            {
              id: "person_legacy",
              name: "Legacy Watch",
              handleHints: { blogRssHints: [] },
              discoveredSourceTargets: [],
              createdAt: "2026-08-01T00:00:00.000Z",
              archivedAt: null,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    expect(host.listPeople().map((p) => p.name)).toContain("Legacy Watch");
    const repointTarget = people.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
    });

    /* The Run completes and surfaces the missing Profile as a decision, not a
       silent skip of the whole watchlist. */
    const runId = await host.researchNow();
    await host.idle();
    expect(runs.open(runId)?.read().status).toBe("done");
    expect(runs.detail(runId)!.events.map((event) => event.type)).toContain(
      "profile_projection_unavailable",
    );

    /* Pausing works. Resuming through the host is refused — resuming is
       re-activation, and activation requires a confirmed Profile (#134 AC1);
       the typed refusal says to re-point or archive. The row itself remains
       resumable at the store seam once a Profile is selected. */
    host.pauseWatch("person_legacy");
    expect(host.listPeople()).toEqual([]);
    expect(() => host.resumeWatch("person_legacy")).toThrow(ContentResearchProfileRefusal);
    host.repointWatch("person_legacy", repointTarget.id);
    host.resumeWatch("person_legacy");
    expect(host.listPeople().map((p) => p.name)).toContain("Legacy Watch");
  });

  it("a paused watch can be re-pointed at a different confirmed Profile (#134 review P3)", async () => {
    const rss = makeAdapter({ id: "rss", itemsFor: () => [] });
    const { host, people } = makeHarness({ adapters: [rss] });
    const ben = watchProfile(host, people, { fullName: "Ben" });
    const graceProfile = people.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
    });

    host.pauseWatch(ben.id);

    /* Re-pointing is the resolution action a paused watch discloses; it
       requires a confirmed target Profile and a paused watch. */
    expect(() => host.repointWatch(ben.id, "person_does_not_exist")).toThrow(
      ContentResearchProfileRefusal,
    );
    const repointed = host.repointWatch(ben.id, graceProfile.id);
    expect(repointed.profileId).toBe(graceProfile.id);
    expect(repointed.pausedAt).not.toBeNull();

    /* Resume then resolves through the new Profile. */
    host.resumeWatch(ben.id);
    const resumed = host.listPeople().find((p) => p.id === ben.id)!;
    expect(resumed.profileId).toBe(graceProfile.id);

    /* An active watch cannot be re-pointed: pause it first. */
    const adaProfile = people.create({ fullName: "Ada Lovelace", primaryEmail: "ada@example.com" });
    expect(() => host.repointWatch(ben.id, adaProfile.id)).toThrow(/pause it before re-pointing/);
  });
});
