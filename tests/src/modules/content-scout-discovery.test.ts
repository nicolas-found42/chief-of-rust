import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SourceSuggestion } from "@chief-of-staff-demo/shared";
import { ContentScoutHost } from "../../../apps/server/src/modules/content-scout/host";
import { PublicRouteSourceDiscoverer } from "../../../apps/server/src/modules/content-scout/discoverer";
import type {
  OpportunityRanker,
  SourceDiscoverer,
} from "../../../apps/server/src/modules/content-scout/ports";
import type { SourceAdapter } from "../../../apps/server/src/source-adapters/source-adapter";
import type {
  PublicHttpFetch,
  PublicHttpResponse,
} from "../../../apps/server/src/source-adapters/http";
import { openRuns } from "../../../apps/server/src/runs";

const NOW = new Date("2026-08-25T12:00:00.000Z");

type DiscoveryProposal = Omit<
  SourceSuggestion,
  "id" | "state" | "discoveredAt" | "decisionReason" | "sourceTargetId"
>;

const noOpRanker: OpportunityRanker = {
  async rank() {
    return [];
  },
};

function noOpAdapters(): SourceAdapter[] {
  return [];
}

function htmlResponse(body: string, url: string): PublicHttpResponse {
  return {
    url,
    status: 200,
    contentType: "text/html",
    etag: null,
    lastModified: null,
    retryAfter: null,
    body,
  };
}

/** A fetch that serves one page per configured URL and fails anything else. */
function pageFetch(pages: Partial<Record<string, string>>): PublicHttpFetch {
  return async (url) => {
    const exact = pages[url];
    if (exact !== undefined) return htmlResponse(exact, url);
    const canonical = new URL(url);
    canonical.hash = "";
    const byPath = Object.entries(pages).find(([candidate]) => {
      const parsed = new URL(candidate);
      return parsed.hostname === canonical.hostname && parsed.pathname === canonical.pathname;
    });
    const byPathBody = byPath?.[1];
    if (byPathBody !== undefined) return htmlResponse(byPathBody, url);
    throw new Error(`unexpected fetch: ${url}`);
  };
}

const PROFILE =
  "# Brand Profile\n\n## Positioning\nPractical, educational guidance for operators.\n";

/** One approved target whose page carries every discoverable route at once. */
const TARGET_URL = "https://news.example/updates";

const ALL_ROUTES_PAGE = `<!doctype html>
<html>
  <body>
    <h1>Approved newsroom</h1>
    <a href="https://other.example/story" aria-label="Practical guide to operators">An outbound story</a>
    <div class="related"><a href="https://related.example/topic">Related topic</a></div>
    <blockquote><a href="https://cited.example/report">Cited report</a></blockquote>
    <a rel="mention" href="https://mentioned.example/profile">Mentioned profile</a>
    <a rel="tag" href="https://tags.example/operator-tools">Operator tools</a>
    <div class="guests"><a href="https://guest.example/profile">Jane Guest</a></div>
    <a rel="repost" href="https://boosted.example/channel">Boosted channel</a>
    <nav class="blogroll"><a href="https://blogroll.example/journal">Journal</a></nav>
    <a rel="author" href="https://author.example/about">Author page</a>
    <meta name="author" content="https://meta-author.example/about" />
    <a href="/same-origin">internal link</a>
    <a href="mailto:editor@example.com">mail</a>
    <a href="https://news.example/updates">self link</a>
  </body>
</html>`;

function brandProfileFor(host: ContentScoutHost): void {
  host.acceptBrandProfile({
    markdown: PROFILE,
    sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
  });
}

function searchHtml(links: string[]): string {
  return `<!doctype html>
<html>
  <body>
    ${links
      .map((href, index) => `<a class="result__a" href="${href}">Search result ${index}</a>`)
      .join("\n")}
  </body>
</html>`;
}

function brandProfile() {
  return {
    id: "brand-1",
    createdAt: NOW.toISOString(),
    markdown: PROFILE,
    sourceScan: { websiteUrl: "https://company.example", includedUrls: [], excludedUrls: [] },
    note: null,
    changedSections: [],
    siteBaselineMarkdown: PROFILE,
  };
}

