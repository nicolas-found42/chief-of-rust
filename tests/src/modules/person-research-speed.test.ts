import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PersonResearchCheckpoint } from "@chief-of-staff-demo/shared";
import { canonicalSourceUrl } from "../../../apps/server/src/source-adapters/source-identity.js";
import { LeadRegistry } from "../../../apps/server/src/person-profile/research-plan.js";
import {
  PersonResearch,
  researchAllowance,
} from "../../../apps/server/src/person-profile/research.js";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";
import { SourceScheduler } from "../../../apps/server/src/person-profile/source-scheduler.js";
import { extractionPassages } from "../../../apps/server/src/person-profile/extraction-passages.js";
import { ExtractionHealth } from "../../../apps/server/src/person-profile/research-policy.js";

const roots: string[] = [];

it("latches an outage at three consecutive failures even if a concurrent call later succeeds", () => {
  const health = new ExtractionHealth(3);
  expect(health.failure()).toBe(false);
  expect(health.failure()).toBe(false);
  expect(health.failure()).toBe(true);
  health.success();
  expect(health.interrupted).toBe(true);
  const recovered = new ExtractionHealth(3);
  recovered.failure();
  recovered.failure();
  recovered.success();
  expect(recovered.failure()).toBe(false);
  expect(recovered.neverAnswered).toBe(false);
});

it("registers person results after an organization result in the same response", async () => {
  const { dossiers, person } = fixture();
  const fetched: string[] = [];
  const research = new PersonResearch({
    dossiers,
    seeds: () => ["Maya"],
    search: async () => [
      {
        url: "https://ror.org/123",
        title: "Organization",
        snippet: "",
        entityType: "organization",
      },
      {
        url: "https://example.com/maya",
        title: "Maya",
        snippet: "maya@example.com",
        entityType: "person",
      },
    ],
    readSource: async (url) => {
      fetched.push(url);
      return read(url);
    },
    complete: async () => empty,
  });
  await research.run(person, researchAllowance());
  expect(fetched).toEqual(["https://example.com/maya"]);
});

