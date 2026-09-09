import { retryAfterMilliseconds, type PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";

/**
 * Spoken-evidence, social and general-discovery providers added for #228.
 *
 * All three families answer anonymously with no key and no account. They sit
 * together because each is a thin normalization over one such endpoint; the
 * record-shaped providers live next door in `person-records.ts`.
 *
 * What is *not* here matters as much: Podcast Index needs an API key and is
 * therefore excluded, and YouTube's anonymous timed-text route now answers an
 * empty body without a proof-of-origin token. Both are recorded as gaps in
 * `docs/research/person-source-eligibility.md` rather than reached for behind
 * a credential.
 */

const MAX_RESULTS = 6;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function text(value: unknown, limit = 300): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

async function json(
  name: string,
  url: string,
  fetch: PublicHttpFetch,
  io: SearchProviderIo,
): Promise<unknown> {
  const response = await fetch(url, { timeoutMs: io.timeoutMs });
  if (response.status !== 200) {
    const rateLimited = response.status === 429 || response.status === 503;
    throw new ProviderRefusedError(
      rateLimited ? "rate-limited" : "error",
      `${name} answered ${String(response.status)}.`,
      rateLimited ? retryAfterMilliseconds(response.retryAfter, new Date()) : undefined,
    );
  }
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new ProviderRefusedError("error", `${name} returned a malformed body.`);
  }
}

/**
 * Sepia Search: the federated PeerTube index.
 *
 * Videos here carry a real description and a public watch URL, and the whole
 * index is readable without an account — the part of the spoken-evidence
 * family that is genuinely open, unlike the large commercial platforms.
 */
export function createPeerTubeProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  return {
    name: "peertube",
    async search(query, io) {
      const body = await json(
        "peertube",
        `https://sepiasearch.org/api/v1/search/videos?search=${encodeURIComponent(query.replace(/["']/g, ""))}&count=${String(MAX_RESULTS)}`,
        options.fetch ?? io.fetch,
        io,
      );
      const data = asRecord(body)?.data;
      if (!Array.isArray(data)) return [];
      const results: PublicSearchResult[] = [];
      for (const entry of data.slice(0, MAX_RESULTS)) {
        const video = asRecord(entry);
        const url = text(video?.url, 2000);
        if (!url.startsWith("http")) continue;
        results.push({
          url,
          title: text(video?.name) || url,
          snippet: [text(video?.description, 400), text(video?.publishedAt, 40)]
            .filter(Boolean)
            .join(" · "),
        });
      }
      return results;
    },
  };
}

/**
 * The Apple podcast directory's public search.
 *
 * It answers anonymously and, crucially, returns each show's RSS feed URL —
 * which is where episode descriptions and `<podcast:transcript>` links live, so
 * one keyless lookup opens the podcast half of the spoken-evidence family.
 */
export function createPodcastDirectoryProvider(
  options: { fetch?: PublicHttpFetch } = {},
): SearchProvider {
  return {
    name: "podcast-directory",
    async search(query, io) {
      const body = await json(
        "podcast-directory",
        `https://itunes.apple.com/search?media=podcast&limit=${String(MAX_RESULTS)}&term=${encodeURIComponent(query.replace(/["']/g, ""))}`,
        options.fetch ?? io.fetch,
        io,
      );
      const entries = asRecord(body)?.results;
      if (!Array.isArray(entries)) return [];
      const results: PublicSearchResult[] = [];
      for (const entry of entries.slice(0, MAX_RESULTS)) {
        const show = asRecord(entry);
        /* The feed, not the store page: the store page is a JavaScript shell,
           while the feed is readable text with dates. */
        const feed = text(show?.feedUrl, 2000);
        if (!feed.startsWith("http")) continue;
        results.push({
          url: feed,
          title: text(show?.collectionName) || feed,
          snippet: [text(show?.artistName, 200), text(show?.primaryGenreName, 80)]
            .filter(Boolean)
            .join(" · "),
        });
      }
      return results;
    },
  };
}

/**
 * Bluesky's public application view.
 *
 * `public.api.bsky.app` serves the app view without authentication, so a
 * person's own account and posts are reachable anonymously. The posts are
 * self-report and the reader records them as such.
 */
export function createBlueskyProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  return {
    name: "bluesky",
    async search(query, io) {
      const body = await json(
        "bluesky",
        `https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors?q=${encodeURIComponent(query.replace(/["']/g, ""))}&limit=${String(MAX_RESULTS)}`,
        options.fetch ?? io.fetch,
        io,
      );
      const actors = asRecord(body)?.actors;
      if (!Array.isArray(actors)) return [];
      const results: PublicSearchResult[] = [];
      for (const entry of actors.slice(0, MAX_RESULTS)) {
        const actor = asRecord(entry);
        const handle = text(actor?.handle, 300);
        if (!handle) continue;
        results.push({
          url: `https://bsky.app/profile/${handle}`,
          title: text(actor?.displayName) || handle,
          snippet: text(actor?.description, 400),
        });
      }
      return results;
    },
  };
}

/**
 * MWMBL: a small, independent, non-commercial web index.
 *
 * It is here for coverage the big crawlers miss rather than for volume, and it
 * needs no key. Its results are ordinary web pages the readers already handle.
 */
export function createMwmblProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  return {
    name: "mwmbl",
    async search(query, io) {
      const body = await json(
        "mwmbl",
        `https://api.mwmbl.org/api/v1/search/?s=${encodeURIComponent(query.replace(/["']/g, ""))}`,
        options.fetch ?? io.fetch,
        io,
      );
      if (!Array.isArray(body)) return [];
      /* MWMBL returns titles and extracts as spans with a bold flag, so the
         readable string has to be reassembled rather than read off a field. */
      const flatten = (value: unknown): string =>
        Array.isArray(value)
          ? value
              .map((span) => text(asRecord(span)?.value, 400))
              .join("")
              .slice(0, 400)
          : text(value, 400);
      const results: PublicSearchResult[] = [];
      for (const entry of body.slice(0, MAX_RESULTS)) {
        const hit = asRecord(entry);
        const url = text(hit?.url, 2000);
        if (!url.startsWith("http")) continue;
        results.push({ url, title: flatten(hit?.title) || url, snippet: flatten(hit?.extract) });
      }
      return results;
    },
  };
}
