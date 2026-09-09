# Content Scout source-adapter research

_Researched 2026-08-25 for GitHub issue [#20](https://github.com/nicolas-found42/chief-of-staff-demo/issues/20). Repository activity and star counts are point-in-time signals, not selection criteria._

## Question

Which fully open-source collection avenues can Content Scout use to monitor RSS, Substack,
ordinary websites, LinkedIn, Reddit, YouTube, TikTok, and Instagram without storing a person's
authenticated social-media session?

“Every avenue” here means every materially different technical route, not every GitHub repository
that happens to contain the word _scraper_. The routes evaluated were:

1. an official public API or first-party feed;
2. public HTML or embedded page data;
3. an unofficial public-web client;
4. a media downloader/extractor;
5. a self-hosted feed, proxy, or alternate frontend;
6. a general crawler plus site-specific extraction; and
7. local speech-to-text when no transcript is published.

The search began with [Awesome Web Scraping](https://github.com/lorien/awesome-web-scraping),
[Awesome OSINT](https://github.com/jivoi/awesome-osint),
[Social Media OSINT Tools Collection](https://github.com/osintambition/Social-Media-OSINT-Tools-Collection),
and [Social Media Hacker List](https://github.com/MobileFirstLLC/social-media-hacker-list), then
followed candidates to their repositories and primary documentation. Commercial scraper catalogs,
hosted-only APIs, repositories without an identifiable open-source license, abandoned wrappers,
and tools that require a logged-in social session were not counted as viable adapters.

## Conclusion

There is no credible universal social scraper. Content Scout should have a small shared crawling
core and separate adapters with honest capability states. The robust first release is:

| Source | First route | Fallback/enrichment | Initial state |
| --- | --- | --- | --- |
| RSS and Substack | Native RSS/Atom with `rss-parser` | `yt-dlp` for Substack audio/video | Available |
| Recurring websites/pages | Crawlee HTTP crawl + Mozilla Readability | Crawlee Playwright for JavaScript pages | Available |
| YouTube, Shorts included | Existing YouTube Data API connection | `youtube-transcript-api`, then `yt-dlp`; local Whisper only when needed | Available |
| Reddit | Public RSS for configured communities/searches | Public JSON/HTML and `yt-dlp` for individual media | Experimental |
| Instagram/Reels | Instaloader for public profiles and posts | `yt-dlp` for individual Reels; local Whisper | Experimental |
| TikTok | `yt-dlp` for public users/videos | Pyktok for comments and related videos; local Whisper | Experimental |
| LinkedIn | Public-page prototype built with Crawlee Playwright | Public web discovery and `yt-dlp` only for supported video/event URLs | Coming later |

This is deliberately an asymmetric stack. Calling brittle public-page extraction “Available” just
because a GitHub project exists would repeat the Relay failure mode: one opaque LinkedIn scraper
was a single point of failure for the whole workflow. “Available” should require a fixture-backed
adapter contract, a successful live canary, structured diagnostics, and a documented degraded mode.

## Shared adapter contract

Every adapter should return the same small envelope and keep platform-specific details inside raw
evidence:

```text
SourceItem
  externalId, canonicalUrl, sourceTargetId
  author/account, title, body/description
  publishedAt, discoveredAt
  media[], transcript?, comments[]
  evidence[] (URL + retrieval method + observed time)
  completeness (fields obtained, fields unavailable, fields failed)
```

The contract must distinguish “the platform did not publish this field,” “this route does not
support the field,” and “retrieval failed.” A successful description fetch must not silently turn a
failed comment or transcript fetch into complete data.

The common implementation should provide URL canonicalization, bounded concurrency, conditional
requests, per-host backoff, deduplication, raw-response receipts, fixture replay, and structured
failure records. Platform adapters should remain thin. One adapter failing must not stop the other
adapters from running.

## Cross-source building blocks

### Crawling and article extraction

[Crawlee](https://github.com/apify/crawlee) is the best fit for this TypeScript/Node application.
It is Apache-2.0 licensed, actively maintained, and exposes raw HTTP/Cheerio and Playwright crawlers
through one API. Its own guidance recommends starting with the faster HTTP crawler and using a real
browser only for JavaScript-rendered pages. [Mozilla Readability](https://github.com/mozilla/readability)
(Apache-2.0) can turn a fetched article page into the title, byline, excerpt, and readable body.

Alternatives are valid but add a second runtime or service boundary:

- [Scrapy](https://github.com/scrapy/scrapy) (BSD-3-Clause) is the mature Python framework.
- [Crawl4AI](https://github.com/unclecode/crawl4ai) (Apache-2.0) is a Python crawler optimized for
  LLM-ready extraction.
- [Firecrawl](https://github.com/firecrawl/firecrawl) (AGPL-3.0) is a substantial self-hosted crawl
  service. Its hosted product is not the requested fully open-source local dependency, and running
  the service would add operational complexity that Content Scout does not yet need.

Recommendation: Crawlee plus Readability in-process. Do not add a general crawler service until a
measured need justifies it.

### Feed parsing and feed synthesis

[rss-parser](https://github.com/rbren/rss-parser) is a small MIT-licensed Node parser for RSS and
Atom. Feed discovery should check HTML `<link rel="alternate">` elements before inventing a custom
scraper. Substack publications expose normal publication feeds, while the
[yt-dlp Substack extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/substack.py)
can enrich an individual post containing hosted audio or video.

[RSSHub](https://github.com/DIYgod/RSSHub) (AGPL-3.0) synthesizes thousands of feeds and has routes
for many sites. It is a useful optional self-hosted compatibility layer, not the default dependency:
routes vary in authentication, anti-bot behavior, and maintenance, and the service becomes another
component to operate and diagnose.

### Media metadata and download

[yt-dlp](https://github.com/yt-dlp/yt-dlp) is the broadest permissively licensed extraction layer
found. Its current extractor set includes YouTube, Reddit, Substack, TikTok users and individual
videos, Instagram posts/Reels, LinkedIn-hosted video/events/learning, and many ordinary media sites.
Its [supported-site list](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) also marks
broken surfaces explicitly—for example, Instagram user enumeration is currently broken while
individual Instagram posts remain supported. It should therefore enrich known URLs, not masquerade
as the discovery mechanism for every platform. The project recommends frequent/nightly updates
because websites change often.

### Transcript fallback

Prefer a platform-published transcript or caption track. If none exists and Content Scout can
lawfully retrieve the public media, it can transcribe locally with
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT). It avoids a Python runtime and can use
CPU or supported local accelerators. [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
and [OpenAI Whisper](https://github.com/openai/whisper) are good MIT-licensed Python alternatives.

Local transcription is enrichment, not an Intake prerequisite: it is expensive, media downloads
can fail, and a full-content pack should still be possible from titles, descriptions, captions, and
comments when the evidence is sufficient.

## Platform findings

### YouTube and YouTube Shorts

YouTube is the strongest adapter because this repository already has a working Google OAuth and
YouTube Data API integration.

Viable avenues:

1. **Official Data API.** The [YouTube Data API](https://developers.google.com/youtube/v3/docs)
   supports channel, playlist, video, search, and comment-thread reads. Known channels should be
   walked through their uploads playlist; search should be reserved for discovery. Google's
   [quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost) currently
   separates `search.list` into a default 100-call/day bucket while allocating 10,000 units/day to
   most other methods. Shorts are ordinary video resources, so they do not require a separate
   scraper.
2. **Official channel feed.** A channel feed is a low-cost signal for new uploads, but it carries
   less metadata and no comments. Treat it as a wake-up route, then hydrate with the Data API.
3. **Public transcript client.** [youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api)
   (MIT) retrieves manual and auto-generated public transcripts without an API key or browser.
   Its issue history documents IP blocking, especially from cloud-provider ranges, so the adapter
   needs a distinct `blocked_by_youtube` diagnostic and a fallback.
4. **InnerTube client.** [YouTube.js](https://github.com/LuanRT/YouTube.js) (MIT) implements
   YouTube's internal InnerTube API in TypeScript. It covers surfaces missing from the official API
   but is unofficial and therefore belongs behind an Experimental capability, not the default.
5. **Media extractor.** `yt-dlp` can obtain public video metadata, caption tracks, and media. Use it
   for a known URL when the transcript client fails or local speech-to-text is required.
6. **Self-hosted frontends.** [Invidious](https://github.com/iv-org/invidious) and
   [Piped](https://github.com/TeamPiped/Piped) are AGPL alternate frontends. They are operationally
   much larger than an adapter and unnecessary while the official API works.

The official [captions API](https://developers.google.com/youtube/v3/docs/captions/list) requires
authorization and is designed around authorized caption resources; it is not the route for
transcribing arbitrary public competitor videos.

Recommendation: official Data API for discovery, metadata, and comments; public transcript client
for captions; `yt-dlp` and local Whisper as bounded fallbacks. This adapter can be Available.

### Reddit

Viable avenues:

1. **Public RSS.** Subreddits, users, and some searches expose RSS variants. This is the only truly
   anonymous monitoring path with a feed shape, but it is not a guaranteed Data API contract and
   may be throttled.
2. **Public JSON/HTML.** Listing and post URLs have historically exposed JSON or server-rendered
   data. These reads can be blocked or rate-limited and should use slow polling, caching, an explicit
   user agent, and fixture-backed parsers.
3. **Official Data API.** [Reddit's Data API guidance](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)
   says clients must authenticate with a registered OAuth token and unidentified clients may be
   throttled or blocked. [PRAW](https://github.com/praw-dev/praw) (BSD-2-Clause) is the established
   Python wrapper, but introducing Python only for an authenticated route would not satisfy the
   current anonymous-only product choice.
4. **Individual media.** The `yt-dlp` Reddit extractor reads an individual post's metadata and
   hosted video/captions. It does not replace community or search discovery.
5. **Historical archives.** Arctic Shift is useful for research dumps and historical lookup, but
   its repository currently exposes no recognized license. It is not acceptable as a shipped
   dependency or core live source.

Recommendation: begin with RSS plus cautious public JSON/HTML enrichment and label Reddit
Experimental. If reliability proves insufficient, the honest product choice is to let a user add
a Reddit API client—not to hide an account session or promise stable anonymous access.

### Instagram and Reels

Viable avenues:

1. **Instaloader.** [Instaloader](https://github.com/instaloader/instaloader) (MIT) enumerates public
   profiles and downloads posts, Reels, captions, and metadata without requiring login for the
   basic public-profile route. Its documentation makes the boundary clear: private profiles,
   stories, feeds, saved posts, followed-account lists, hashtags, locations, and some richer fields
   require login. Comment collection exists but is more likely to encounter login/rate limits.
2. **Individual post/Reel extraction.** The `yt-dlp` Instagram extractor supports individual
   posts/Reels and can expose descriptions, media, and comments when Instagram returns them. Its
   own supported-site registry currently marks Instagram user-profile enumeration broken.
3. **Gallery downloader.** [gallery-dl](https://github.com/mikf/gallery-dl) (GPL-2.0) is a broad and
   active media-gallery downloader. It is a reasonable command-line fallback, but adds little over
   Instaloader plus `yt-dlp` for this workflow and often needs cookies for restricted content.
4. **Official Instagram APIs.** Meta's APIs are consented-account management APIs, not an anonymous
   competitor-monitoring API. They require tokens and account/app permissions, so they are outside
   the current product choice.
5. **Private API clients.** Instagrapi and similar projects emulate Instagram's private API and
   expect an authenticated account. They are excluded even before considering packaging and license
   ambiguity.

Recommendation: Instaloader for public target enumeration, `yt-dlp` for a known Reel, and local
Whisper only when captions are absent. Descriptions and basic metadata are baseline; comments are
best-effort enrichment. Keep the adapter Experimental until live canaries prove anonymous scheduled
runs remain useful.

### TikTok

Viable avenues:

1. **`yt-dlp`.** Its TikTok extractor supports individual public videos and user collections and
   can retrieve descriptions, media metadata, and published caption tracks. Some tag/effect/sound
   collection extractors are explicitly marked broken. It does not provide comment bodies.
2. **Pyktok.** [Pyktok](https://github.com/dfreelon/pyktok) (BSD-3-Clause) reads JSON embedded in
   TikTok pages and undocumented endpoints. It can collect a public video, approximately 30 videos
   from a user/hashtag/related-video page, and comments. Its README warns that functions may require
   browser cookies, bot blocks can occur, counts are approximate, and TikTok changes can break it
   suddenly. It is valuable as an experimental enrichment worker, not a reliability foundation.
3. **TikTok-Api.** [TikTok-Api](https://github.com/davidteather/TikTok-Api) (MIT) wraps logged-out
   TikTok surfaces and does not implement user-authenticated operations. In practice its quick start
   obtains an `ms_token` from browser cookies, it runs Playwright, and its documentation recommends
   proxies when TikTok blocks automation. That cookie dependency conflicts with the strict
   no-session product choice.
4. **Rendered-page comment collector.** [TikTokCommentScraper](https://github.com/cubernetes/TikTokCommentScraper)
   (MIT) scrolls comments in a person's already-open browser and copies rendered data. It proves a
   route exists but is interactive, stale, and not suitable for a scheduled server worker.
5. **Official APIs.** TikTok's [Display API](https://developers.tiktok.com/doc/display-api-get-started/)
   requires a user authorization code/access token and displays that consenting user's videos. The
   [Research API](https://developers.tiktok.com/doc/research-api-get-started) can query public
   accounts and videos but is eligibility/application gated. Neither is the universal public app
   adapter requested here.

Recommendation: `yt-dlp` as the first public route, with Pyktok as a separately measured comment
and related-video experiment. Do not ingest a browser's TikTok cookies. Keep TikTok Experimental.

### LinkedIn

This is the weakest platform and the clearest place to avoid false confidence.

Official reality: LinkedIn's [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api)
requires organization social permissions and restricts reads to organizations where the
authenticated member has an eligible page role; member social reads are approved-user only. It
does not provide anonymous monitoring of arbitrary people or companies.

Repositories evaluated:

| Project | License | What disqualifies it for this product choice |
| --- | --- | --- |
| [pratik-dani/LinkedIn-Scraper](https://github.com/pratik-dani/LinkedIn-Scraper) | AGPL-3.0 | Requires a valid LinkedIn account despite using HTTP rather than a browser. |
| [joeyism/linkedin_scraper](https://github.com/joeyism/linkedin_scraper) | GPL-3.0 | Playwright flow requires login/session state. |
| [linvo-scraper](https://github.com/linvo-io/linvo-scraper) | MIT | Authenticated automation, describes itself as valid for 2022, and is not a reliable current collector. |
| christophe-garon/Linkedin-Post-Scraper | No recognized license | GitHub source availability alone does not grant open-source reuse rights. |

`yt-dlp`'s LinkedIn extractor is limited to supported video/event/learning URLs; it does not enumerate
arbitrary profile or company posts. Public search results and public HTML may expose a small subset
of posts, but they are incomplete and susceptible to login walls.

Recommendation: build a narrow Crawlee/Playwright proof for explicitly public company/activity
pages, search-discovered post URLs, and individual media. Do not ship it as Available until it passes
scheduled anonymous canaries over time. If it cannot, leave LinkedIn Coming later. Do not substitute
a hidden shared LinkedIn account, cookie import, or an unlicensed scraper.

### Ordinary websites and custom recurring pages

Viable avenues, in order:

1. feed auto-discovery and polling;
2. sitemap discovery constrained to the same origin and user-approved path prefix;
3. Crawlee HTTP fetch plus Readability extraction;
4. Crawlee Playwright only for pages whose meaningful content requires JavaScript; and
5. a site-specific adapter only after repeated evidence that the generic routes cannot express the
   source.

The target is the recurring site/page/section, not an individual article. Each target needs an
allowlisted origin, crawl depth/page ceiling, time budget, and visible last-success/last-failure
receipt. Respect robots directives and site terms; do not attempt CAPTCHA bypass or stealth login.

### Related and recommended account discovery

No single open-source tool reliably exposes every platform's private recommendation graph. Source
Discovery should combine bounded evidence routes:

- platform-native public search where the Available/Experimental adapter supports it;
- accounts cited, mentioned, tagged, interviewed, reposted, or linked by approved Source Targets;
- public “related,” “recommended,” or “you may like” results when the adapter can observe them
  without a session—Pyktok's related-video route is one example;
- YouTube channel search through the existing Data API;
- recurring sites discovered from blogrolls, author pages, podcast guests, citations, and outbound
  links; and
- an optional self-hosted [SearXNG](https://github.com/searxng/searxng) (AGPL-3.0) provider for
  bounded web search if operating a metasearch service becomes worthwhile.

SearXNG is open source but not a magic independent index: it aggregates upstream search services
and can be blocked by them. Common Crawl is an open historical web corpus, useful for later deep
discovery but too stale and operationally large for the first weekly workflow.

Every suggestion should store `discoveredBecause`, the evidence URL(s), similarity factors, and the
retrieval route. Similarity to the Brand Profile is a ranking signal, not proof that a source is
valuable. A person must approve a suggestion before it becomes a scheduled Source Target.

## Rejected shortcuts

- **Commercial scraper APIs and Apify actors:** they may be useful products, but they do not meet
  the requirement that the collection implementation be fully open source and free to run locally.
- **Repositories without a license:** visible source is not enough. They cannot be incorporated or
  redistributed safely as open-source dependencies.
- **Imported browser cookies or shared scraper accounts:** these silently change “public
  monitoring” into authenticated automation, create security and account-ban risk, and contradict
  the chosen operating model.
- **One headless browser for every source:** it is slower, noisier, and less diagnosable than feeds,
  official APIs, or plain HTTP. Browser rendering belongs at a documented fallback boundary.
- **One universal success flag:** partial extraction is normal. Completeness and per-capability
  diagnostics are required to tell “no transcript exists” from “the scraper broke.”

## Release gates

An adapter should move from Coming later to Experimental only when it has:

1. an OSI-style license-compatible implementation path;
2. no required user social-media session under the current product choice;
3. checked-in response fixtures for each claimed capability;
4. a bounded live canary against at least three representative public Source Targets;
5. structured error classification, response receipts with secrets stripped, and retry/backoff; and
6. a UI capability statement saying exactly which fields may be missing.

It should move from Experimental to Available only after repeated scheduled canaries demonstrate a
useful success rate and every expected platform change becomes a loud adapter event rather than an
empty successful shortlist. A repository's stars or a one-time successful scrape is not that proof.

## Recommended implementation sequence

1. Ship the shared adapter contract, diagnostics, RSS/Substack, ordinary websites, and YouTube.
2. Add Reddit RSS/public-page collection behind Experimental and measure it.
3. Add Instagram via Instaloader and TikTok via `yt-dlp`, each isolated in its own worker boundary.
4. Add transcript fallback after source discovery is working; it must not block Intake.
5. Prototype LinkedIn last. Promote it only on evidence; otherwise keep the honest Coming later
   state.
6. Add weekly Source Discovery from approved-target citations and platform search before operating
   a self-hosted general metasearch service.

This sequence produces a robust useful workflow without making the first Run coordinate six brittle
social scrapers, a metasearch engine, and local video transcription simultaneously.
