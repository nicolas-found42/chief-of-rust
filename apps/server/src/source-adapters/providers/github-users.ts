import { createHttpFetch, retryAfterMilliseconds, type PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;
// GitHub's unauthenticated search: 10 req/min per IP (research doc, Layer 3).
// The search payload carries only login + profile URL — bios would need a
// per-user core request against the 60 req/h budget, so snippets stay empty.
const ENDPOINT = "https://api.github.com/search/users";

/** An http(s) URL string, or null — a result without a usable URL is dropped, never invented. */
function usableUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function clippedText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

/** Narrows parsed-JSON `unknown` to a keyed record so field reads stay checked. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function createGitHubUsersProvider(
  options: { fetch?: PublicHttpFetch } = {},
): SearchProvider {
  // GitHub's REST API 415s the default transport's HTML-first accept list —
  // it wants its versioned media type (live-verified both ways 2026-09-02).
  const fetch =
    options.fetch ?? createHttpFetch({ headers: { accept: "application/vnd.github+json" } });
  return {
    name: "github-users",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&per_page=${MAX_RESULTS}`;
      const response = await fetch(url, { timeoutMs: io.timeoutMs });
      if (response.status !== 200) {
        const rateLimited = response.status === 429 || response.status === 503;
        throw new ProviderRefusedError(
          rateLimited ? "rate-limited" : "error",
          `GitHub user search answered ${String(response.status)}.`,
          rateLimited ? retryAfterMilliseconds(response.retryAfter, new Date()) : undefined,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new ProviderRefusedError("error", "GitHub user search returned a malformed body.");
      }
      const body = asRecord(parsed);
      if (!body || !Array.isArray(body.items)) {
        throw new ProviderRefusedError(
          "error",
          "GitHub user search returned an unexpected body shape.",
        );
      }
      const results: PublicSearchResult[] = [];
      for (const entry of body.items.slice(0, MAX_RESULTS)) {
        const record = asRecord(entry);
        if (!record) continue;
        const url = usableUrl(record.html_url);
        if (!url) continue;
        // The login IS the title; no follow-up request buys a bio.
        results.push({ title: clippedText(record.login, 200), url, snippet: "" });
      }
      return results;
    },
  };
}