function sourceTarget(url: string, id: string) {
  return {
    id,
    adapterId: "website",
    label: "Approved source",
    url,
    state: "active" as const,
    createdAt: NOW.toISOString(),
    archivedAt: null,
    checkpoint: null,
    lastSuccessfulAt: null,
    conditional: null,
  };
}

describe("Source Discovery evidence routes", () => {
  it("proposes sources from every supported page route with specific provenance", async () => {
    const fetchText = pageFetch({ [TARGET_URL]: ALL_ROUTES_PAGE });
    const discoverer = new PublicRouteSourceDiscoverer(
      fetchText,
      (query) => `https://search.example/?q=${encodeURIComponent(query)}`,
    );
    const suggestions = await discoverer.discover({
      brandProfile: brandProfile(),
      approvedTargets: [sourceTarget(TARGET_URL, "source-1")],
    });

    const byUrl = new Map(suggestions.map((suggestion) => [suggestion.url, suggestion]));
    expect(byUrl.get("https://other.example/story")).toMatchObject({
      discoveredBecause: "Linked from an approved public Source Target.",
      evidenceUrls: [TARGET_URL],
      similarityFactors: expect.arrayContaining([
        "Brand Profile term: practical",
        "Brand Profile term: operators",
      ]),
    });
    expect(byUrl.get("https://related.example/topic")).toMatchObject({
      discoveredBecause: "Recommended or related on an approved public Source Target.",
      evidenceUrls: [TARGET_URL],
      similarityFactors: ["Related recommendation from an approved source"],
    });
    expect(byUrl.get("https://cited.example/report")).toMatchObject({
      discoveredBecause: "Cited by an approved public Source Target.",
      evidenceUrls: [TARGET_URL],
      similarityFactors: ["Cited source within approved material"],
    });
    expect(byUrl.get("https://mentioned.example/profile")).toMatchObject({
      discoveredBecause: "Mentioned by an approved public Source Target.",
      evidenceUrls: [TARGET_URL],
      similarityFactors: ["Mentioned within approved material"],
    });
    expect(byUrl.get("https://tags.example/operator-tools")).toMatchObject({
      discoveredBecause: "Tagged topic on an approved public Source Target.",
      evidenceUrls: [TARGET_URL],
      similarityFactors: ["Tag: Operator tools"],
    });
    expect(byUrl.get("https://guest.example/profile")).toMatchObject({
      discoveredBecause: "Guest on an approved public Source Target.",
      evidenceUrls: [TARGET_URL],
      similarityFactors: ["Guest contributor on an approved source"],
    });
    expect(byUrl.get("https://boosted.example/channel")).toMatchObject({
      discoveredBecause: "Reposted or boosted from an approved public Source Target.",
      evidenceUrls: [TARGET_URL],
      similarityFactors: ["Reposted or boosted by an approved source"],
    });
    expect(byUrl.get("https://blogroll.example/journal")).toMatchObject({
      discoveredBecause: "Listed in an approved public Source Target's blogroll.",
      evidenceUrls: [TARGET_URL],
      similarityFactors: ["Curated link from an approved source"],
    });
    expect(byUrl.get("https://author.example/about")).toMatchObject({
      discoveredBecause: "Author of an approved public Source Target.",
      evidenceUrls: [TARGET_URL],
      similarityFactors: ["Same author as an approved source"],
    });
    expect(byUrl.get("https://meta-author.example/about")).toMatchObject({
      discoveredBecause: "Author of an approved public Source Target.",
      evidenceUrls: [TARGET_URL],
      similarityFactors: ["Same author as an approved source"],
    });
    // Internal links, self links and non-HTTP URLs are never proposed.
    expect(byUrl.has("https://news.example/same-origin")).toBe(false);
    expect(byUrl.has("mailto:editor@example.com")).toBe(false);
    expect(suggestions.every((suggestion) => suggestion.evidenceUrls.length > 0)).toBe(true);
    expect(suggestions.every((suggestion) => suggestion.similarityFactors.length > 0)).toBe(true);
  });

  it("uses public search results for similar domains and Brand Profile categories", async () => {
    const fetched: string[] = [];
    const fetchText: PublicHttpFetch = async (url) => {
      fetched.push(url);
      if (url.startsWith("https://search.example/")) {
        const query = new URL(url).searchParams.get("q") ?? "";
        return htmlResponse(
          searchHtml(
            query.startsWith("similar sites to")
              ? ["https://similar-domain.example/journal"]
              : ["https://category-source.example/feed"],
          ),
          url,
        );
      }
      return htmlResponse(ALL_ROUTES_PAGE, url);
    };
    const discoverer = new PublicRouteSourceDiscoverer(
      fetchText,
      (query) => `https://search.example/?q=${encodeURIComponent(query)}`,
    );
    const suggestions = await discoverer.discover({
      brandProfile: brandProfile(),
      approvedTargets: [sourceTarget(TARGET_URL, "source-1")],
    });

    const searchFetches = fetched.filter((url) => url.startsWith("https://search.example/"));
    const searchQueries = searchFetches.map((url) =>
      (new URL(url).searchParams.get("q") ?? "").toLowerCase(),
    );
    expect(searchFetches.length).toBeGreaterThan(0);
    expect(searchQueries.some((query) => query.includes("news.example"))).toBe(true);
    expect(searchQueries.some((query) => query.includes("practical"))).toBe(true);
    expect(searchQueries.some((query) => query.includes("educational"))).toBe(true);
    const similarDomain = suggestions.find(
      (suggestion) => suggestion.url === "https://similar-domain.example/journal",
    );
    expect(similarDomain).toMatchObject({
      discoveredBecause: expect.stringContaining("Public search result for a domain"),
      evidenceUrls: [expect.stringContaining("https://search.example/?q=")],
      similarityFactors: [expect.stringContaining("Similar domain query")],
    });
    const categorySource = suggestions.find(
      (suggestion) => suggestion.url === "https://category-source.example/feed",
    );
    expect(categorySource).toMatchObject({
      discoveredBecause: expect.stringContaining("Brand Profile category"),
      evidenceUrls: [expect.stringContaining("https://search.example/?q=")],
      similarityFactors: [expect.stringContaining("Brand Profile category query")],
    });
  });

  it("searches the Brand Profile business domain instead of delivery-method differentiators", async () => {
    const fetched: string[] = [];
    const fetchText: PublicHttpFetch = async (url) => {
      fetched.push(url);
      if (url.startsWith("https://search.example/")) return htmlResponse(searchHtml([]), url);
      return htmlResponse("<!doctype html><html><body></body></html>", url);
    };
    const discoverer = new PublicRouteSourceDiscoverer(
      fetchText,
      (query) => `https://search.example/?q=${encodeURIComponent(query)}`,
    );

    await discoverer.discover({
      brandProfile: {
        ...brandProfile(),
        markdown: `# Brand Profile

## Positioning
AI-driven growth for founders and executives.

## Differentiators
Hands-on practical keyboard training rather than abstract theoretical lectures.

## Content themes
Executive AI education, business workflow automation, and SaaS growth.`,
      },
      approvedTargets: [sourceTarget(TARGET_URL, "source-1")],
    });

    const queries = fetched
      .filter((url) => url.startsWith("https://search.example/"))
      .map((url) => new URL(url).searchParams.get("q") ?? "");
    expect(queries.some((query) => /executive AI education/i.test(query))).toBe(true);
    expect(queries.every((query) => !/hands-on practical keyboard/i.test(query))).toBe(true);
  });

  it("isolates a partial route failure and a missing target from the other routes", async () => {
    const failingPage = `<!doctype html>
<html><body><div class="related"><a href="https://related.example/topic">Related</a></div></body></html>`;
    const pages = {
      [TARGET_URL]: failingPage,
      "https://broken.example/feed": `<!doctype html>
<html><body><div class="guests"><a href="https://guest.example/profile">Guest</a></div></body></html>`,
    };
    const fetchText = pageFetch(pages);
    const discoverer = new PublicRouteSourceDiscoverer(
      fetchText,
      (query) => `https://search.example/?q=${encodeURIComponent(query)}`,
    );
    const suggestions = await discoverer.discover({
      brandProfile: brandProfile(),
      approvedTargets: [
        sourceTarget(TARGET_URL, "source-1"),
        sourceTarget("https://missing.example/feed", "source-2"),
        sourceTarget("https://broken.example/feed", "source-3"),
      ],
    });

    // The failing page still yields its related route; the missing target is skipped;
    // the broken target's guest route still yields its proposal.
    expect(suggestions.map((suggestion) => suggestion.url)).toEqual(
      expect.arrayContaining(["https://related.example/topic", "https://guest.example/profile"]),
    );
  });

  it("deduplicates a candidate discovered through multiple routes and never proposes approved targets", async () => {
    const page = `<!doctype html>
<html><body>
  <div class="related"><a href="https://shared.example/spot">Related spot</a></div>
  <blockquote><a href="https://shared.example/spot">Cited spot</a></blockquote>
  <a href="https://news.example/updates">self</a>
  <a href="https://already-approved.example/feed">already approved</a>
</body></html>`;
    const fetchText = pageFetch({ [TARGET_URL]: page });
    const discoverer = new PublicRouteSourceDiscoverer(
      fetchText,
      (query) => `https://search.example/?q=${encodeURIComponent(query)}`,
    );
    const suggestions = await discoverer.discover({
      brandProfile: brandProfile(),
      approvedTargets: [
        sourceTarget(TARGET_URL, "source-1"),
        sourceTarget("https://already-approved.example/feed", "source-2"),
      ],
    });

    const shared = suggestions.filter(
      (suggestion) => suggestion.url === "https://shared.example/spot",
    );
    expect(shared).toHaveLength(1);
    // Provenance names the most specific route: the citation explains it better.
    expect(shared[0]?.discoveredBecause).toBe("Cited by an approved public Source Target.");
    expect(
      suggestions.some((suggestion) => suggestion.url === "https://already-approved.example/feed"),
    ).toBe(false);
  });

  it("never fetches candidate pages: evidence stays bounded to approved targets and the search endpoint", async () => {
    const page = `<!doctype html>
<html><body>
  <div class="related"><a href="https://candidate.example/topic">Candidate</a></div>
  <nav class="blogroll"><a href="https://candidate-b.example/journal">Candidate B</a></nav>
</body></html>`;
    const fetched: string[] = [];
    const fetchText: PublicHttpFetch = async (url) => {
      fetched.push(url);
      if (url.startsWith("https://search.example/")) {
        return htmlResponse(searchHtml(["https://candidate-c.example/feed"]), url);
      }
      return htmlResponse(page, url);
    };
    const discoverer = new PublicRouteSourceDiscoverer(
      fetchText,
      (query) => `https://search.example/?q=${encodeURIComponent(query)}`,
    );
    await discoverer.discover({
      brandProfile: brandProfile(),
      approvedTargets: [sourceTarget(TARGET_URL, "source-1")],
    });

    expect(fetched.filter((url) => url.startsWith("https://candidate"))).toEqual([]);
  });
});

