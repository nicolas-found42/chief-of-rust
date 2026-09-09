# Public search fans out over independent keyless providers

Public web search ran through one anonymous HTML route — DuckDuckGo's — which now answers
anti-bot challenge pages under volume, and one unauthenticated endpoint is a single point of
failure for Person Profiles, Content Projects research and Content Research discovery alike.
`createPublicSearch()` keeps its shape — a query in, `{title, url, snippet}` results out, and a
refusal that is distinct from an empty answer — but it now composes a fan-out over independent
keyless providers and merges the results, following
[the public-search research](../research/public-search-providers.md): a self-hosted SearXNG in
docker-compose as the primary web source, independent engines and Wikimedia, news and Reddit
indexes, verticals, and an engine-outage-proof person-identity layer (OpenAlex, ORCID, GitHub,
DBLP, ROR, GLEIF, SEC EDGAR, Wikidata).

## Considered Options

- **Keep the single DDG HTML route and wait out the 202s.** Rejected: the challenge wall is the
  upstream's answer to plain clients, not an incident; the three consumers would keep failing
  together whenever one endpoint disliked the home IP.
- **Adopt a browser-impersonation HTTP client (primp/curl-impersonate) so engine scrapes keep
  working.** Rejected as the foundation: ToS-grey, a heavyweight native dependency, and
  unnecessary given how many keyless APIs and RSS surfaces answer plain fetch. It remains an
  optional later tier behind the same seam.
- **Pool public SearXNG instances instead of self-hosting one.** Rejected as primary: 8 of 9
  probed instances block keyless JSON. One compose-local instance is the primary; a public pool
  is at most a fallback tier.
- **Record per-provider provenance on each result.** Rejected: all three consumers dedupe by
  URL and none wants a field per result; per-provider visibility belongs to a
  construction-injected diagnostics hook instead.
- **Retry a failing provider inside the query.** Rejected: a query must end. Typed cooldowns —
  a rate-limited provider rests for an hour or its Retry-After, a captcha'd one for a day —
  modeled on SearXNG's `suspended_times`, keep a misbehaving provider resting without stalling
  the answer, and a short TTL result cache absorbs the repeat queries the Modules ask.

## Decision

**One provider's refusal narrows the merged results; it never fails the query** — ADR-0028's
independence rule applied to search. The failed/empty distinction sharpens rather than changes:
`PublicSearchUnavailableError` is thrown only when *every* provider refused, so a failed
diagnostic still never lets an empty answer masquerade as "no public footprint". Providers that
answered with nothing still mean answered-with-nothing. A query that comes back cleanly empty
may be expanded once through the keyless autocomplete endpoints (Google/DDG/Bing suggest) and
re-asked with at most two variants — a recall multiplier, not a second fan-out tier.

**The transport stays plain, keyless and per-provider.** Each provider binds its own fetch at
construction: the guarded public fetch by default; a declared-contact UA for SEC EDGAR, which
403s generic agents; an unguarded fetch for the compose-internal SearXNG URL, which is fixed
configuration rather than user input; and longer deadlines for the slow sources (GDELT and
Wayback answer in 15–75 s). No cookies, no imported sessions, no CAPTCHA bypass — public
results stay untrusted Source-Item-class input. The incumbent DDG HTML route remains only as
one best-effort provider among many, so its refusals narrow instead of failing.

## Consequences

- Up to ~25 upstream requests per uncached query. The TTL cache, the cooldowns and the
  providers' own documented limits (Stack Exchange 300/day/IP, Reddit RSS ~2–3 req/min,
  Marginalia's contended public QPM) bound the real volume; pacing is delegated to refusals and
  cooldowns, never to sleeps inside a query.
- The bundle is live-verified, not assumed: a canary script probes each provider from the host
  network and its verdicts are recorded in the research doc. A provider that fails live stays
  marked, not silently dropped.
- The compose file gains SearXNG (+ valkey) and `search.searxngUrl` in config (Settings) names
  the instance; without one configured, the bundle simply lacks the SearXNG provider.
- Adding, retiring or re-verifying a provider is a provider-file change plus a bundle-list
  entry, never a caller change: the seam's shape is fixed.
