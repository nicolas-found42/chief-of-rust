#!/usr/bin/env node
/**
 * Live-verify the PublicSearch provider bundle (ADR-0049) from the current
 * network — the canary seam for the composite in
 * apps/server/src/source-adapters/search.ts. It imports the BUILT composite,
 * runs a small set of known-good queries, and prints one line per provider
 * per query from the composite's own diagnostics events, then a summary
 * table. This is a canary, not a test: nothing is asserted and the process
 * always exits 0.
 *
 * Providers fire real network requests from the calling IP (~25 requests per
 * query in the fan-out). Do not loop or retry this script.
 *
 * Usage:
 *   node ./scripts/run-search-canaries.mjs            # base queries
 *   node ./scripts/run-search-canaries.mjs fresh      # meaning-keeping
 *                                                     # variants (fresh
 *                                                     # cache keys)
 */
const { createPublicSearch } = await import("../apps/server/dist/source-adapters/search.js");

/** Variants append meaning-keeping words, not bare padding: a different
    exact query string is a different composite cache key (TTL 10 min), so a
    second pass within the TTL exercises the live providers instead of the
    in-process cache. */
const BASE_QUERIES = ["Grace Hopper", "local-first software", "Rheonix"];
const FRESH_QUERIES = [
  "Grace Hopper computer pioneer",
  "local-first software movement",
  "Rheonix medical devices",
];
const queries = process.argv[2] === "fresh" ? FRESH_QUERIES : BASE_QUERIES;

/** @type {import("../apps/server/dist/source-adapters/search.js").PublicSearchDiagnosticEvent[]} */
const events = [];
let search;
try {
  search = createPublicSearch(undefined, undefined, {
    searxngUrl: "http://localhost:8080",
    diagnostics: (event) => events.push(event),
  });
} catch (error) {
  console.warn("[search-canary] createPublicSearch threw:", error);
  process.exit(0);
}

console.log(
  `[search-canary] Running ${queries.length} queries through the PublicSearch bundle (live network)...`,
);

for (const query of queries) {
  const startedAt = Date.now();
  try {
    const results = await search(query);
    console.log(
      `[search-canary] query "${query}" → ${results.length} merged results in ${String(Date.now() - startedAt)}ms`,
    );
  } catch (error) {
    console.log(
      `[search-canary] query "${query}" → threw after ${String(Date.now() - startedAt)}ms: ${String(error)}`,
    );
  }
}

// One line per provider per pass, from the composite's own diagnostics.
const PER_QUERY_MAX_DETAIL = 90;
console.log("\n[search-canary] Per-provider outcomes:");
for (const event of events) {
  const detail = event.detail ? ` ${event.detail.slice(0, PER_QUERY_MAX_DETAIL)}` : "";
  console.log(
    `[search-canary] ${event.provider.padEnd(16)} ${event.outcome.padEnd(9)} ${String(event.results).padStart(3)} results ${String(event.ms).padStart(6)}ms  q="${event.query}"${detail}`,
  );
}

// Summary: one row per provider across all queries.
/** @type {Map<string, { outcomes: Record<string, number>, results: number, okMs: number, okRuns: number, details: string[] }>} */
const byProvider = new Map();
for (const event of events) {
  if (event.provider === "cache") continue;
  const row = byProvider.get(event.provider) ?? {
    outcomes: {},
    results: 0,
    okMs: 0,
    okRuns: 0,
    details: [],
  };
  row.outcomes[event.outcome] = (row.outcomes[event.outcome] ?? 0) + 1;
  row.results += event.results;
  if (event.outcome === "ok" || event.outcome === "expanded") {
    row.okMs += event.ms;
    row.okRuns += 1;
  }
  if (event.detail && row.details.length < 2) row.details.push(event.detail.slice(0, 60));
  byProvider.set(event.provider, row);
}

console.log("\n[search-canary] Summary (per provider across all queries):");
console.log("provider          ok exp empty ref cool | results  avg-ok-ms  first-detail");
for (const [provider, row] of [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const o = row.outcomes;
  const avg = row.okRuns > 0 ? Math.round(row.okMs / row.okRuns) : 0;
  const cells = [
    String(o.ok ?? 0).padStart(2),
    String(o.expanded ?? 0).padStart(3),
    String(o.empty ?? 0).padStart(5),
    String(o.refused ?? 0).padStart(4),
    String(o.cooldown ?? 0).padStart(4),
  ].join(" ");
  console.log(
    `${provider.padEnd(18)}${cells} | ${String(row.results).padStart(7)}  ${String(avg).padStart(9)}  ${row.details[0] ?? ""}`,
  );
}

// Always succeed as a process: a degraded provider is evidence, not a failure.
process.exit(0);
