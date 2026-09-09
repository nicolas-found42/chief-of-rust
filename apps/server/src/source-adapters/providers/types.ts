import type { PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";

/**
 * What the composite hands one Search Provider for a single query. `fetch` is
 * the composite's transport — the guarded public fetch, or the fetch injected
 * for hermetic tests. `timeoutMs` is the composite's per-request deadline; a
 * provider with a documented slower source passes its own longer value to
 * `fetch` instead (GDELT and Wayback answer in 15–75 s).
 */
export type SearchProviderIo = {
  fetch: PublicHttpFetch;
  timeoutMs: number;
};

/**
 * One independent keyless public-search source behind the PublicSearch seam
 * (ADR-0049): it answers a query with normalized results or refuses by
 * throwing `ProviderRefusedError`. One provider's refusal narrows the merged
 * results and never fails the query; only every provider refusing is a failed
 * search. The question asked is the caller's, never the provider's.
 */
export interface SearchProvider {
  readonly name: string;
  search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]>;
}

/**
 * Why a provider would not answer. The composite turns these classes into
 * cooldowns instead of retries (SearXNG's `suspended_times` model): a
 * rate-limited provider rests for an hour or its Retry-After, a captcha'd one
 * for a day, and everything else is treated as transient.
 */
export type ProviderRefusalReason = "rate-limited" | "captcha" | "error";

export class ProviderRefusedError extends Error {
  constructor(
    readonly reason: ProviderRefusalReason,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderRefusedError";
  }
}
