# Keyless public-search providers — multi-source research

_Researched 2026-09-01 by nine background agents (live probes from the home IP plus primary-source
citations throughout), merged here. For the multi-provider public-search effort following the
202-challenge degradation of the DuckDuckGo HTML route. Everything below is free, keyless, and
signup-free unless explicitly marked otherwise; live probes ran with plain `curl`/browser UA from
  the home IP unless a different client is named. Additive to
  [linkedin-reading-options.md](linkedin-reading-options.md),
  [content-scout-source-adapters.md](content-scout-source-adapters.md), and
  [github-awesome-harvest-2026-08-30.md](github-awesome-harvest-2026-08-30.md) — does not
  re-decide LinkedIn._

## Question

All public web search in this app flows through one seam:
`createPublicSearch()` in
[`apps/server/src/source-adapters/search.ts`](../../apps/server/src/source-adapters/search.ts)
returns `PublicSearchResult { title, url, snippet }[]`. It has exactly one implementation —
DuckDuckGo's anonymous HTML endpoint — which now answers HTTP 202 challenge pages under volume.
One unauthenticated HTML endpoint is a single point of failure; the fix is breadth. The project
runs three distinct query types, and every candidate below is judged against them:

1. **Person-identity lookup** — given an email, name, handle, or profile URL, find public
   evidence about one person (name, role, employer, public profiles).
2. **Co-mention discovery** — queries naming watched people, to find who else is being named
   alongside them.
3. **Topical content research** — topic/keyword queries producing web-page Source Items.

## Answer in one paragraph

