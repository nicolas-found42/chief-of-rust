import { createHttpFetch, retryAfterMilliseconds, type PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;
// ROR canonicalizes institution names for the identity layer (research doc,
// Layer 3) — its `id` field is already the canonical https://ror.org/… URL.
const ENDPOINT = "https://api.ror.org/organizations";

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

export function createRorProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  // ROR 406s the default transport's HTML-first accept list; it serves JSON
  // to an explicit application/json accept (live-verified both ways
  // 2026-09-02). The header is bound at the transport, like ORCID's.
  const fetch = options.fetch ?? createHttpFetch({ headers: { accept: "application/json" } });
  return {
    name: "ror",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const url = `${ENDPOINT}?query=${encodeURIComponent(query)}`;
      const response = await fetch(url, { timeoutMs: io.timeoutMs });
      if (response.status !== 200) {
        const rateLimited = response.status === 429 || response.status === 503;
        throw new ProviderRefusedError(
          rateLimited ? "rate-limited" : "error",
          `ROR answered ${String(response.status)}.`,
          rateLimited ? retryAfterMilliseconds(response.retryAfter, new Date()) : undefined,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new ProviderRefusedError("error", "ROR returned a malformed body.");
      }
      const body = asRecord(parsed);
      if (!body || !Array.isArray(body.items)) {
        throw new ProviderRefusedError("error", "ROR returned an unexpected body shape.");
      }
      const results: PublicSearchResult[] = [];
      for (const entry of body.items.slice(0, MAX_RESULTS)) {
        const record = asRecord(entry);
        if (!record) continue;
        const url = usableUrl(record.id);
        if (!url) continue;
        results.push({ title: clippedText(record.name, 200), url, snippet: "" });
      }
      return results;
    },
  };
}
