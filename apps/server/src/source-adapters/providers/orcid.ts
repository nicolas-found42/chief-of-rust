import { createHttpFetch, retryAfterMilliseconds, type PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;
// ORCID's v3 API answers tokenless but only serves JSON to an explicit accept
// header — the default transport's accept list gets the XML surface (research
// doc, Layer 3, live-verified 200 tokenless). The header is bound at the
// transport because PublicHttpFetch has no per-call header channel.
const ENDPOINT = "https://pub.orcid.org/v3.0/expanded-search";

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

export function createOrcidProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  const fetch = options.fetch ?? createHttpFetch({ headers: { accept: "application/json" } });
  return {
    name: "orcid",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&rows=${MAX_RESULTS}`;
      const response = await fetch(url, { timeoutMs: io.timeoutMs });
      if (response.status !== 200) {
        const rateLimited = response.status === 429 || response.status === 503;
        throw new ProviderRefusedError(
          rateLimited ? "rate-limited" : "error",
          `ORCID answered ${String(response.status)}.`,
          rateLimited ? retryAfterMilliseconds(response.retryAfter, new Date()) : undefined,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new ProviderRefusedError("error", "ORCID returned a malformed body.");
      }
      const body = asRecord(parsed);
      if (!body) {
        throw new ProviderRefusedError("error", "ORCID returned an unexpected body shape.");
      }
      /* Zero hits answers `{"expanded-result":null,"num-found":0}` (live
         2026-09-02) — an empty answer, not a refusal. */
      const hits = body["expanded-result"];
      if (hits !== null && !Array.isArray(hits)) {
        throw new ProviderRefusedError("error", "ORCID returned an unexpected body shape.");
      }
      const results: PublicSearchResult[] = [];
      for (const entry of (hits ?? []).slice(0, MAX_RESULTS)) {
        const record = asRecord(entry);
        if (!record || typeof record["orcid-id"] !== "string") continue;
        // The bare 16-digit id becomes the canonical registry URL.
        const url = usableUrl(`https://orcid.org/${record["orcid-id"]}`);
        if (!url) continue;
        const institutions = Array.isArray(record["institution-name"])
          ? record["institution-name"].filter((name): name is string => typeof name === "string")
          : [];
        results.push({
          title: clippedText(
            [record["given-names"], record["family-names"]]
              .filter((name) => typeof name === "string")
              .join(" "),
            200,
          ),
          url,
          snippet: clippedText(institutions.join("; "), 400),
        });
      }
      return results;
    },
  };
}
