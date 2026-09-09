# Anti-bot failures in the keyless HTML-scrape providers — Mojeek & DuckDuckGo

_Researched 2026-09-02 against primary sources (official API pages, SearXNG engine source code,
ddgs engine source, robots.txt files fetched live). Motivated by live observations from the
home IP on 2026-09-02: Mojeek intermittently served an anti-bot challenge page, and
DuckDuckGo's `html.duckduckgo.com/html` intermittently answered 202 captcha challenges (our
provider cools down 24 h). A same-hour a/b test (Chrome UA vs the app's programmatic UA, curl
vs Node undici, identical queries) showed Mojeek challenging and passing every variant at
different moments — **the gate is intermittent and volume-based, not UA-fingerprinted**; the
first pass had correlated the two by timing luck. Companion to
[public-search-providers.md](public-search-providers.md) — read its stack table for the full
provider list; this file only deep-dives the anti-bot question._

## Q1 — Mojeek: official API, policy, sanctioned keyless paths

**Official API exists but is paid-only; there is no free tier.**
[Mojeek's Web Search API page](https://www.mojeek.com/services/search/web-search-api/) lists
three pay-as-you-go plans (Startup £2 CPM / 5 qps / 100k queries per day; Business £3 CPM /
10 qps / 400k/day; Enterprise custom) with a "Free trial version, with limited queries. Get in
touch." — i.e. even the trial requires contacting them.
[public-search-providers.md](public-search-providers.md) verified the same live: paid plans
only, trial needs signup. There is no sanctioned keyless JSON surface.

**No stated public policy on automated querying of the web UI.** Mojeek's API pages
([pricing](https://www.mojeek.com/services/search/web-search-api/),
[request parameters](https://www.mojeek.com/support/api/search/request_parameters.html)) say
nothing about scraping the web UI; no blog post or docs page forbids or permits it explicitly.
The only written signal is their [robots.txt](https://www.mojeek.com/robots.txt), fetched live
2026-09-02:

```
User-agent: *
Disallow: /search
Disallow: /url
Disallow: /focus/dashboard
Disallow: /eval
Disallow: /image?
```

`Disallow: /search` covers the exact endpoint we scrape (`https://www.mojeek.com/search?q=…`).
Mojeek's own comment — "Let's treat everybody the same, bad bots will ignore it anyway" — reads
as anti-crawler guidance for crawlers, not as an API substitute. Strictly, a robots-honoring
client must not fetch `/search` programmatically; the intermittent challenge behavior is
consistent with Mojeek enforcing that line against automated clients under load.

**Sanctioned keyless paths: none of substance.** Their
[OpenSearch description](https://www.mojeek.com/opensearch.xml) (fetched live) only declares an
`text/html` template — `https://www.mojeek.com/search?q={searchTerms}` — with no RSS/JSON
response type. So there is no keyless sanctioned endpoint below the paid API.

**Consequence:** there is no header trick that reliably opens Mojeek — the gate is
intermittent and volume-based (live a/b 2026-09-02: every UA variant both passed and was
challenged within the hour), and using the HTML endpoint at all means knowingly fetching a
robots.txt-`Disallow`ed path. The legitimate options are: (a) don't scrape Mojeek, (b) pay
for the API, or (c) accept it as an explicit, user-approved exception for a single-user
personal tool at trivial volume (tens of queries per run), expecting intermittent
challenge cooldowns. Our repo's honest-degradation posture already handles (a) as the
default; the implemented provider is (c) with the default descriptive UA.

## Q2 — DuckDuckGo HTML: what SearXNG actually does

SearXNG ships a DDG engine and documents DDG's bot blocker in unusual detail in
[`searx/engines/duckduckgo.py`](https://github.com/searxng/searxng/blob/master/searx/engines/duckduckgo.py)
(AGPL-3.0, read 2026-09-02). Load-bearing findings from that source:

- **Endpoints considered stable:** `https://html.duckduckgo.com/html` and
  `https://lite.duckduckgo.com/lite`, both via **HTTP POST with form data** (the no-JS
  surfaces). The JSON endpoints (`links.duckduckgo.com/d.js`,
  `duckduckgo.com/i.js|v.js|news.js`) need the `vqd` "validation query digest"; SearXNG's
  note: "the `vqd` value is needed to pass DDG's bot protection", generally not needed for the
  first query but required for pagination — requesting page 2 without it "would lead to an
  immediate blocking".
- **The bot blocker is IP-based, not session-based** ("In DDG's bot blocker, the IP will be
  blocked (DDG does not have a client session!)"), historically a sliding window unblocking
  after ~1 h of quiet. Q3/Q4 2025 changed the mechanism in ways SearXNG doesn't fully
  document. A practical unblock mentioned in the source: run one real-browser DDG query from
  the blocked IP.
- **Headers SearXNG sends:** a generated browser-like UA (`gen_useragent()`), which is "also
  involved in the formation of the vqd value" (citing
  [DDG Bot Detection Research](https://github.com/ggfevans/searxng/blob/mod-sidecar-harvester/docs/ddg-bot-detection-research.md));
  `Sec-Fetch-Mode: navigate` mattered historically; `Accept-Language` is honored for region;
  and a `Referer: https://html.duckduckgo.com/` because DDG sets `Referrer-Policy: origin` and
  a real browser would echo it. Cookies: only `kl`/`df` (region/time-filter), no session
  cookies. Queries are capped at 499 chars.
- **Mitigation strategy:** not more headers — **suspension and fan-out**. SearXNG raises
  `SearxEngineCaptchaException` and the engine is suspended with staggered `suspended_times`
  (captcha 3600 s, access-denied 180 s; documented in
  [settings_search.rst](https://docs.searxng.org/admin/settings/settings_search.html)), while
  other engines keep answering; failures surface in `unresponsive_engines[]`. Per-engine
  `proxies` are the documented escape hatch, though Tor exits are widely engine-blocked.

**Robots.txt: DDG explicitly disallows both no-JS surfaces.**
[duckduckgo.com/robots.txt](https://duckduckgo.com/robots.txt) (fetched live 2026-09-02):

```
User-agent: *
Disallow: /lite
Disallow: /html
Disallow: /*?
Allow: /?*
```

So `html.duckduckgo.com/html` and `lite.duckduckgo.com/lite` are named disallow entries for
every agent. Any keyless use of them is knowingly robots-contrary — SearXNG ships it anyway
(community-run metasearch, different product posture), and [ddgs](https://github.com/deedy5/ddgs)
(MIT, ex-`duckduckgo_search`) does too, but only via `primp` with TLS/UA browser impersonation;
plain Node fetch is what produced our 202 wall ([public-search-providers.md](public-search-providers.md),
"the ddgs porting playback"). ddgs' engine module posts to `html.duckduckgo.com/html/` with a
form payload, precisely the stable no-JS path SearXNG documents.

**What triggers 202:** at minimum, non-browser TLS/UA fingerprints and per-IP volume; the
challenge is the bot blocker's IP-level response. SearXNG's evidence says pacing, a stable
browser-like UA, the full no-JS header set, and long cool-downs (hours, not retries) are what
keeps a quiet single-IP deployment working — the same guidance as their 3600 s captcha
suspension.

## Q3 — General best practice for a small personal tool

**Header set that works for minimal browser-ish clients.** Synthesis of the SearXNG engine
source above and the seam's live findings (GitHub 415 / GLEIF XML from the HTML-only `accept`
header — [public-search-providers.md](public-search-providers.md), repo-specific caveat 4): for
each provider, send exactly what a real browser to that endpoint would send — no more, no less:

- A **stable, browser-like `User-Agent`** (do not rotate per request if the endpoint derives
  anything from the UA — DDG's `vqd` does), or a **descriptive programmatic UA with contact
  info** for APIs that prefer it (SEC EDGAR requires one; Wikimedia etiquette asks for a
  descriptive UA — [API:Etiquette](https://www.mediawiki.org/wiki/API:Etiquette)).
- `accept` matching what the endpoint really serves: `application/json` for JSON APIs (already
  applied to GitHub/ROR/GLEIF/Openverse), `text/html,application/xhtml+xml` plus
  `application/xml` for HTML scrapes, `application/rss+xml` for feeds.
- For browser-ish HTML endpoints: `accept-language: en-US,en;q=0.9`, `referer` set to the
  search form's origin (DDG: `https://html.duckduckgo.com/`), and the `sec-fetch-*` headers a
  form navigation produces (`sec-fetch-mode: navigate`, `sec-fetch-site: same-origin`).
  `sec-ch-ua` client hints are optional; SearXNG does not send them for DDG and works.
- **POST, not GET, for DDG html/lite** (form-encoded `q`), per the SearXNG source.

**Does mimicking a browser change the ethics/ToS picture?** No — it makes it _worse_, not
better. Fingerprint mimicry exists precisely to defeat the operator's explicit bot-detection
decision, and here it operates against endpoints both sites **name in robots.txt as
disallowed**. A descriptive programmatic UA is the honest signal; sending it and being
challenged is the operator's answer. The repo already accepts "honest degradation" — the
consistent posture is: descriptive UA, respect challenges, cool down, and rely on sanctioned or
API surfaces rather than on ever-more-convincing impersonation.

**robots.txt bottom line for these two sites:** both disallow the exact HTML search endpoints
under `User-agent: *` ([Mojeek](https://www.mojeek.com/robots.txt): `/search`;
[DDG](https://duckduckgo.com/robots.txt): `/html`, `/lite`, plus all query strings off the
root). Scraping them is only defensible as a conscious, documented product exception for a
single-user tool — not as the designed data path.

## Recommended fix per provider

Providers are the HTML-scraping ones from the
[public-search-providers.md](public-search-providers.md) stack table (rows 5, 25, and the
scrape-dependent tiers).

| Provider | Sanctioned / best approach | Evidence | Expected reliability | When it still fails |
| --- | --- | --- | --- | --- |
| **DuckDuckGo HTML** | No sanctioned keyless web-search API exists (the old `api.duckduckgo.com` instant-answer API is not web search and also 202s — [dead ends](public-search-providers.md)). Best-effort scrape per SearXNG's documented flow: **POST** `https://html.duckduckgo.com/html/` form-encoded `q`, stable browser-like UA, `referer: https://html.duckduckgo.com/`, `accept-language`, `sec-fetch-mode: navigate`, optional `kl`/`df` cookies, queries ≤ 499 chars, never paginate without `vqd`. **First page of two per run, hours-long cooldown on 202** — SearXNG suspends captcha'd engines 3600 s ([source](https://github.com/searxng/searxng/blob/master/searx/engines/duckduckgo.py)); our 24 h is a fine, stricter variant. `lite.duckduckgo.com/lite` is the equivalent alternate surface, same rules. robots.txt disallows both — same "documented exception" caveat as Mojeek. At this app's quiet home-IP volume the composite already answered 6/6 in 0.7–0.9 s on 2026-09-02, so the 202s look volume/fingerprint-triggered, not permanent. | [SearXNG duckduckgo.py](https://github.com/searxng/searxng/blob/master/searx/engines/duckduckgo.py); [robots.txt](https://duckduckgo.com/robots.txt); [ddgs](https://github.com/deedy5/ddgs) | Medium — intermittently challenged under volume; good at single-user pace with the full header set | Cooldown + "degraded" verdict (current behavior is correct); the self-hosted SearXNG fan-out absorbs the query. Upgrading to `primp`/curl-impersonate is the _technical_ fix but contradicts the posture below — needs an explicit product decision |
| **Brave HTML / Yahoo / Google WML** (stack row 25) | Do not adopt. All are unsanctioned scrapes needing impersonation-grade clients; Google WML rides a Nokia-UA trick; Brave/Yahoo engines are ToS-grey and fragile. | [ddgs engines](https://github.com/deedy5/ddgs); [dead-ends table](public-search-providers.md) | Low | n/a — these providers are the "GREY" tier; skip |
| **Mojeek HTML** | Default: **drop the HTML scrape** — no free API tier, no RSS/OpenSearch JSON, robots.txt disallows `/search`. If Mojeek results matter, the only sanctioned route is the [paid Web Search API](https://www.mojeek.com/services/search/web-search-api/) (from £2 CPM, contact-for-trial) behind an explicit user decision. If kept as a documented single-user exception (what the repo ships): `GET https://www.mojeek.com/search?q=…` with the default descriptive UA — the gate is volume-based, not UA-fingerprinted (live a/b 2026-09-02), so no header set helps — 1 concurrent, parse `ul.results > li` (`h2/a`, `p.s`) per [ddgs mojeek.py](https://github.com/deedy5/ddgs/blob/master/ddgs/engines/mojeek.py). | [API pricing](https://www.mojeek.com/services/search/web-search-api/); [robots.txt](https://www.mojeek.com/robots.txt); [opensearch.xml](https://www.mojeek.com/opensearch.xml) (html template only); live challenge + a/b 2026-09-02 | Low as an unsanctioned scrape (intermittently gated); high via paid API | Treat a challenge page as a typed captcha cooldown (24 h, as today) and let the fan-out cover the query; do not retry or rotate UAs to get through |

### Transport-level fixes that are unambiguously legitimate (apply regardless)

1. **Per-provider `accept` headers** — JSON APIs get `accept: application/json` (already
   applied to GitHub/ROR/GLEIF/Openverse; GitHub 415 and GLEIF XML were both this class).
2. **A stable, descriptive default UA with contact info** for API surfaces; a stable
   browser-like UA (not rotated) only for the DuckDuckGo HTML exception.
3. **Per-provider timeouts and concurrency caps** — GDELT's 15–75 s exceeded the seam's 20 s
   abort; HTML scrapes get concurrency 1 and spacing.
4. **Typed cooldowns per failure class** (429 → ~1 h, captcha → ~1 d, network → short) instead
   of retries — SearXNG's `suspended_times` is the model.

## Bot-detection posture (ADR-level)

This app is a local-first, single-user personal tool querying public endpoints from one
residential IP at trivial volume. Our posture, and we should hold it: **never impersonate to
defeat a bot gate we have not been invited past.** Concretely — send honest, descriptive UAs to
APIs and RSS surfaces (the overwhelming majority of our providers, all of which work with plain
fetch); where we do scrape browser surfaces (Mojeek, DDG html/lite), we do so as a documented
single-user exception, with browser-like but _stable_ headers, tiny volume, and no
TLS/JA3-impersonation client; and every challenge (202, captcha, 403) is treated as the
operator's answer — a typed cooldown plus a "degraded" verdict, with the fan-out and the
self-hosted SearXNG layer absorbing the query. If a provider becomes load-bearing enough to
justify defeating its gate (Mojeek API subscription is the live candidate), the legitimate path
is to pay for the sanctioned API, not to get better at impersonation. robots.txt for both sites
under discussion explicitly disallows their HTML search endpoints; that fact, not header
cleverness, is what frames the exception.
