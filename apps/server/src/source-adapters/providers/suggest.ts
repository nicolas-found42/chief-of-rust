import type { SearchProviderIo } from "./types.js";

/**
 * The three keyless suggest endpoints the research doc live-verified
 * (docs/research/public-search-providers.md, "Suggest endpoints"): all answer
 * the browser-internal `[query, [suggestions]]` JSON shape in 0.1–0.8 s. They
 * are undocumented surfaces, so this expansion is a multiplier, never a
 * dependency — every failure degrades to contributing nothing.
 */
const SUGGEST_ENDPOINTS = [
  (query: string) =>
    `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`,
  (query: string) => `https://duckduckgo.com/ac/?q=${encodeURIComponent(query)}&type=list`,
  (query: string) => `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(query)}`,
];

/**
 * Query expansion for the composite's second-chance pass (ADR-0049): asks the
 * three suggest endpoints concurrently and merges their unique suggestions.
 * NEVER throws — an endpoint that refuses, times out, or answers with anything
 * unparseable simply contributes nothing; if all three fail the result is `[]`.
 */
export async function fetchSuggestions(query: string, io: SearchProviderIo): Promise<string[]> {
  const settled = await Promise.allSettled(
    SUGGEST_ENDPOINTS.map(async (endpoint) => {
      // The suggest endpoints are fast (documented 0.1–0.8 s); the composite's
      // normal per-request deadline applies — no Wayback-style long timeout.
      const response = await io.fetch(endpoint(query), { timeoutMs: io.timeoutMs });
      if (response.status !== 200) return [];
      // Each endpoint answers `[<the query>, [<suggestion>, ...]]`; a body that
      // is not that shape is treated as a failure of that endpoint only.
      const parsed: unknown = JSON.parse(response.body);
      if (!Array.isArray(parsed) || parsed.length < 2 || !Array.isArray(parsed[1])) return [];
      return parsed[1].filter((entry): entry is string => typeof entry === "string");
    }),
  );

  const seen = new Set<string>([query]);
  const merged: string[] = [];
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue;
    for (const suggestion of outcome.value) {
      if (seen.has(suggestion)) continue;
      seen.add(suggestion);
      merged.push(suggestion);
    }
  }
  return merged.slice(0, 6);
}
