import { publicHttpFetch, type PublicHttpFetch } from "./http.js";

export interface DiscoveredFeed {
  url: string;
  title: string | null;
}

/**
 * The feeds one site publishes about itself. Given a site URL, returns the RSS
 * and Atom feeds it declares — nothing is guessed from a URL pattern, so a site
 * that declares no feed yields none rather than a plausible-looking 404.
 */
export type FeedDiscoverer = (siteUrl: string) => Promise<DiscoveredFeed[]>;

const LINK_TAG = /<link\b[^>]*>/gi;
const ATTRIBUTE = /([a-z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const FEED_TYPES = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/feed+json",
  "application/json",
]);

function attributesOf(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const [, name, , doubleQuoted, singleQuoted, bare] = match;
    if (name) attributes[name.toLowerCase()] = doubleQuoted ?? singleQuoted ?? bare ?? "";
  }
  return attributes;
}

/**
 * `<link rel="alternate" type="application/rss+xml" href="...">` — how a site
 * names its own feeds (spec #116 story 2). Relative hrefs resolve against the
 * URL the response actually came from, so a redirect to the canonical host does
 * not produce a feed URL on the host we started at.
 */
export function feedsDeclaredIn(html: string, baseUrl: string): DiscoveredFeed[] {
  const found: DiscoveredFeed[] = [];
  const seen = new Set<string>();
  for (const [tag] of html.matchAll(LINK_TAG)) {
    const attributes = attributesOf(tag);
    const rel = (attributes.rel ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("alternate")) continue;
    if (!FEED_TYPES.has((attributes.type ?? "").toLowerCase())) continue;
    const href = attributes.href;
    if (!href) continue;
    let resolved: string;
    try {
      resolved = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    found.push({ url: resolved, title: attributes.title ?? null });
  }
  return found;
}

export function createFeedDiscoverer(fetchText: PublicHttpFetch = publicHttpFetch): FeedDiscoverer {
  return async (siteUrl) => {
    const response = await fetchText(siteUrl);
    if (response.status !== 200) return [];
    const contentType = (response.contentType ?? "").toLowerCase();
    /* Pointing feed discovery at a feed is not an error — the feed is the answer. */
    if (/xml|rss|atom/.test(contentType) && !contentType.includes("html")) {
      return [{ url: response.url, title: null }];
    }
    return feedsDeclaredIn(response.body, response.url);
  };
}