it("resumes a legacy retained tracking alias when the pending lead names its canonical destination", async () => {
  const { dossiers, person } = fixture();
  const target = "https://example.com/maya";
  const source = dossiers.retainSource({
    url: `https://www.bing.com/news/apiclick.aspx?url=${encodeURIComponent(target)}&tid=old`,
    text: "maya@example.com retained biography",
    title: "Maya",
    author: null,
    publishedAt: null,
    retrievedAt: new Date().toISOString(),
    family: "example.com",
    sourceClass: "unclassified",
    visibility: "public",
    acquisition: "html",
    completeness: "full",
    access: "retrieved",
    extractionCoverage: "unattempted",
  });
  dossiers.publish(person.id, 0, {
    claims: [],
    works: [],
    expertise: [],
    connections: [],
    sections: [],
    sourceIds: [source.id],
  });
  const fetch = vi.fn(async (url: string) => read(url));
  let saved: PersonResearchCheckpoint | undefined;
  const research = new PersonResearch({
    dossiers,
    search: async () => [],
    readSource: fetch,
    complete: async () => empty,
  });
  await research.run(
    person,
    researchAllowance({
      checkpoint: {
        queries: [],
        pass: 0,
        results: [{ url: target, title: "Maya", snippet: "" }],
        direct: [],
        visited: [],
        linked: [],
        pendingSourceId: source.id,
      },
      saveCheckpoint: (checkpoint) => {
        saved = checkpoint;
      },
    }),
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(saved?.pendingSourceIds).toEqual([]);
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const empty = {
  fullName: null,
  employer: null,
  sourceClass: "primary-artifact",
  author: null,
  publishedAt: null,
  claims: [],
  works: [],
  expertise: [],
  connections: [],
  sections: [],
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "research-speed-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  return {
    dossiers: new PersonDossierStore(root),
    person: people.create({ fullName: "Maya Chen", primaryEmail: "maya@example.com" }),
  };
}
function read(url: string, text = url) {
  return {
    text: `maya@example.com ${text}`,
    capturedAt: null,
    completeness: "full" as const,
    access: "retrieved" as const,
    outboundUrls: [],
    family: "general-discovery" as const,
    route: "fixture",
    upstreamIndex: null,
    publishedAt: null,
    author: null,
    anchors: [],
    provenanceNote: null,
    sourceVersion: null,
    rights: null,
    finalUrl: url,
  };
}

it("selects relevant late passages without losing original citation offsets or exceeding the envelope", () => {
  const { person } = fixture();
  const text =
    "Opening context. ".padEnd(15000, "x") + "x".repeat(60000) + "maya@example.com designed Atlas.";
  const passages = extractionPassages(text, person);
  expect(passages).toHaveLength(4);
  expect(passages[0].offset).toBe(0);
  expect(passages.some((part) => part.text.includes("designed Atlas"))).toBe(true);
  expect(passages.reduce((sum, part) => sum + part.text.length, 0)).toBeLessThanOrEqual(60000);
  for (const part of passages)
    expect(text.slice(part.offset, part.offset + part.text.length)).toBe(part.text);
});

it("collapses Bing aliases while preserving path case and meaningful query parameters", () => {
  const target = "https://news.example.com/Article?id=42&ref=version2";
  const wrapper = (tid: string) =>
    `https://www.bing.com/news/apiclick.aspx?tid=${tid}&url=${encodeURIComponent(target)}`;
  expect(canonicalSourceUrl(wrapper("a"))).toBe(target);
  const leads = new LeadRegistry();
  expect(leads.add({ kind: "url", target: wrapper("a"), origin: "discovery" })?.target).toBe(
    target,
  );
  expect(leads.add({ kind: "url", target: wrapper("b"), origin: "discovery" })).toBeNull();
  expect(
    leads.add({ kind: "url", target: target.replace("Article", "article"), origin: "discovery" }),
  ).not.toBeNull();
  expect(canonicalSourceUrl(`${target}&utm_source=bing#section`)).toBe(target);
  expect(
    canonicalSourceUrl("https://www.bing.com/news/apiclick.aspx?url=javascript:alert(1)"),
  ).toContain("bing.com");
});

it("starts two fast extractions before a slow read settles and checkpoints both in flight", async () => {
  const { dossiers, person } = fixture();
  const slow = deferred();
  const model = deferred();
  const started: string[] = [];
  let checkpoint: PersonResearchCheckpoint | undefined;
  const research = new PersonResearch({
    dossiers,
    seeds: () => ["Maya"],
    search: async () =>
      ["slow", "fast1", "fast2"].map((name) => ({
        url: `https://${name}.example.com/page`,
        title: name,
        snippet: "maya@example.com",
      })),
    readSource: async (url) => {
      if (url.includes("slow")) await slow.promise;
      return read(url);
    },
    complete: async ({ user }) => {
      started.push(user);
      await model.promise;
      return empty;
    },
  });
  const running = research.run(
    person,
    researchAllowance({
      readConcurrency: 3,
      maxModelCalls: 10,
      saveCheckpoint: (value) => {
        checkpoint = value;
      },
    }),
  );
  await vi.waitFor(() => expect(started).toHaveLength(2));
  expect(checkpoint?.pendingSourceIds).toHaveLength(2);
  expect(started.every((text) => !text.includes("slow.example.com"))).toBe(true);
  model.resolve();
  slow.resolve();
  await running;
  expect(checkpoint?.pendingSourceIds).toEqual([]);
});

it("extracts an identical source version once but processes changed text", async () => {
  const { dossiers, person } = fixture();
  const complete = vi.fn(async () => empty);
  const research = new PersonResearch({
    dossiers,
    seeds: () => ["Maya"],
    search: async () =>
      ["a", "b", "c"].map((name) => ({
        url: `https://${name}.example.com/page`,
        title: "Biography",
        snippet: "maya@example.com",
      })),
    readSource: async (url) =>
      read(url, url.includes("c.example") ? "changed version" : "same version"),
    complete,
  });
  const outcome = await research.run(person, researchAllowance());
  expect(complete).toHaveBeenCalledTimes(2);
  expect(
    outcome.operation.leads.filter((lead) => lead.disposition === "deduplicated"),
  ).toHaveLength(1);
});

it("resumes every concurrently retained source after cancellation without fetching it again", async () => {
  const { dossiers, person } = fixture();
  const gate = deferred();
  let active = true;
  let extracting = 0;
  let checkpoint: PersonResearchCheckpoint | undefined;
  const urls = ["https://a.example.com/page", "https://b.example.com/page"];
  const first = new PersonResearch({
    dossiers,
    seeds: () => ["Maya"],
    search: async () => urls.map((url) => ({ url, title: url, snippet: "maya@example.com" })),
    readSource: async (url) => read(url),
    complete: async () => {
      extracting += 1;
      await gate.promise;
      return empty;
    },
  });
  const pending = first.run(
    person,
    researchAllowance({
      active: () => active,
      saveCheckpoint: (value) => {
        checkpoint = value;
      },
    }),
  );
  await vi.waitFor(() => expect(extracting).toBe(2));
  expect(checkpoint?.pendingSourceIds).toHaveLength(2);
  active = false;
  gate.resolve();
  await pending;
  const fetch = vi.fn(async (url: string) => read(url));
  const complete = vi.fn(async () => empty);
  const resumed = new PersonResearch({
    dossiers,
    seeds: () => [],
    search: async () => [],
    readSource: fetch,
    complete,
  });
  await resumed.run(person, researchAllowance({ checkpoint: checkpoint! }));
  expect(fetch).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledTimes(2);
});

it("keeps a changed capture date as a distinct source version even when text is identical", () => {
  const { dossiers } = fixture();
  const input = {
    url: "https://example.com/page",
    title: "Page",
    text: "Same text",
    author: null,
    publishedAt: null,
    retrievedAt: "2026-09-09T00:00:00Z",
    family: "example.com",
    sourceClass: "primary-artifact" as const,
    visibility: "public" as const,
    acquisition: "archive",
    completeness: "full" as const,
    access: "retrieved" as const,
  };
  const old = dossiers.retainSource({ ...input, capturedAt: "2020-01-01T00:00:00Z" });
  const fresh = dossiers.retainSource({ ...input, capturedAt: "2025-01-01T00:00:00Z" });
  expect(old.id).not.toBe(fresh.id);
  expect(old.hash).toBe(fresh.hash);
  expect(old.family).toBe(fresh.family);
});

it("preserves an owner's rejection when an old tracking URL reappears as its canonical destination", async () => {
  const { dossiers, person } = fixture();
  const target = "https://example.com/rejected";
  const source = dossiers.retainSource({
    url: `https://www.bing.com/news/apiclick.aspx?url=${encodeURIComponent(target)}&tid=old`,
    text: "Old text",
    title: "Rejected page",
    author: null,
    publishedAt: null,
    retrievedAt: new Date().toISOString(),
    family: "example.com",
    sourceClass: "primary-artifact",
    visibility: "public",
    acquisition: "html",
    completeness: "full",
    access: "retrieved",
  });
  dossiers.publish(person.id, 0, {
    claims: [],
    works: [],
    expertise: [],
    connections: [],
    sections: [],
    sourceIds: [source.id],
  });
  dossiers.detach(person.id, source.id);
  const fetch = vi.fn(async (url: string) => read(url, "Changed text"));
  const research = new PersonResearch({
    dossiers,
    seeds: () => ["Maya"],
    search: async () => [{ url: target, title: "Page", snippet: "maya@example.com" }],
    readSource: fetch,
    complete: async () => empty,
  });
  const outcome = await research.run(person, researchAllowance());
  expect(fetch).not.toHaveBeenCalled();
  expect(outcome.operation.leads.find((lead) => lead.target === target)?.disposition).toBe(
    "rejected",
  );
});

it("lets another host run while one host has exhausted its slots", async () => {
  const scheduler = new SourceScheduler(3);
  const gate = deferred();
  const started: string[] = [];
  const run = (host: string, id: string) =>
    scheduler.run(`https://${host}/`, "operation", 3, async () => {
      started.push(id);
      if (host === "slow.example") await gate.promise;
    });
  const jobs = [
    run("slow.example", "a"),
    run("slow.example", "b"),
    run("slow.example", "c"),
    run("fast.example", "d"),
  ];
  await vi.waitFor(() => expect(started).toContain("d"));
  expect(started).not.toContain("c");
  gate.resolve();
  await Promise.all(jobs);
});