describe("ContentScoutHost Source Discovery workflow", () => {
  function makeDiscoverer(): SourceDiscoverer {
    const fetchText = pageFetch({ [TARGET_URL]: ALL_ROUTES_PAGE });
    return new PublicRouteSourceDiscoverer(
      fetchText,
      (query) => `https://search.example/?q=${encodeURIComponent(query)}`,
    );
  }

  function hostWith(
    workspaceDir: string,
    discoverer: SourceDiscoverer = makeDiscoverer(),
  ): ContentScoutHost {
    return new ContentScoutHost({
      runs: openRuns(workspaceDir),
      workspaceDir,
      now: () => NOW,
      adapters: noOpAdapters(),
      ranker: noOpRanker,
      discoverer,
      log: () => undefined,
    });
  }

  it("finishes after saving suggestions and never blocks for approval", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-discovery-finishes-"));
    const runs = openRuns(workspaceDir);
    const host = hostWith(workspaceDir);
    brandProfileFor(host);
    host.addSourceTarget({
      adapterId: "website",
      label: "Approved newsroom",
      url: TARGET_URL,
    });

    const runId = await host.discoverNow();
    await host.idle();

    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("done");
    expect(detail.summary).toContain("Source Suggestion");
    const suggestions = host.listSourceSuggestions();
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((suggestion) => suggestion.state === "proposed")).toBe(true);
    // Nothing is scheduled without approval: only the operator-approved target exists.
    expect(host.listSourceTargets()).toHaveLength(1);
    const saved = JSON.parse(
      runs.open(runId)!.readArtifact("source-suggestions.json")!,
    ) as unknown[];
    expect(saved.length).toBe(suggestions.length);
  });

  it("approves a suggestion into a Source Target, dismisses another, and restores it", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-discovery-decisions-"));
    const host = hostWith(workspaceDir);
    brandProfileFor(host);
    host.addSourceTarget({
      adapterId: "website",
      label: "Approved newsroom",
      url: TARGET_URL,
    });

    await host.discoverNow();
    await host.idle();
    let suggestions = host.listSourceSuggestions();
    expect(suggestions.length).toBeGreaterThan(0);

    const approved = host.decideSourceSuggestion(suggestions[0].id, "approved", "Useful source.");
    expect(approved.state).toBe("approved");
    expect(approved.sourceTargetId).not.toBeNull();
    expect(host.listSourceTargets().some((target) => target.url === approved.url)).toBe(true);

    const dismissed = host.decideSourceSuggestion(suggestions[1].id, "dismissed", "Not relevant.");
    expect(dismissed.state).toBe("dismissed");
    expect(dismissed.decisionReason).toBe("Not relevant.");

    const restored = host.decideSourceSuggestion(dismissed.id, "proposed", null);
    expect(restored.state).toBe("proposed");
    suggestions = host.listSourceSuggestions();
    expect(suggestions.find((suggestion) => suggestion.id === dismissed.id)?.state).toBe(
      "proposed",
    );
  });

  it("keeps dismissed and archived sources excluded from automatic re-suggestion", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-discovery-exclusion-"));
    let discovered: Promise<DiscoveryProposal[]> = Promise.resolve([]);
    const host = hostWith(workspaceDir, {
      discover: () => discovered,
    });
    brandProfileFor(host);
    host.addSourceTarget({
      adapterId: "website",
      label: "Approved newsroom",
      url: TARGET_URL,
    });
    const repeat: DiscoveryProposal = {
      adapterId: "website",
      label: "Repeat candidate",
      url: "https://repeat.example/feed",
      discoveredBecause: "Fixture relationship",
      evidenceUrls: [TARGET_URL],
      similarityFactors: ["Fixture"],
    };

    discovered = Promise.resolve([repeat]);
    await host.discoverNow();
    await host.idle();
    const first = host.listSourceSuggestions();
    expect(first).toHaveLength(1);

    host.decideSourceSuggestion(first[0].id, "dismissed", "Not now.");
    await host.discoverNow();
    await host.idle();
    expect(host.listSourceSuggestions()).toHaveLength(1);

    const archived = host.addSourceTarget({
      adapterId: "website",
      label: "Approved newsroom 2",
      url: "https://news2.example/updates",
    });
    host.setSourceTargetState(archived.id, "archived");
    discovered = Promise.resolve([
      {
        adapterId: "website",
        label: "Archived candidate",
        url: "https://news2.example/updates",
        discoveredBecause: "Fixture relationship",
        evidenceUrls: [TARGET_URL],
        similarityFactors: ["Fixture"],
      },
    ]);
    await host.discoverNow();
    await host.idle();
    expect(host.listSourceSuggestions()).toHaveLength(1);
  });

  it("recovers an orphaned Source Discovery Run after restart", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-discovery-restart-"));
    const runs = openRuns(workspaceDir);
    const first = hostWith(workspaceDir);
    brandProfileFor(first);
    first.addSourceTarget({
      adapterId: "website",
      label: "Approved newsroom",
      url: TARGET_URL,
    });

    // Nothing is suggested or recorded until the recovered Run finishes.
    expect(first.listSourceSuggestions()).toHaveLength(0);
    expect(first.scheduleState().lastSuccessfulDiscoveryPeriod).toBeNull();

    const orphan = runs.create({
      module: "content-scout",
      moduleVersion: 1,
      intake: "source-discovery",
      sourceUrl: null,
      externalId: "2026-W35",
    });
    orphan.started("discover");

    const restarted = hostWith(workspaceDir);
    restarted.start();
    await restarted.idle();
    restarted.stop();

    const detail = runs.detail(orphan.id)!;
    expect(detail.status).toBe("done");
    expect(detail.events.find((event) => event.type === "run_recovered")?.detail).toEqual({
      fromStage: "discover",
      previousStatus: "running",
      reason: "orphaned_discovery_run",
    });
    expect(restarted.listSourceSuggestions().length).toBeGreaterThan(0);
    expect(restarted.scheduleState().lastSuccessfulDiscoveryPeriod).toBe("2026-W35");
  });
});
