import { JSDOM } from "jsdom";
import type { SourceItem } from "@chief-of-staff-demo/shared";
import type { SourceAdapter } from "../../../source-adapters/source-adapter.js";
import {
  canonicalUrl,
  publicHttpFetch,
  type PublicHttpFetch,
} from "../../../source-adapters/http.js";

/** Bounded per-item enrichment budget for one known Substack post. */
const SUBSTACK_MEDIA_LIMIT = 12;

const SUBSTACK_HOST = "substack.com";
const SUBSTACK_CDN_HOST = "substackcdn.com";

function knownSubstackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return host === SUBSTACK_HOST || host.endsWith(`.${SUBSTACK_HOST}`);
  } catch {
    return false;
  }
}

function substackMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return host === SUBSTACK_CDN_HOST || host.endsWith(`.${SUBSTACK_CDN_HOST}`);
  } catch {
    return false;
  }
}

function dedupeMedia(media: SourceItem["media"]): SourceItem["media"] {
  const seen = new Set<string>();
  const bounded: SourceItem["media"] = [];
  for (const entry of media) {
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    bounded.push(entry);
    if (bounded.length >= SUBSTACK_MEDIA_LIMIT) break;
  }
  return bounded;
}

function publishedFromPage(value: string | null): string | null {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

/** Public publication evidence present in the page itself: canonical URL, author, and
 *  published time. A page without any of them still yields the feed text unchanged. */
function publicationEvidence(
  item: SourceItem,
  document: Document,
  responseUrl: string,
  retrievedAt: string,
): Pick<SourceItem, "canonicalUrl" | "author" | "publishedAt" | "evidence"> {
  const meta = (property: string) =>
    document.querySelector<HTMLMetaElement>(property)?.content ?? null;
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? null;
  const published = publishedFromPage(meta('meta[property="article:published_time"]'));
  const author =
    meta('meta[name="author"]') ??
    document.querySelector<HTMLElement>("[data-testid='post-author']")?.textContent.trim() ??
    null;
  return {
    canonicalUrl: canonicalUrl(canonical ?? meta('meta[property="og:url"]') ?? responseUrl),
    author: author ?? item.author,
    publishedAt: published ?? item.publishedAt,
    evidence: [...item.evidence, { route: responseUrl, retrievedAt }],
  };
}

function pageMedia(item: SourceItem, document: Document, responseUrl: string): SourceItem["media"] {
  const media: SourceItem["media"] = [];
  for (const source of document.querySelectorAll<HTMLSourceElement>("audio source, video source")) {
    if (source.src) media.push({ type: "audio", url: source.src });
  }
  for (const element of document.querySelectorAll<HTMLAudioElement | HTMLVideoElement>(
    "audio[src], video[src]",
  )) {
    if (element.src)
      media.push({
        type: element.tagName.toLowerCase() === "video" ? "video" : "audio",
        url: element.src,
      });
  }
  for (const element of document.querySelectorAll<HTMLImageElement>("img")) {
    if (element.src && substackMediaUrl(element.src))
      media.push({ type: "image", url: element.src });
  }
  if (media.length === 0 && substackMediaUrl(responseUrl)) {
    media.push({ type: "image", url: responseUrl });
  }
  return dedupeMedia([...item.media, ...media]);
}

/**
 * Selective enrichment for known public Substack posts collected through the shared
 * RSS/Atom route. It adds bounded public media and platform publication evidence from
 * the post's own page; a page that fails, blocks, or rate-limits leaves the feed text
 * untouched and the media field labeled failed rather than available.
 */
export class SubstackEnrichmentAdapter implements SourceAdapter {
  readonly id = "substack" as const;
  readonly state = "available" as const;
  readonly version = "substack-public-page-v1";

  constructor(
    private readonly fetchText: PublicHttpFetch = publicHttpFetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Collection stays on the shared RSS/Atom route; this adapter only enriches. */
  supports(): boolean {
    return false;
  }

  async collect(): Promise<never> {
    throw new Error(
      "The Substack enrichment adapter collects nothing: Substack posts arrive through the shared RSS/Atom route.",
    );
  }

  async enrich(items: SourceItem[]): Promise<SourceItem[]> {
    const known = items.filter((item) => knownSubstackUrl(item.canonicalUrl));
    if (known.length === 0) return items;
    return await Promise.all(
      known.map(async (item) => {
        const startedAt = this.now().toISOString();
        try {
          const response = await this.fetchText(item.canonicalUrl, {
            etag: null,
            lastModified: null,
          });
          if (response.status < 200 || response.status >= 300) {
            return this.unavailable(item, startedAt, response.url, [`HTTP ${response.status}`]);
          }
          if (!response.body.trim()) {
            return this.unavailable(item, startedAt, response.url, [
              "The public post page returned no content.",
            ]);
          }
          const document = new JSDOM(response.body, { url: response.url }).window.document;
          const media = pageMedia(item, document, response.url);
          const evidence = publicationEvidence(item, document, response.url, startedAt);
          return {
            ...item,
            canonicalUrl: evidence.canonicalUrl,
            author: evidence.author,
            publishedAt: evidence.publishedAt,
            media,
            evidence: evidence.evidence,
            completeness: {
              ...item.completeness,
              media: media.length > 0 ? "available" : "unavailable",
            },
          };
        } catch (error) {
          return this.unavailable(item, startedAt, item.canonicalUrl, [
            error instanceof Error ? error.message : String(error),
          ]);
        }
      }),
    );
  }

  private unavailable(
    item: SourceItem,
    startedAt: string,
    route: string,
    causeChain: string[],
  ): SourceItem {
    return {
      ...item,
      media: [],
      evidence: [...item.evidence, { route, retrievedAt: startedAt }],
      completeness: { ...item.completeness, media: "failed" },
      claims: [
        ...(item.claims ?? []),
        {
          text: `Optional Substack enrichment failed for ${item.canonicalUrl}: ${causeChain.join("; ")}.`,
          state: "unsupported",
          sourceUrls: [item.canonicalUrl],
        },
      ],
    };
  }
}
