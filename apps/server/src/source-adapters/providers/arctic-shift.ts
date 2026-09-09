import { retryAfterMilliseconds } from "../http.js";
import type { PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError } from "./types.js";
import type { SearchProvider, SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;
const TITLE_LIMIT = 200;
const SNIPPET_LIMIT = 400;
const SEARCH_ENDPOINT = "https://arctic-shift.photon-reddit.com/api/posts/search";

/** Keyword search on Arctic Shift only runs scoped to a subreddit or an
 * author (api/README.md: the keyword parameters are "only in use with author
 * or subreddit"), so the query grammar is Reddit's own scope prefix:
 * `r/<sub> <terms>` or `u/<user> <terms>`. */
const SCOPED_QUERY = /^\s*([ru])\/(\S+)\s+(.+?)\s*$/i;

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function postList(value: unknown): unknown[] | null {
  if (isUnknownArray(value)) return value;
  if (typeof value === "object" && value !== null && "data" in value) {
    const data: unknown = value.data;
    return isUnknownArray(data) ? data : null;
  }
  return null;
}

function isArchivePost(
  value: unknown,
): value is { title: unknown; id: unknown; permalink: unknown; selftext: unknown } {
  return typeof value === "object" && value !== null && "id" in value;
}

/**
 * Arctic Shift (ADR-0049, layers 2–3) — the keyless Reddit archive. Keyword
 * search needs the scope above; anything else is a question this archive
 * cannot ask and answers with a clean empty pass, never a request. The API's
 * dynamic rate limit answers 429 (with X-RateLimit-Reset), which refuses as
 * rate-limited so the composite's cooldown does the waiting.
 */
export function createArcticShiftProvider(
  options: { fetch?: PublicHttpFetch } = {},
): SearchProvider {
  return {
    name: "arctic-shift",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const match = SCOPED_QUERY.exec(query);
      if (match === null) return [];
      const scope = match[1];
      const target = match[2];
      const terms = match[3];
      if (scope === undefined || target === undefined || terms === undefined) return [];

      // The archive ignores a u//r/ prefix on its own parameters, so the
      // bare name is what goes on the wire.
      const scopeParam = scope.toLowerCase() === "r" ? "subreddit" : "author";
      const fetch = options.fetch ?? io.fetch;
      const response = await fetch(
        `${SEARCH_ENDPOINT}?${scopeParam}=${encodeURIComponent(target)}&query=${encodeURIComponent(terms)}&limit=8&fields=title,permalink,selftext,id`,
        { timeoutMs: io.timeoutMs },
      );

      if (response.status !== 200) {
        if (response.status === 429 || response.status === 503) {
          throw new ProviderRefusedError(
            "rate-limited",
            `arctic-shift is rate-limited: posts/search answered ${String(response.status)}.`,
            retryAfterMilliseconds(response.retryAfter, new Date()),
          );
        }
        throw new ProviderRefusedError(
          "error",
          `arctic-shift search failed: posts/search answered ${String(response.status)}.`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new ProviderRefusedError("error", "arctic-shift returned an unparseable body");
      }

      const posts = postList(parsed);
      if (posts === null) {
        throw new ProviderRefusedError("error", "arctic-shift returned a malformed posts body");
      }

      const results: PublicSearchResult[] = [];
      for (const entry of posts) {
        if (results.length >= MAX_RESULTS) break;
        if (!isArchivePost(entry)) continue;
        const url = postUrl(entry);
        if (url === null) continue;
        results.push({
          title: (typeof entry.title === "string" ? entry.title : "").trim().slice(0, TITLE_LIMIT),
          url,
          snippet: (typeof entry.selftext === "string" ? entry.selftext : "")
            .trim()
            .slice(0, SNIPPET_LIMIT),
        });
      }
      return results;
    },
  };
}

/** The archive answers permalinks for indexed posts; the id is the fallback
 * and always builds the canonical reddit.com/comments/<id> route. */
function postUrl(post: { id: unknown; permalink: unknown }): string | null {
  if (typeof post.permalink === "string" && post.permalink !== "") {
    try {
      const resolved = new URL(post.permalink, "https://www.reddit.com");
      if (resolved.protocol === "https:" || resolved.protocol === "http:") {
        return resolved.toString();
      }
    } catch {
      // Fall through to the id route.
    }
  }
  return typeof post.id === "string" && post.id !== ""
    ? `https://www.reddit.com/comments/${post.id}`
    : null;
}
