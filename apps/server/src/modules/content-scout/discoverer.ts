import { JSDOM } from "jsdom";
import type { SourceSuggestion } from "@chief-of-staff-demo/shared";
import type { SourceDiscoverer } from "./ports.js";
import { canonicalUrl, publicHttpFetch, type PublicHttpFetch } from "../../source-adapters/http.js";

const MAX_TARGETS = 20;
const MAX_ANCHORS = 200;
const MAX_ROUTE_CANDIDATES = 25;
const MAX_TOTAL_CANDIDATES = 60;
const MAX_SEARCH_QUERIES = 3;
const MAX_SEARCH_RESULTS = 10;

type DiscoveryProposal = Omit<
  SourceSuggestion,
  "id" | "state" | "discoveredAt" | "decisionReason" | "sourceTargetId"
>;

interface AnchorRoute {
  selector: string;
  externalOnly: boolean;
  discoveredBecause: string;
  similarity: (label: string) => string[];
}

const ANCHOR_ROUTES: readonly AnchorRoute[] = [
  {
    selector: 'a[rel~="author"], a[rel~="me"], link[rel~="author"], link[rel~="me"]',
    externalOnly: false,
    discoveredBecause: "Author of an approved public Source Target.",
    similarity: () => ["Same author as an approved source"],
  },
  {
    selector:
      '[class*="guest"] a[href], [id*="guest"] a[href], [data-guest] a[href], a[href*="/guest/"]',
    externalOnly: false,
    discoveredBecause: "Guest on an approved public Source Target.",
    similarity: () => ["Guest contributor on an approved source"],
  },
  {
    selector: 'blockquote a[href], cite a[href], sup a[href], a[rel~="nofollow"]',
    externalOnly: true,
    discoveredBecause: "Cited by an approved public Source Target.",
    similarity: () => ["Cited source within approved material"],
  },
  {
    selector:
      'a[rel~="mention"], a[class*="mention"], [class*="mention"] a[href], a[href*="/mentions/"]',
    externalOnly: true,
    discoveredBecause: "Mentioned by an approved public Source Target.",
    similarity: () => ["Mentioned within approved material"],
  },
  {
    selector:
      'a[rel~="tag"], a[href*="/tag/"], a[href*="/tags/"], a[href*="/topic/"], a[href*="/topics/"], a[href*="/category/"], a[href*="/categories/"]',
    externalOnly: false,
    discoveredBecause: "Tagged topic on an approved public Source Target.",
    similarity: (label) => (label ? [`Tag: ${label}`] : ["Tag on an approved source"]),
  },
  {
    selector:
      'nav a[href], aside a[href], [class*="blogroll"] a[href], [id*="blogroll"] a[href], [class*="blog-roll"] a[href], [class*="links"] a[href], [id*="links"] a[href]',
    externalOnly: true,
    discoveredBecause: "Listed in an approved public Source Target's blogroll.",
    similarity: () => ["Curated link from an approved source"],
  },
  {
    selector:
      'a[rel~="related"], a[class*="related"], a[id*="related"], a[class*="recommended"], [class*="related"] a[href], [id*="related"] a[href], [class*="recommended"] a[href], [class*="see-also"] a[href], [class*="see_also"] a[href]',
    externalOnly: true,
    discoveredBecause: "Recommended or related on an approved public Source Target.",
    similarity: () => ["Related recommendation from an approved source"],
  },
  {
    selector:
      'a[rel~="repost"], a[rel~="boost"], a[class*="repost"], a[class*="boost"], a[href*="/repost"], a[href*="/boost"]',
    externalOnly: true,
    discoveredBecause: "Reposted or boosted from an approved public Source Target.",
    similarity: () => ["Reposted or boosted by an approved source"],
  },
];

function adapterFor(url: URL): string {
  const host = url.hostname.replace(/^www\./, "");
  if (host === "youtube.com" || host === "youtu.be") return "youtube";
  if (host === "reddit.com") return "reddit";
  if (host === "instagram.com") return "instagram";
  if (host === "tiktok.com") return "tiktok";
  if (host === "linkedin.com") return "linkedin";
  if (host.endsWith("substack.com")) return "substack";
  return "website";
}