A layered fan-out **behind** the existing `PublicSearch` type (no caller changes): a self-hosted
[SearXNG](#1-layer-1--self-hosted-searxng-primary-web-results) in docker-compose as the primary
web-results provider; keyless direct APIs and independent engines as independent sources
([Marginalia](#marginalia-search), [Mojeek](#mojeek-html), Wikipedia/Wikidata,
[GDELT](#gdelt-doc-20-api), news RSS, [Arctic Shift](#arctic-shift), Stack Exchange excerpts);
a **person-identity enrichment layer** (Wikidata incl. LinkedIn slugs via
[P6634](#linkedin--the-route-map), OpenAlex, ORCID, GitHub, DBLP, ROR/GLEIF/SEC EDGAR) that no
engine outage can touch; and free autocomplete endpoints as a recall multiplier ahead of every
query. The load-bearing transport finding: **plain Node fetch is already being blocked** (the
202 wall), and the OSS keyless-scraping playbook ([ddgs](#the-ddgs-porting-playback)) works only
with browser-impersonation clients — but nearly all *APIs and RSS surfaces* above work with plain
fetch. Public SearXNG instances are a fallback tier only: 8 of 9 probed blocked keyless JSON.

## The recommended stack

| # | Provider | Type | Query types | Keyless verification | Key limit | Verdict |
|---|---|---|---|---|---|---|
| 1 | SearXNG (self-host) | Metasearch, JSON API | 1·2·3 | [docs](https://docs.searxng.org/admin/installation-docker.html): no key/account | local — none | **USABLE TODAY** (live-verified 2026-09-02, 0.5–1.6 s, 8 results/query) |
| 2 | Wikipedia opensearch | Structured API | 1·3 | [MediaWiki etiquette](https://www.mediawiki.org/wiki/API:Etiquette): no key | soft; descriptive UA | **USABLE TODAY** (live-verified 2026-09-02, ~0.2–0.3 s; empty on long multi-word queries) |
| 3 | Wikidata `wbsearchentities` + SPARQL | Structured API | 1 | [WDQS manual](https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual) | 60 s query-time/min/client | **USABLE TODAY** (live-verified 2026-09-02, ~0.2–0.4 s; empty on long multi-word queries) |
| 4 | Marginalia Search | Independent index API | 2·3 | [`API-Key: public`](https://about.marginalia-search.com/article/api/), no signup | shared QPM, 503 when saturated | **DEGRADED** (live 2026-09-02: 429 QPM on the first request of each pass, then cooldown — the shared `public` key is contended as researched) |
| 5 | Mojeek HTML | Independent engine scrape | 1·2·3 | [ddgs engine source](https://github.com/deedy5/ddgs/blob/master/ddgs/engines/mojeek.py): plain GET, no tokens | unpublished; historically tolerant | **DEGRADED** (live 2026-09-02: intermittent anti-bot challenge — an a/b test showed every UA variant both challenged and passing within the hour, so the gate is volume-based, not fingerprint-based; challenge → 24 h captcha cooldown) |
| 6 | GDELT DOC 2.0 | News index API | 2·3 | [project docs](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/), live 200 | ~1 req/5 s observed; 15–75 s latency | **DEGRADED** (live 2026-09-02: flapping from this home IP — Node fetch ECONNRESET on most attempts while curl got a 200 in 28 s an hour later; read as connection-drop throttling per the [anti-bot research](anti-bot-keyless-search.md), cooled down and never load-bearing) |
| 7 | Bing News RSS | News RSS | 2·3 | live 200 (undocumented surface) | unpublished | **USABLE TODAY** (live-verified 2026-09-02, ~0.3–0.5 s; one honest-empty on a topical query) |
| 8 | Google News RSS | News RSS | 2·3 | live 200 (undocumented surface) | unpublished | **USABLE TODAY** (live-verified 2026-09-02, ~0.3–0.7 s, answered every query) |
| 9 | Stack Exchange `/search/excerpts` | Q&A API | 3 (1 partial) | [throttle docs](https://api.stackexchange.com/docs/throttle) | 300/day/IP anonymous | **USABLE TODAY** (live-verified 2026-09-02, ~0.15–0.6 s; empty on the org query) |
| 10 | Arctic Shift | Reddit archive API | 2·3 (1 weak) | [api/README.md](https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md), live 200 | "couple req/s" fine | **DEGRADED** (live 2026-09-02: declined all six unscoped canary queries by design — needs an r/ or u/ scope; not otherwise exercised) |
| 11 | Reddit public RSS | Search RSS | 2·3 | live 200 Atom | ~2–3 req/min observed | **USABLE TODAY** (live-verified 2026-09-02: exactly one success per pass, ~0.75 s, then 429 — paced as researched) |
| 12 | OpenAlex `/authors` | Scholar graph | 1·3 | [docs](https://github.com/ourresearch/openalex-docs/blob/main/api-guide-for-llms.md): mailto polite pool | 10 req/s, 100k/day | **USABLE TODAY** (live-verified 2026-09-02, ~0.6 s on the person query; honest-empty on topical/org queries) |
| 13 | ORCID `expanded-search` | Researcher registry | 1 | live 200 tokenless ([tutorials](https://info.orcid.org/documentation/api-tutorials/api-tutorial-searching-the-orcid-registry/)) | unpublished | **USABLE TODAY** (live-verified 2026-09-02, ~0.3–0.6 s, answered every query) |
| 14 | GitHub `/search/users` (no token) | Developer identity | 1 | [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) | 10/min search, 60/h core | **USABLE TODAY** (live 2026-09-02: the 415 was the seam's HTML-first `accept`; the provider now binds the versioned GitHub media type to its transport — 8 results in ~0.4–0.7 s on every query) |
| 15 | Wikidata **P6634** LinkedIn slug | Identity bridge | 1 | property live-verified via `wbsearchentities` | (same as #3) | **USABLE TODAY** (live 2026-09-02: the wikidata provider verified; the P6634 slug lookup rides the same API and was not separately exercised) |
| 16 | Wayback availability API | Archive lookup | 1·3 | live 200 | slow today (25–75 s) | **DEGRADED** (live 2026-09-02: declined all six canary queries by design — needs an absolute URL; not otherwise exercised) |
| 17 | Suggest endpoints (Google/DDG/Bing) | Query expansion | 1·2·3 | live 200 JSON (undocumented) | unpublished | **USABLE TODAY** (live-verified 2026-09-02: all three endpoints 200 in ~0.1–0.2 s; the composite's expansion pass never triggered because every fan-out had a refusal) |
| 18 | SEC EDGAR full-text | Filings | 1 | live 200 — **declared UA required** | ~10 req/s fair access | **USABLE TODAY** (live-verified 2026-09-02, ~0.3–2.4 s; one 500 and two honest-empty across six requests) |
| 19 | GLEIF LEI registry | Legal entities | 1 | live 200 ([api.gleif.org](https://api.gleif.org/api/v1/lei-records)) | unpublished | **USABLE TODAY** (live 2026-09-02: the "malformed body" was the HTML-first `accept` negotiating XML; a JSON accept now rides the provider's transport — clean envelope, honest-empty on non-entity queries) |
| 20 | Internet Archive `advancedsearch.php` | Catalog search | 3 | live 200 | unpublished | **USABLE TODAY** (live-verified 2026-09-02, ~1–2 s; empty on the org query) |
| 21 | Europe PMC / OpenAIRE | Academic search | 3 | live 200 | unpublished | **USABLE TODAY** (live-verified 2026-09-02, answered every query but 2–21 s latency — brushing the 20 s deadline) |
| 22 | Openverse | CC media | 3 (media) | [docs](https://api.openverse.org/): anonymous OK | ~200 req/day anonymous | **USABLE TODAY** (live 2026-09-02: two fixes — `format=json` selects a Cloudflare cache key that is not the cached browsable-HTML page, SearXNG's engine does the same; and a 60 s deadline for the 17–25 s latency. Final canary: 2 answered + 1 honest-empty) |
| 23 | Wiby JSON | Small-web index | 1·3 | live 200 | none documented | **USABLE TODAY** (live-verified 2026-09-02, ~0.3–0.6 s; empty on the org query) |
| 24 | IA TV News (via advancedsearch) | Broadcast captions | 2 | live 200 | ~1 req/s on files | **USABLE TODAY** (live-verified 2026-09-02: person query 8 results in ~0.9 s; co-mention boolean queries now ride verbatim instead of being re-wrapped into a nested Solr phrase — 8 results live; honest-empty on topical/org) |
| 25 | DDG html POST / Brave / Yahoo / Google WML | Engine scrapes | 1·2·3 | [ddgs](https://github.com/deedy5/ddgs) engines | n/a | **SPLIT** — DDG html ships as the documented single-user exception riding SearXNG's POST flow ([anti-bot-keyless-search.md](anti-bot-keyless-search.md)); Brave/Yahoo/Google WML stay do-not-adopt (impersonation-grade, ToS-contrary) |
| 26 | Public SearXNG instance pool | Metasearch fallback | 1·2·3 | [instances.json](https://searx.space/data/instances.json) | per-instance limiters | **FALLBACK ONLY** (8/9 probed blocked) |
| 27 | open-webSearch (self-host daemon) | Multi-engine daemon, `POST /search` | 1·2·3 | [README](https://github.com/Aas-ee/open-webSearch/blob/main/README.md): "No API keys or authentication required"; Apache-2.0, ~1.8k stars | personal-use; engines "may temporarily block requests" | **NEEDS SELF-HOST** — closest ready-made `PublicSearch` server |

**Live verification 2026-09-02.** The merged composite (`createPublicSearch` with the
self-hosted SearXNG on host loopback) was run twice from the home IP, ~2 min apart, over three
known-good queries each ("Grace Hopper", "local-first software", "Rheonix"; pass 2 used
meaning-keeping variants — "Grace Hopper computer pioneer" etc. — to defeat the 10-minute
in-process cache), roughly 140 live requests total. 16 of 24 stack providers answered with
results in both passes; every merged query returned a full 24-result cap and no query ever hit
the all-refused `PublicSearchUnavailableError`. Two refusals share one root cause: the shared
transport's `accept: text/html, application/rss+xml, …` header makes GitHub answer 415 and GLEIF
content-negotiate to XML — both answered 200 JSON under direct curl with the same UA, so a
JSON-aware accept header on JSON-API providers fixes both. Marginalia's shared `public` key 429'd
on the first request of each pass; Reddit RSS allowed exactly one request per pass before 429;
Mojeek served an anti-bot challenge on first touch; GDELT was unreachable at the network level
from this IP all morning; Openverse answered only in 16–25 s, past the 20 s per-request deadline.
Arctic Shift and Wayback declined every canary query by design (unscoped/relative queries), so
their live verification remains scoped-probe-only. Surprise: the composite's plain-fetch
DuckDuckGo provider answered all six queries with 8 results each in ~0.7–0.9 s — the 202
challenge wall from the 202-challenge degradation never showed up at today's single-user volume.

**Post-fix canary (same day).** After the six transport/shape fixes the final three-query
canary run answered 16 providers with results on every query and no query hit the all-refused
`PublicSearchUnavailableError`: DuckDuckGo 3×8 in ~1 s via the documented POST flow (form-encoded
`q`, browser-like UA, referer echo, navigate sec-fetch-mode); SearXNG, ORCID, ROR and Europe PMC
3×8 each; Google News, Bing News, Internet Archive, Stack Exchange, Openverse, Wiby and the rest
answering with honest empties where the vertical did not apply. The remaining refusals are the
honest ones: GDELT's connection drops, Marginalia's and Reddit RSS's 429 pacing (both cooled
down correctly mid-run), and Mojeek's intermittent challenge. The fixes themselves — GitHub's
media-type accept, GLEIF's and ROR's JSON accept, ORCID's zero-hit null envelope, Openverse's
`format=json` cache key plus 60 s deadline, IA TV News verbatim boolean queries, and DuckDuckGo's
POST flow — are documented in [anti-bot-keyless-search.md](anti-bot-keyless-search.md).

Dead ends are listed at the bottom so nobody re-researches them.

## The seam: multi-source goes behind `PublicSearch`

All three consumers build the search with defaults —
[`shell.ts:276`](../../apps/server/src/composition/shell.ts) (Person Profiles),
[`shell.ts:345`](../../apps/server/src/composition/shell.ts) (Content Projects research),
[`shell.ts:420`](../../apps/server/src/composition/shell.ts) (Content Research discovery) — so a
composite implementation of `createPublicSearch()` requires **zero caller changes**. Research
confirmed nothing needs per-source provenance inside results: Content Projects already dedupes
by URL and records a single provider id
([`research.ts:300-309`](../../apps/server/src/content-projects/research.ts)), and the other two
consumers only need the result set plus the failed/empty distinction.

Composite behavior that matches existing contracts:

- **Fan out with `Promise.allSettled`** across providers (mirrors
  [`research.ts:296`](../../apps/server/src/content-projects/research.ts)), merge, dedupe by URL,
  cap per-query results. One provider refusing narrows results; it never fails the query —
  the same independence principle as [ADR-0028](../adr/0028-content-scout-separates-collection-selection-and-publication.md)
  for Source Adapters.
- **`failed ≠ empty` is preserved and sharpened**: throw
  `PublicSearchUnavailableError` only when *every* provider refused. The contract test
  ([`public-search-availability.test.ts`](../../tests/src/modules/public-search-availability.test.ts))
  stays meaningful — "all refused" is a failed diagnostic; "answered with nothing" remains empty.
- **Per-provider visibility** needs no type change: providers that misbehave are visible through
  a construction-injected diagnostics hook (the pattern
  [`shell.ts:278`](../../apps/server/src/composition/shell.ts) already uses for `extractClaims`).
  `PublicSearchResult` gains no field today; none of the three consumers wants one.

### Repo-specific integration caveats found during grounding

1. **The SSRF guard blocks self-hosted services.** `publicHttpFetch` runs
   `assertPublicHttpUrl` ([`http.ts:61`](../../apps/server/src/source-adapters/http.ts), guard at
   [lines 35–58](../../apps/server/src/source-adapters/http.ts)) which rejects `localhost`,
   `.local`, and all private IPv4/IPv6 ranges. A compose-internal `http://searxng:8080` will be
   rejected. The SearXNG provider therefore needs its **own injected fetch** (no guard) — safe
   because the base URL is fixed configuration, not user input, unlike Source Targets.
2. **The 20 s abort is too short for some sources.** `publicHttpFetch` aborts at 20 s
   ([`http.ts:63`](../../apps/server/src/source-adapters/http.ts)). GDELT answered in 15–75 s and
   Wayback 25–75 s during probes. Per-provider timeout overrides are required.
3. **The UA matters.** The seam sends
   `Found42-Content-Scout/1.0 (+public-source-monitor)`
   ([`http.ts:66-68`](../../apps/server/src/source-adapters/http.ts)). Wikimedia/GLEIF/MusicBrainz
   want descriptive UAs (this one qualifies); **SEC EDGAR 403s any UA without contact info**
   ("Undeclared Automated Tool", live-verified both ways) — the EDGAR provider must send its own
   declared UA.
4. **The content-type check is per-provider.** `createPublicSearch` currently requires
   `text/html` responses ([`search.ts:61`](../../apps/server/src/source-adapters/search.ts)); the
   composite should dispatch on each provider's declared parser instead of one global check.

## Layer 1 — self-hosted SearXNG (primary web results)

**What:** metasearch over ~70 upstream engines; docker image
[`docker.io/searxng/searxng`](https://docs.searxng.org/admin/installation-docker.html) needs no
key or account. JSON API: enable `search.formats: [html, json]` in `settings.yml` (the default
ships `html` only and `format=json` answers 403 without it —
[Search API doc](https://docs.searxng.org/dev/search_api.html)). Response:
`{ query, results[{url, title, content}], answers, infoboxes, suggestions,
unresponsive_engines[] }` (`searx/webutils.py:162-174`, `searx/webapp.py:672-675`) — `url/title/
content` maps 1:1 onto `PublicSearchResult`.

**Compose (current official template** — `searxng-docker` repo is superseded per its README;
[`container/docker-compose.yml`](https://github.com/searxng/searxng/blob/master/container/docker-compose.yml)):

```yaml
services:
  core:
    image: docker.io/searxng/searxng:${SEARXNG_VERSION:-latest}
    ports: ["8080:8080"]
    volumes: ["./core-config/:/etc/searxng/:Z"]
  valkey:
    image: docker.io/valkey/valkey:9-alpine
```

**Keyless default engines** (from `searx/settings.yml`): google, bing, duckduckgo, brave (the
scraper engine — distinct from keyed `braveapi`), mojeek, qwant, startpage, wikipedia. Keyed
engines (kagi, exaapi, marginalia-api, etc.) are opt-in, not default.

**Does it solve the 202 problem or relocate it?** It **relocates and dampens** it. Upstream
blocks are real and documented — [issue #2750](https://github.com/searxng/searxng/issues/2750)
and [#2498](https://github.com/searxng/searxng/issues/2498) (Google), and
[#4824](https://github.com/searxng/searxng/issues/4824) (DDG captcha). But SearXNG's design
answer is exactly the fan-out model this research wants: a blocked engine is suspended
(`suspended_times`: captcha 3600 s, access-denied 180 s) and results keep arriving from the other
engines, with failures listed in `unresponsive_engines[]`. Per-engine
[proxies/Tor/weight/removal](https://docs.searxng.org/admin/settings/settings_engines.html) are
first-class config. At this app's volume (tens per run, one home IP) all engines except Google
are typically fine, and demoting Google (`use_default_settings: engines: remove: [google]`) is a
one-liner. The limiter needs valkey and only guards the instance from third parties; your own
calls pass via `pass_ip`.

**Self-host alternatives, for completeness:**
[open-webSearch](https://github.com/Aas-ee/open-webSearch) (Apache-2.0, ~1.8k stars;
`POST /search` returning `{title, url, description, source, engine}` — the `PublicSearch` shape
plus provenance; official Docker image; opt-in Playwright fallback as its anti-bot escape hatch) —
**NEEDS SELF-HOST**, the strongest all-in-one second engine path;
[4get](https://git.lolcat.ca/lolcat/4get) (`/api/v1/web?s=…` JSON, `title/url/description`,
Dockerfile with curl-impersonate; single maintainer) — `NEEDS SELF-HOST`;
[LibreY](https://github.com/Ahwxorg/librey) (`api.php?q=&t=0` JSON; simpler, more fragile
scrapers) — `NEEDS SELF-HOST`;
[YaCy](https://github.com/yacy/yacy_search_server) (`/yacysearch.json?query=…&resource=local|global`,
fields `link`/`description` need mapping) — the **only structurally block-proof** option since it
serves its own P2P index, at the cost of a hungry JVM and volunteer-network result quality;
[Yioop](https://seekquarry.com/) (own crawler, heavy) — `NEEDS SELF-HOST`.
[Whoogle](https://github.com/benbusby/whoogle-search) is **dead** (README notice 2026-07-24:
"Whoogle no longer returns search results… Google has now killed the last User-Agent string that
still worked") and
[Mwmbl](https://github.com/mwmbl/mwmbl) has no turnkey self-host search API.

## Layer 2 — keyless direct sources (no self-host)

**Marginalia Search** — independent non-commercial index with a documented keyless path: header
`API-Key: public`, `GET https://api2.marginalia-search.com/search?query=…&count=…`
([API docs](https://about.marginalia-search.com/article/api/)); results `{url, title,
description}`. The shared `public` key is QPM-contended — live probe returned "QPM Limit
Exceeded" (service up); treat 503 as normal and this source as best-effort. Results are
CC-BY-NC-SA — fine for this app, cited for redistribution.

**Mojeek HTML** — independent UK index, plain `GET https://www.mojeek.com/search?q=…`, parse
`ul.results > li → h2/a` + `p.s`
([ddgs `mojeek.py`](https://github.com/deedy5/ddgs/blob/master/ddgs/engines/mojeek.py)). No
tokens, no impersonation — the most portable engine scrape for plain undici. Its free API tier is
gone (paid plans only; trial credits need signup). Live probe caveat: **its index returned zero
results for `site:linkedin.com/in` queries** — an index-coverage gap, so route LinkedIn queries
elsewhere.

**The ddgs porting playbook (if engine scrapes are wanted at all).**
[ddgs](https://github.com/deedy5/ddgs) (MIT, ex-`duckduckgo_search`) documents the current
keyless scrape matrix — text: `bing, brave, duckduckgo, google, grokipedia, mojeek, startpage,
yandex, yahoo, wikipedia` — and per-engine techniques (DDG `POST html.duckduckgo.com/html/` with
form payload; Brave `search.brave.com` parsing `div[data-type='web']`; Yahoo with random
`_ylt/_ylu` tokens; Google via the `/wml/search` WAP endpoint with a Nokia UA; Startpage's two
step `sc`-token dance; Bing and Yandex `disabled = True` upstream). The load-bearing finding: its
HTTP layer uses `primp` with `impersonate="random"` — **TLS/JA3 browser impersonation is the
minimum bar for these scrapes; plain undici sits on the challenge wall (the 202 we already get)**.
Upstream itself prints "for educational purposes only" — engine scrapes are ToS-grey. Treat this
as an optional later tier behind curl-impersonate, not the foundation.

**Wikipedia/Wikidata** — `GET https://en.wikipedia.org/w/api.php?action=opensearch&search=…` and
`GET https://www.wikidata.org/w/api.php?action=wbsearchentities&search=…&language=en&format=json`
(live 200, keyless; [etiquette](https://www.mediawiki.org/wiki/API:Etiquette): no hard limit,
descriptive UA; [rate limits page](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits)).
SPARQL at `query.wikidata.org/sparql` (60 s timeout, 60 s query-time/min/client) adds employer
(P108), occupation (P106), homepage (P856). Highest signal-per-request of any keyless source for
notable people; trivially maps to `{title: label, url: concepturi, snippet: description}`.

## Layer 3 — person-identity enrichment (engine-outage-proof)

These answer query type 1 without touching a general engine at all:

- **OpenAlex** — `GET https://api.openalex.org/authors?search=…&mailto=…`; polite pool
  10 req/s, 100k/day, no account ([docs](https://github.com/ourresearch/openalex-docs/blob/main/api-guide-for-llms.md));
  live 200. Best structured source for researcher/engineer identities.
- **ORCID** — `GET https://pub.orcid.org/v3.0/expanded-search?q=…` verified live **tokenless**
  (200 with `expanded-result[]` incl. institution names); also exposes researchers' LinkedIn
  URLs as `researcher-url`s (see [LinkedIn](#linkedin--the-route-map)).
- **DBLP** — `dblp.org/search/publ/api?q=…&format=json`, "one or two seconds between two
  consecutive requests" ([FAQ](https://dblp.org/faq/Am+I+allowed+to+crawl+the+dblp+website)); CS
  people only.
- **GitHub** — `GET https://api.github.com/search/users?q=…` unauthenticated: 10 req/min search,
  60 req/h core per IP ([rate limits](https://docs.github.com/en/rest/search/search)); real
  name/company/blog/bio. Enrichment-only volume.
- **Stack Exchange users** — `GET /2.3/users?inname=…&site=stackoverflow` returns
  `display_name, location, website_url, reputation` in one shot (live 200; 300/day/IP anonymous —
  [rate-limit guide](https://meta.stackexchange.com/questions/164899/the-complete-rate-limiting-guide)).
- **SEC EDGAR** — `GET https://efts.sec.gov/LATEST/search-index?q="Name"&forms=10-K` with a
  declared contact UA; Elasticsearch-shaped hits with entity/ticker/CIK `display_names` +
  `biz_locations`. Strong employer/role evidence for US-business people.
- **GLEIF** — `GET https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=…`
  (live 200; note `api.gleif.io` is dead — `.org` only). Canonicalizes employer legal names.
- **ROR** — `https://api.ror.org/organizations?query=…` for institution canonicalization.

Not qualified for people: [Semantic Scholar](https://www.semanticscholar.org/product/api) has a
keyless tier on paper (1000 req/s *shared*) but 429'd on the first live request — best-effort
only; [MusicBrainz](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting) is artists-only.

## Layer 4 — verticals and recall multipliers

- **GDELT DOC 2.0** — `GET https://api.gdeltproject.org/api/v2/doc/doc?query=…&mode=artlist&
  format=json&maxrecords=250` ([docs](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)):
  global news across 100k+ outlets, 3-month rolling window, quoted-phrase + `domain:` +
  `sourcecountry:` operators. The strongest keyless **co-mention** surface found. Slow: 15–75 s
  observed; ~1 req/5 s observed in an error string. Budget timeouts and cache.
- **Bing / Google News RSS** — `bing.com/news/search?q=…&format=RSS` and
  `news.google.com/rss/search?q=…` (live 200/302-follow). Freshest co-mention signals, zero
  setup. Both feeds carry an embedded usage restriction ("personal, non-commercial feed
  rendering") — a product-policy caveat, flagged rather than hidden. Google News links are
  redirect-wrapped.
- **IA TV News** — `advancedsearch.php?q=collection:"tvarchive" AND "person"` (live 200, 8,994
  hits) then per-show caption files (~1 req/s; [reference tooling](https://github.com/notnews/archive_news_cc)).
  Broadcast co-mention nobody else covers.
- **Arctic Shift** — keyless Reddit archive
  ([api/README.md](https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md);
  live 200s). Keyword search requires an author/subreddit scope;
  `/api/users/interactions/users` aggregates who-interacts-with-whom — a unique co-mention
  signal. Caveat: Reddit's anonymous `.json` endpoints now 403 (live-verified; see dead ends).
- **Reddit public RSS** — `www.reddit.com/search.rss?q=…` (live 200 Atom with `/u/` author in
  every entry) still works but paced: ~1 success per 20–30 s window per IP
  (`x-ratelimit-*` headers). ~2–3 req/min budget.
- **Stack Exchange `/search/excerpts`** — real keyless full-text search of the technical Q&A
  corpus (live 200; excerpts carry `<span class="highlight">`); 300/day/IP; stored snippets must
  carry CC BY-SA attribution ([licensing](https://stackoverflow.com/help/licensing),
  [API terms](https://stackexchange.com/legal/api-terms-of-use)).
- **Sourcegraph stream** — `sourcegraph.com/search/stream?q=context:global …&v=V3` returned 200
  SSE keyless (undocumented surface): code-level evidence for engineer identities. Best-effort.
- **Suggest endpoints (recall multiplier)** —
  `suggestqueries.google.com/complete/search?client=firefox&q=…`,
  `duckduckgo.com/ac/?q=…`, `api.bing.com/osjson.aspx?query=…` all returned keyless JSON in
  ~0.1–0.8 s (Brave's is tokened — excluded). Expand a person/topic into fuller queries
  (`"<name> <employer>"`) before firing real searches. Undocumented browser-internal surfaces —
  degrade gracefully when they change.
- **Wayback** — `archive.org/wayback/available?url=…` (live 200) and CDX for resurrecting dead
  Source-Item links; slow today (25–75 s), needs the long timeout.
- **Vertical extras** — Europe PMC (`ebi.ac.uk/europepmc/webservices/rest/search?format=json`,
  live 200), OpenAIRE, Internet Archive `advancedsearch.php` (live 200), Openverse
  (`api.openverse.org/v1/images/?q=…` — anonymous OK but ~200 req/day and **media-only**),
  [Wiby](https://wiby.me/json/?q=…) JSON for small-web personal homepages.

## LinkedIn — the route map

The user's priority question: *why can't we fetch LinkedIn pages, and what's the fix?* Answer:
**direct fetching is walled and everything that beats the wall needs a login**, but the
index-references posture the app already uses **can be fixed at the transport layer and seeded
with two keyless identity bridges**. Each route is classified **(a)** = keeps the documented
posture "LinkedIn enters only through publicly indexed references; never fetch the page", or
**(b)** = would relax it. Recommendation: stay (a) by default; (b) options exist but are
fragile and robots/ToS-contrary — a product decision, not a technical one.

| Route | Posture | Finding (live-probed 2026-09-01) | Verdict |
|---|---|---|---|
| Index references via impersonated transport | (a) | DDG html endpoint 202'd plain curl; **primp/curl-impersonate is the working transport** (ddgs). Bing served degraded HTML (1 result, no LinkedIn hrefs) to plain clients. | **THE FIX — adopt** |
| **Wikidata P6634** "LinkedIn personal profile ID" | (a) | Property verified via `wbsearchentities`; `wbgetentities …props=claims` yields `linkedin.com/in/<slug>` for notable people — seed for site: queries. Company: P4264. | **THE FIX — adopt** |
| ORCID `researcher-url`s | (a) | Live: expanded-search + record fetch returns `linkedin.com/in/…` URLs (e.g. `rawankahhaz`). Researchers only. | Adopt (narrow) |
| Wayback availability for profiles | (a) | `archive.org/wayback/available?url=linkedin.com/in/reidhoffman` → live snapshot 2026-06-16. Reads archive.org, never LinkedIn. | Adopt (enrichment) |
| Brave HTML `site:linkedin.com` | (a) | Endpoint shape known; LinkedIn snippet quality not probed this run. | Try later |
| Mojeek `site:linkedin.com` | (a) | Index gap: 0 results for LinkedIn-scoped queries (not anti-bot). | **Not qualified** |
| Logged-out `linkedin.com/in/<slug>` fetch | **(b)** | Live: HTTP 200, ~819 KB guest preview with headline/role tokens — **works today**, but robots.txt `Disallow: /` (documented in [`linkedin-reading-options.md`](linkedin-reading-options.md)), view caps/consent walls unverified, one-slug sample. | **Do not adopt** (available if the user chooses to relax) |
| Guest API / credential-free profile JSON | (b) | No OSS project exposes a stable keyless profile-JSON guest endpoint; the working guest endpoints cover **jobs** only. | Not qualified |
| OSS scrapers (Voyager etc.) | (b) | Every maintained one requires `li_at` login cookie ([LinkedInDumper](https://github.com/l4rm4nd/LinkedInDumper) README). | Not keyless |
| Invidious-like LinkedIn frontend | (b) | None exists; only UI clones and a posts-only Cloudflare Worker proxy. | Not qualified |
| archive.today / Google / Bing caches | (a)-ish | archive.today 429 + CAPTCHA; Google and Bing caches discontinued/removed (2024). | Not qualified |
| rel=me / IndieWeb | (a) | LinkedIn does not participate ("the hyperlink lacks a rel=me" — [indieweb.org](https://indieweb.org/LinkedIn)). | Not qualified |

**Net answer:** the fix is (1) an impersonation-grade HTTP client for the engine-scrape tier so
`site:linkedin.com/in` queries get through (this is also what fixes the 202 wall generally),
(2) P6634/ORCID slug seeding so person queries hit LinkedIn's indexed surface directly, and
(3) Wayback as the read-the-archive fallback. The one honest gap: ordinary private individuals
who are neither notable (no Wikidata row) nor researchers (no ORCID) surface only through whatever
the engines have indexed — which is exactly what the multi-source fan-out maximizes.

## Public SearXNG instances and resilience patterns

- **Instance pool = fallback tier, never primary.** The machine-readable feed
  [`searx.space/data/instances.json`](https://searx.space/data/instances.json) (AGPL-3.0
  [searxng/searx-space](https://github.com/searxng/searx-space); refresh cadence UNVERIFIED —
  inferred from repo tooling) carries
  per-instance `timing.search.success_percentage`, per-engine `error_rate`, `uptime`, TLS/HTTP
  grades. Snapshot: ~29/92 instances pass >0% on searx.space's own search probe, and every
  instance reporting DDG error rates showed 90–100% — upstream blocking is fleet-wide. Live probe
  of 9 instances' `/search?format=json` from the home IP: **8 of 9 blocked** (429s, Anubis
  proof-of-work challenges, limiter pages). JSON is also frequently disabled per-instance.
- **Rotation blueprints:** [Njinx/instx](https://github.com/Njinx/instx) (scores/filters
  instances from the feed) and the archived [benbusby/farside](https://github.com/benbusby/farside)
  (health sweep every 10 m — 200 within 10 s; random selection excluding the last instance
  handed out; 1 req/s politeness) — the pattern survives even though Farside's hosted service is
  dead because "querying instance status is no longer reliable due to bot-detection".
- **Aggregator meta-finding:** Vane/ex-[Perplexica](https://github.com/ItzCrazyKns/Perplexica)
  (MIT), [Morphic](https://github.com/miurla/morphic) (Apache-2.0, compose with SearXNG, "no
  additional search API key is needed"), and
  [LibreChat](https://github.com/danny-avila/LibreChat) all point at **one** self-hosted SearXNG
  with no failover chain — none of the majors implements pooling or retry-with-jitter. The app
  must compose the two halves itself (self-host SearXNG + fallback tiers).
- **SearXNG failure semantics to copy:** blocked engines are suspended with staggered
  `suspended_times` and surface in `unresponsive_engines[]` (`searx/results.py`
  `add_unresponsive_engine`; documented in
  [settings_search.rst](https://docs.searxng.org/admin/settings/settings_search.html)) — the
  model for keeping the app's failed/empty distinction while fanning out. Per-engine
  `proxies`/`using_tor_proxy` are the documented escape hatches (Tor exits are themselves widely
  engine-blocked; SearXNG docs treat proxies as the general mechanism).
- **Survival toolkit:** capped exponential backoff **with full jitter** per provider
  ([AWS](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)), rotating to
  another healthy member instead of sleeping when one exists; per-provider concurrency caps (1–2)
  plus a global cap; random-minus-last rotation (Farside's [`db/db.go`](https://github.com/benbusby/farside/blob/main/db/db.go)
  `GetInstance`) or weighted scoring from instances.json timing/uptime (instx's "judge").
  **Tor/proxy egress: NOT QUALIFIED** — Farside's README reports Cloudflare blocks Tor/VPN; 11 of
  92 instances are Tor-network (exclude them, as instx does); SearXNG's `outgoing.using_tor_proxy`
  exists, but Tor exits are engine-blocked in practice.
- **Design rule:** a SearXNG response with `results: []` **and** non-empty
  `unresponsive_engines[]` is **degraded, not empty** — fail over or serve stale-with-a-flag;
  report "empty" only when providers answered cleanly and found nothing. Use typed cooldowns per
  failure class — illustrative: 429 → ~1 h, captcha → ~1 d, modeled on SearXNG's `suspended_times`
  (whose exact defaults differ between `settings.yml` and the docs) — instead of retries.
- **Caching is the app's job.** SearXNG's valkey backs the limiter/favicons only — there is no
  built-in cross-request result cache
  ([settings_valkey.rst](https://github.com/searxng/searxng/blob/master/docs/admin/settings/settings_valkey.rst),
  [searx/limiter.py](https://github.com/searxng/searxng/blob/master/searx/limiter.py)); negative
  caching exists only at the engine layer (`ban_time_on_fail` / `suspended_times` — a failing
  engine is not retried for a typed period). TTL precedents: instx caches the instance list
  180 min; Farside cached its derived list 5 min with fallback-on-error instead of crashing.
  No OSS aggregator caches results end-to-end (verified absent across Vane/Morphic/LibreChat), so
  a `sha256(query)`-keyed TTL map in the composite is design inference — and the single biggest
  request-volume reducer available, since Marginalia already 503s on shared QPM.
  [searxng#3034](https://github.com/searxng/searxng/issues/3034) references maintainer-side query
  caching absorbing bursts.

## Dead ends — verified, do not re-research

Already keyed/paid (prior session): Brave Search API, Exa, Tavily, Serper; Bing Search API
retired Aug 2025. Verified dead or walled this session:

| Candidate | Status (evidence) |
|---|---|
| Whoogle | Terminated 2026-07-24 by author; Google killed its last working UA ([README](https://github.com/benbusby/whoogle-search)) |
| Mullvad Leta | Shut down 2025-11-27; domain dead ([blog](https://mullvad.net/en/blog/shutting-down-our-search-proxy-leta)) |
| Bing HTML scrape | `disabled = True` upstream; aggressive bot walls ([ddgs bing.py](https://github.com/deedy5/ddgs/blob/master/ddgs/engines/bing.py)) |
| Yandex HTML | `disabled = True`; SmartCaptcha ([ddgs yandex.py](https://github.com/deedy5/ddgs/blob/master/ddgs/engines/yandex.py)) |
| Ecosia | 403 to plain curl (Cloudflare); no API |
| Startpage | 302 challenge for plain clients; two-step token + impersonation only, marginal |
| Right Dao | 503; undocumented; no maintenance evidence |
| Stract (hosted) | No public API (`/beta/api/*` 404); AGPL self-host only |
| Mojeek API | Paid plans only; free trial needs signup |
| Reddit anonymous `.json` | 403 block pages from home IPs (live + [r/redditdev](https://www.reddit.com/r/redditdev/comments/1txd5mm/reddit_json_endpoints_returning_403/)); `old.reddit` → login redirect |
| PullPush | 429: "does not provide free scraping resources for agents" — paid via Discord |
| Semantic Scholar | Keyless tier 429s on first request (shared pool congested) |
| MusicBrainz | Artists only — wrong person domain |
| lobste.rs | No JSON search; controller explicitly nullifies SearXNG-class traffic ([source](https://github.com/lobsters/lobsters/blob/master/app/controllers/search_controller.rb)) |
| Farside (service) | Archived by author; use searx-space feed instead |
| Qwant API | JS-challenge-gated at the API surface |
| MetaGer | API requires paid "MetaGer Key" tokens |
| searchcode.com API | Endpoint 404 |
| duck-duck-scrape (npm) | ~18 months stale; scrapes the same 202-walled surfaces; `api.duckduckgo.com` also 202s |
| Common Crawl index | URL-prefix lookups only — no keyword search |
| archive.today | 429/CAPTCHA; no sanctioned API |
| OpenCorporates | 401 without token (signup) |
| Teclis | Cloudflare Turnstile on search |
| PublicWWW | Anonymous tier yields zero results; account required |
| Chronicling America | Cloudflare challenge; pre-1963 corpus anyway |
| OpenSanctions | API tokened; self-host `yente` only if screening becomes a need |
| Google/Bing cache | Both discontinued/removed (2024) |
| LinkedIn rel=me | LinkedIn does not support it |

## Uncertainties

- **Block rates at this app's exact volume** (tens/run, home IP) are unproven everywhere: engine
  blocking evidence comes from public-instance operator reports, not quiet home deployments.
- **Query-hash TTL result caching** has no OSS precedent (verified absent across
  Vane/Morphic/LibreChat) — the app-side cache is design inference: cheap to add, easy to drop.
- **Impersonated-client yields** (primp/curl-impersonate vs plain fetch) for DDG/Bing/Brave and
  for LinkedIn `site:` snippets were verified at the transport gate only; sustained-use data from
  one residential IP does not exist.
- **Wayback snapshot fidelity** for LinkedIn profiles (guest preview vs authwall capture) is
  unverified — availability API verified, content fetches timed out.
- **Numeric anonymous limits** unpublished for: Openverse (20/min·200/day is maintainer-issue
  sourced), HN Algolia, Crossref, Open Library, ROR, GLEIF, IA endpoints, news RSS surfaces, and
  the suggest endpoints. The SEC 10 req/s fair-access figure should be re-checked against
  sec.gov/developer before encoding a limiter.
- **Google/Bing News RSS usage restriction** ("personal, non-commercial feed rendering") is
  embedded in the feeds but the surfaces are undocumented; treat as a product-policy decision.
- **Marginalia `public` key** QPM ceiling is unpublished ("often hits a rate limit"); live probe
  hit it immediately.
- **Reddit RSS pacing** (~2–3 req/min) is inferred from `x-ratelimit-reset` behavior, not
  official docs; whether the `.json` 403s are fingerprint-dependent is unknown.
- **4get/YaCy self-host upstream-block behavior** at burst volumes is undocumented; YaCy RAM
  needs come from community reports, not the repo.