/** Brand terms for similarity and search seeds; Markdown headings are structure, not vocabulary. */
function brandKeywords(markdown: string): string[] {
  const body = markdown.replace(/^#{1,6}\s+.*$/gm, "");
  return (
    body
      .toLowerCase()
      .match(/[a-z][a-z-]{4,}/g)
      ?.filter((word, index, words) => words.indexOf(word) === index) ?? []
  );
}

/** Semantic Brand Profile values used as category-level discovery queries. */
function brandCategories(markdown: string): string[] {
  const categorySections = [
    "content themes",
    "customer problems",
    "products",
    "customers",
    "positioning",
  ] as const;
  const categorySectionSet = new Set<string>(categorySections);
  let section = "";
  const valuesBySection = new Map<string, string[]>();
  for (const rawLine of markdown.split("\n")) {
    const heading = rawLine.match(/^#{2,6}\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1]!.trim().toLowerCase();
      continue;
    }
    if (!categorySectionSet.has(section)) continue;
    const phrase = rawLine
      .replace(/^\s*[-*+]\s+/, "")
      .replace(/[*_`#[\]]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.!?]+$/, "")
      .split(" ")
      .slice(0, 10)
      .join(" ");
    if (phrase.length < 8) continue;
    const values = valuesBySection.get(section) ?? [];
    if (!values.includes(phrase)) values.push(phrase);
    valuesBySection.set(section, values);
  }
  return categorySections.flatMap((name) => valuesBySection.get(name) ?? []);
}

function resolveUrl(href: string | null, base: string): URL | null {
  if (!href || !href.trim()) return null;
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

function httpUrl(url: URL): boolean {
  return /^https?:$/.test(url.protocol);
}

function externalTo(url: URL, base: string): boolean {
  return url.origin !== new URL(base).origin;
}

function anchorLabel(element: Element): string {
  return `${element.textContent} ${element.getAttribute("aria-label") ?? ""}`.trim();
}

/**
 * Bounded public-route discovery. It reads only approved active Source Target
 * pages and one public search endpoint; candidate URLs are recorded as
 * evidence and never fetched again. Each route and each target is isolated, so
 * a malformed page or a failed search query never discards the other routes'
 * findings.
 */
export class PublicRouteSourceDiscoverer implements SourceDiscoverer {
  constructor(
    private readonly fetchText: PublicHttpFetch = publicHttpFetch,
    private readonly searchEndpoint: (query: string) => string = (query) =>
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  ) {}

  async discover({ brandProfile, approvedTargets }: Parameters<SourceDiscoverer["discover"]>[0]) {
    const approved = new Set(approvedTargets.map((target) => canonicalUrl(target.url)));
    const candidates = new Map<string, DiscoveryProposal>();
    const add = (proposal: DiscoveryProposal): void => {
      if (candidates.size >= MAX_TOTAL_CANDIDATES) return;
      const canonical = canonicalUrl(proposal.url);
      if (approved.has(canonical) || candidates.has(canonical)) return;
      candidates.set(canonical, {
        ...proposal,
        label: proposal.label.slice(0, 120),
        url: canonical,
      });
    };
    const activeTargets = approvedTargets
      .filter((target) => target.state === "active")
      .slice(0, MAX_TARGETS);
    const keywords = brandKeywords(brandProfile.markdown);
    const categories = brandCategories(brandProfile.markdown);

    const pages: { document: Document; url: string }[] = [];
    for (const target of activeTargets) {
      try {
        const response = await this.fetchText(target.url);
        if (
          response.status < 200 ||
          response.status >= 300 ||
          !/html/i.test(response.contentType ?? "")
        )
          continue;
        pages.push({
          document: new JSDOM(response.body, { url: response.url }).window.document,
          url: response.url,
        });
      } catch {
        // One unavailable target never stops the others (Source Adapter isolation).
      }
    }

    // Most specific routes run first so a URL's provenance names the route that
    // explains it best; the outbound-link route keeps the general case.
    for (const page of pages) {
      for (const route of ANCHOR_ROUTES) {
        try {
          this.collectAnchorRoute(page.document, page.url, route, add);
        } catch {
          // One route's failure never discards the others' findings.
        }
      }
      this.collectMetadataRoutes(page.document, page.url, add);
      this.outboundLinks(page.document, page.url, keywords, add);
      if (candidates.size >= MAX_TOTAL_CANDIDATES) break;
    }

    const searchQueries = [
      ...new Set(
        activeTargets
          .map((target) => {
            try {
              return new URL(target.url).hostname.replace(/^www\./, "");
            } catch {
              return null;
            }
          })
          .filter((hostname): hostname is string => hostname !== null),
      ),
    ];
    await this.searchRoute({
      queries: searchQueries.slice(0, MAX_SEARCH_QUERIES).map((host) => `similar sites to ${host}`),
      discoveredBecause: (query) => `Public search result for a domain ${query}.`,
      similarity: (query) => [`Similar domain query: ${query}`],
      add,
    });
    await this.searchRoute({
      queries: categories.slice(0, MAX_SEARCH_QUERIES).map((category) => `${category} sources`),
      discoveredBecause: (query) => `Public search result in Brand Profile category ${query}.`,
      similarity: (query) => [`Brand Profile category query: ${query}`],
      add,
    });

    return [...candidates.values()];
  }

  private collectAnchorRoute(
    document: Document,
    pageUrl: string,
    route: AnchorRoute,
    add: (proposal: DiscoveryProposal) => void,
  ): void {
    for (const element of [...document.querySelectorAll<Element>(route.selector)].slice(
      0,
      MAX_ROUTE_CANDIDATES,
    )) {
      const url = resolveUrl(element.getAttribute("href"), pageUrl);
      if (!url || !httpUrl(url) || (route.externalOnly && !externalTo(url, pageUrl))) continue;
      const label = anchorLabel(element);
      add({
        adapterId: adapterFor(url),
        label: label || url.hostname,
        url: url.toString(),
        discoveredBecause: route.discoveredBecause,
        evidenceUrls: [pageUrl],
        similarityFactors: route.similarity(label),
      });
    }
  }

  private collectMetadataRoutes(
    document: Document,
    pageUrl: string,
    add: (proposal: DiscoveryProposal) => void,
  ): void {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="author"][content]');
    if (meta) {
      const url = resolveUrl(meta.content.trim(), pageUrl);
      if (url && httpUrl(url)) {
        add({
          adapterId: adapterFor(url),
          label: url.hostname,
          url: url.toString(),
          discoveredBecause: "Author of an approved public Source Target.",
          evidenceUrls: [pageUrl],
          similarityFactors: ["Same author as an approved source"],
        });
      }
    }
    for (const meta of document.querySelectorAll<HTMLMetaElement>(
      'meta[property="og:see_also"][content]',
    )) {
      const url = resolveUrl(meta.content.trim(), pageUrl);
      if (!url || !httpUrl(url) || !externalTo(url, pageUrl)) continue;
      add({
        adapterId: adapterFor(url),
        label: url.hostname,
        url: url.toString(),
        discoveredBecause: "Recommended or related on an approved public Source Target.",
        evidenceUrls: [pageUrl],
        similarityFactors: ["Related recommendation from an approved source"],
      });
    }
  }

  private outboundLinks(
    document: Document,
    pageUrl: string,
    keywords: string[],
    add: (proposal: DiscoveryProposal) => void,
  ): void {
    for (const anchor of [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].slice(
      0,
      MAX_ANCHORS,
    )) {
      const url = resolveUrl(anchor.getAttribute("href"), pageUrl);
      if (!url || !httpUrl(url) || !externalTo(url, pageUrl)) continue;
      const context = anchorLabel(anchor);
      const matches = keywords.filter((word) => context.toLowerCase().includes(word)).slice(0, 4);
      add({
        adapterId: adapterFor(url),
        label: context || url.hostname,
        url: url.toString(),
        discoveredBecause: "Linked from an approved public Source Target.",
        evidenceUrls: [pageUrl],
        similarityFactors:
          matches.length > 0
            ? matches.map((word) => `Brand Profile term: ${word}`)
            : ["Outbound citation from an approved source"],
      });
    }
  }

  private async searchRoute(input: {
    queries: string[];
    discoveredBecause: (query: string) => string;
    similarity: (query: string) => string[];
    add: (proposal: DiscoveryProposal) => void;
  }): Promise<void> {
    for (const query of input.queries) {
      let results: { url: URL; label: string }[];
      try {
        results = await this.search(query);
      } catch {
        // One failed query never stops the others.
        continue;
      }
      for (const result of results.slice(0, MAX_SEARCH_RESULTS)) {
        input.add({
          adapterId: adapterFor(result.url),
          label: result.label || result.url.hostname,
          url: result.url.toString(),
          discoveredBecause: input.discoveredBecause(query),
          evidenceUrls: [this.searchEndpoint(query)],
          similarityFactors: input.similarity(query),
        });
      }
    }
  }

  private async search(query: string): Promise<{ url: URL; label: string }[]> {
    const endpoint = this.searchEndpoint(query);
    const response = await this.fetchText(endpoint);
    if (
      response.status < 200 ||
      response.status >= 300 ||
      !/html/i.test(response.contentType ?? "")
    )
      return [];
    const document = new JSDOM(response.body, { url: response.url }).window.document;
    const results: { url: URL; label: string }[] = [];
    for (const anchor of [
      ...document.querySelectorAll<HTMLAnchorElement>("a.result__a[href]"),
    ].slice(0, MAX_SEARCH_RESULTS)) {
      let url: URL;
      try {
        const parsed = new URL(anchor.getAttribute("href") ?? "", response.url);
        const target = parsed.searchParams.get("uddg");
        url = target ? new URL(target) : parsed;
      } catch {
        continue;
      }
      if (!httpUrl(url)) continue;
      results.push({ url, label: anchorLabel(anchor) });
    }
    return results;
  }
}
