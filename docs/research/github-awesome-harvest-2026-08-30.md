# GitHub awesome-list & code-example harvest — LinkedIn-free Content Research, engagement ledger, and meeting intelligence

Research for [#115](https://github.com/nicolas-found42/chief-of-staff-demo/issues/115), [#21](https://github.com/nicolas-found42/chief-of-staff-demo/issues/21), [#23](https://github.com/nicolas-found42/chief-of-staff-demo/issues/23), and the Relay-to-Modules map [#12](https://github.com/nicolas-found42/chief-of-staff-demo/issues/12). Written 2026-08-30 against `main` at `d4bf128`. Additive to [`docs/research/linkedin-reading-options.md`](linkedin-reading-options.md) (2026-08-29, 684 lines) and [`docs/research/content-scout-source-adapters.md`](content-scout-source-adapters.md) — does not re-decide LinkedIn, surfaces what GitHub's awesome lists and real code actually ship that would satisfy the jobs without LinkedIn.

Every factual claim carries the primary URL it came from. Where a source could not be reached, or where a claim rests on inference rather than a document, it is marked **Unverified**. Stars / last-push are point-in-time signals, not selectors.

---

## 0. TL;DR — verdict in one table

| Question | Answer | Why |
|---|---|---|
| Can we rebuild #21 Content Research on LinkedIn via an awesome-listed scraper? | **No.** | `User-agent: * Disallow: /` on every path — <https://www.linkedin.com/robots.txt> — plus User Agreement §8.2 bans scrape/copy/bypass and reaches data "through third parties (such as … data aggregators or brokers)" — <https://www.linkedin.com/legal/user-agreement>. Every awesome-listed LinkedIn scraper found requires login/cookie/session and violates Content Scout's stated posture: "Respect robots directives and site terms; do not attempt CAPTCHA bypass or stealth login" — `content-scout-source-adapters.md:291`. |
| Can we buy the signal via Bright Data / Apify / Unipile etc? | **Not within this app's posture.** | Bright Data does sell a LinkedIn posts dataset (11.6M+ records, $250/100k — <https://brightdata.com/products/datasets/linkedin>). Apify's store lists many LinkedIn Actors (see §4.2). Proxycurl is gone — <https://nubela.co/proxycurl> → "Proxycurl is no longer in service. See NinjaPear" — and reverseContact Activities (`POST /v2/fetch/persons/posts/live` etc) were **discontinued 2026-07-01 with no replacement** — <https://app.reversecontact.com/docs/public/guides/july-2026-platform-update>. Buying LinkedIn-derived data does not waive UA §8.2's aggregator clause, and every remaining vendor either requires a LinkedIn session/cookie (Unipile — <https://www.unipile.com/linkedin-api/> + <https://developer.unipile.com/docs/linkedin>) or is an unlicensed scraper that would inherit the same durability failure that created #115. |
| What does GitHub actually ship that *does* satisfy #21 without LinkedIn? | **A generic RSS + website + YouTube + Reddit stack feeding an LLM-scored briefing** | 11 candidates prove it in the wild with fixtures/polite fetching (see §3). Strongest templates: `umputun/newscope` (interest-profile scoring), `kronprinzmagma/ki-news-aggregator` (14 sources → Claude Haiku → GitHub Issue brief), `DanieleGiovanardi2408/idea-radar` (8 sources + 20 RSS, velocity-based opportunity ranking, local embeddings, offline via Ollama), `claude-world/trend-pulse` (20 free sources, zero auth, CLI+lib+MCP). All use **zero or one LLM key in Shell config** — fits ADR-0001 / ADR-0011 / ADR-0016. |
| What does this mean for #23 ledger? | **Do not rebuild as-specified; ship a resonance ledger keyed on `(person, canonicalUrl)` from public signals** | No official API returns personal LinkedIn reactions (§1.2 of linkedin-reading-options.md). The credible ledger outside LinkedIn is: Bluesky `likeCount/repostCount/replyCount` (<https://docs.bsky.app/docs/api/app-bsky-feed-getAuthorFeed>), Mastodon `favourites_count/reblogs_count` (<https://docs.joinmastodon.org/methods/timelines/>), HN Algolia `points/num_comments` (<https://hn.algolia.com/api>), YouTube `viewCount/likeCount/commentCount` (<https://developers.google.com/youtube/v3/docs>), Reddit `score/num_comments`, Google News frequency — all public, all keyless except YouTube/PH (single key). See §6 for two concrete Module shapes. |
| What does this mean for #114 / #22 / #18 meeting intelligence? | **Own the transcript pipeline locally** | Awesome-whisper + awesome-ai-meeting-notes converge on Whisper + pyannote local; SaaS bot-in-meeting is the anti-pattern for a local-first app. Details in §5. |

The strongest case *against* this recommendation is Bright Data — §7 states it fully so the decision is legible.

---

## 1. Methodology

1. Enumerated every awesome list named in the handoff (§4 What to search) plus adjacent creative slices — one `web_search site:github.com awesome-<slice>` per slice → top 1–2 repos by stars → read raw `README.md` via `https://raw.githubusercontent.com/.../README.md` and `gh api repos/<nwo>` for `stargazers_count / pushed_at / license.spdx_id`.
2. For candidates, followed each list link to its repository and primary docs (GitHub repo + first-party API docs, not list blurb). Skipped any entry requiring API key / cost where the inclusion checklist demands keyless, flagged AGPL-3.0 self-host boundary explicitly.
3. Ran `searchGitHub` (`xd://mcp__gh_grep_searchgithub`) and `gh search repos` complement for each starter query in §4 (linkedin scraping, rss aggregator scoring, trending topics detector, meeting debrief, sheets upsert, etc.). Collected stars, license, language, demonstrated shape.
4. For every vendor surfaced, pulled **primary** ToS / API docs / pricing / `robots.txt` stance — not README claims. LinkedIn terms from <https://www.linkedin.com/legal/user-agreement>, <https://www.linkedin.com/legal/l/api-terms-of-use>, <https://www.linkedin.com/robots.txt>, <https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access>, <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api>, Member Data Portability at <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-member/>.
5. Assessed each candidate against two project gates: Shell credential shape (ADR-0001 single-user local-first — <https://github.com/nicolas-found42/chief-of-staff-demo/blob/main/docs/adr/0001-local-first-single-user.md>, ADR-0007 per-user OAuth client, ADR-0011 Shell owns connection, ADR-0016 YouTube rides Google connection) and Content Scout posture (clean anonymous public browser, no login, no imported cookies, no CAPTCHA bypass, respect `robots.txt` — `content-scout-source-adapters.md:291`).
6. Six parallel harvest slices dispatched via `task` (linkedin/scraping/osint · rss/newsletter/content · transcription/meeting · google/notion/hubspot · creative adjacent · vendor durability). Two slices completed fully before wall-time (Creative Adjacent, VendorDurabilityToS); two yielded partial markdown fragments via `history://` (`AwesomeRSSNewsletter` 27,932 bytes, `CreativeAdjacent` 33,200 bytes); two were synthesized from `gh api` + raw README reads in this session. All primary URLs cited; gaps marked Unverified.

Existing notes matched per repo convention: `docs/research/*.md` untracked, primary-source-traced, `Unverified` sections explicit — per `docs/research/dev-tooling.md` and `content-scout-source-adapters.md` citation discipline.

---

## 2. Awesome lists surveyed

Stars / last-push at 2026-08-29–30 `gh api` time. License field is repo's `license.spdx_id`; `NOASSERTION` means GitHub reports no recognized license.

| # | Awesome list (repo) | Stars | Last push (`pushed_at`) | License | Section(s) mined | Yield for this app |
|---|---|---|---|---|---|---|
| 1 | [awesomelistsio/awesome-linkedin](https://github.com/awesomelistsio/awesome-linkedin) — `brandonhimpfen/awesome-linkedin` | **Unverified** (list is a CC BY-SA 4.0 index, not a scraper) | — | CC BY-SA 4.0 (README footer) | Official Resources, APIs & SDKs, Data & Analytics, Recruitment | Thin. Lists official LinkedIn REST API, `python-linkedin`, `linkedin-api`, `linkedin-private-api` (all **require auth/session**), plus SaaS analytics (Shield, Socialinsider) and PhantomBuster automations — no anonymous post-collection tool that passes posture. Confirms need to go beyond LinkedIn lists. |
| 2 | [lorien/awesome-web-scraping](https://github.com/lorien/awesome-web-scraping) | 10,400+ (**Unverified** — `gh api repos/lorien/awesome-web-scraping` read in slice) | — | NOASSERTION (list) | Python / JavaScript / Go / CLI / Captcha Solving / Proxy Marketplaces + `python.md` / `javascript.md` | **Framework layer.** Points to Crawlee, Playwright-stealth anti-patterns, Scrapy, rss-parser, Readability — not LinkedIn-specific. Useful for generic website adapter choice (already decided: Crawlee + Readability). |
| 3 | [jivoi/awesome-osint](https://github.com/jivoi/awesome-osint) | 28,852 | 2026-08-25T21:17:45Z | NOASSERTION | General Search, Google Dorks, Main National Search Engines, Social Media Tools → LinkedIn / TikTok / Reddit / Instagram, News / Web Monitoring / Company Research / Data & Statistics | **Richest adjacent mine.** LinkedIn subsection lists `linkedin-scraper`, `CrossLinked`, `OSINT STUFF TOOL COLLECTION` — all require session or breach the clean-browser rule. Value is not LinkedIn itself but the *other* sections (News, Web Monitoring, Company Research) that name RSS/Reddit/HN/YouTube-adjacent sources reused in §6. |
| 4 | [CIPHER387/OSINT_STUFF_TOOL_COLLECTION](https://github.com/CIPHER387/OSINT_STUFF_TOOL_COLLECTION) | 11,600+ (**Unverified**) | — | NOASSERTION | Social Media → LinkedIn tools (mirrors jivoi) | Duplicates jivoi; no additive anonymous route. |
| 5 | [sindresorhus/awesome-whisper](https://github.com/sindresorhus/awesome-whisper) | 4,800+ (**Unverified**) | — | CC0-1.0 (list) | Official (Whisper), Model variants (whisper.cpp, faster-whisper, WhisperX, whisper-timestamped), Apps, CLI tools, Packages | **Core for meeting intelligence.** Establishes whispered local STT hierarchy: `openai/whisper` (MIT) → `ggml-org/whisper.cpp` (MIT, C++) → `SYSTRAN/faster-whisper` → `m-bain/whisperX` (diarization). |
| 6 | [danielrosehill/Awesome-Whisper-Apps](https://github.com/danielrosehill/Awesome-Whisper-Apps) | 900+ (**Unverified**) | — | NOASSERTION | Developer Tools, Popular Picks (WhisperLive etc) | Companion to sindresorhus; surfaces CLI/webapp shapes. |
| 7 | [ishandutta2007/Awesome-AI-Meeting-Notes](https://github.com/ishandutta2007/Awesome-AI-Meeting-Notes) | ~1,200 (**Unverified**) | — | MIT | SaaS Products (Fathom, Granola, Fireflies, Otter), Self-Hosted Assistants (Meetily, Anarlog, Pensieve, Screenpipe), Local Transcription Tools (Ownscribe, Meetscribe), Frameworks & APIs (Whisper, Ollama, LangGraph, pyannote-audio) | **Primary meeting-notes list.** SaaS bot-in-meeting is the anti-pattern; self-hosted `Zackriya-Solutions/meetily` (Whisper+Ollama) + `screenpipe/screenpipe` (24/7 local capture) are prior art for local pipeline. |
| 8 | [Meeting-Mistro/awesome-meetings](https://github.com/Meeting-Mistro/awesome-meetings) | 200+ (**Unverified**) | — | NOASSERTION | Meeting templates/checklists | Process templates only — not a data source. |
| 9 | [voidfiles/awesome-rss](https://github.com/voidfiles/awesome-rss) | 66 | archived/low activity | Other | Syndication Formats, Libraries (feedparser), Hosted Readers | Library baseline; confirms `rss-parser`/`feedparser` layer already covered. |
| 10 | [AboutRSS/ALL-about-RSS](https://github.com/AboutRSS/ALL-about-RSS) | 5,890 | Active (link-check workflows) | CC BY 4.0 | Readers, Self-Hosted, Terminal/programmable, RSS parsing, Feed generation (universal + per-platform: Twitter/HN/YouTube/Reddit), Feed Search, OPML, Feed item filtering, Combine multiple feeds | **Highest signal for RSS shapes.** Exhaustive taxonomy for build-without-X: RSS parsing, RSSHub/RSS-Bridge/Full-Text RSS, feed generation from HTML/search, Reddit RSS fix, filtering/combining, LLM-enhanced feeds. |
| 11 | [plenaryapp/awesome-rss-feeds](https://github.com/plenaryapp/awesome-rss-feeds) | 2,747 | 2026-06-18T08:14:43Z | CC0-1.0 | Recommended Feeds (500+ OPML), Country News Sources (250+ OPML) | Seed corpus for generic RSS stack — OPMLs usable as Source Target seeds without custom discovery. |
| 12 | [tuan3w/awesome-tech-rss](https://github.com/tuan3w/awesome-tech-rss) | 773 | 2026-03-18T14:36:11Z | CC0-1.0 | Startup, Tech News, Products & Ideas, Engineering blogs, ML | 200+ tech RSS feeds faceted by category — complements plenaryapp OPMLs. |
| 13 | [zudochkin/awesome-newsletters](https://github.com/zudochkin/awesome-newsletters) | 4,455 | Active (gh-pages) | **Unverified** | Curated newsletters by topic | List of newsletters to *subscribe to*, not tooling — negative finding; confirms newsletter-to-RSS must be via native Substack RSS, not list consumption. |
| 14 | [marcelkooi/awesome-newsletter-tools](https://github.com/marcelkooi/awesome-newsletter-tools) | 305 | 4 open issues | CC0-1.0 | Newsletter tools (hosted + self-hosted: listmonk, Keila) | Relevant only if app *publishes* its own newsletter — not curation. |
| 15 | [brandonhimpfen/awesome-content-marketing](https://github.com/brandonhimpfen/awesome-content-marketing) — proxy for `awesome-content-creation` | 29 | 7 commits | **Unverified** | Content Creation Tools, Distribution | SaaS-heavy (Canva, Jasper) — no self-hostable curation pipeline. |
| 16 | [brandonhimpfen/awesome-social-media](https://github.com/brandonhimpfen/awesome-social-media) + [DocNow/awesome-social-media-archiving](https://github.com/DocNow/awesome-social-media-archiving) | 10 / **Unverified** | — | **Unverified** | Tips/resources; Archiving tools by platform | No technical adapters; archiving mindset useful for provenance receipts. |
| 17 | [e2b-dev/awesome-ai-agents](https://github.com/e2b-dev/awesome-ai-agents) | 29,745 | 2026-08-21T18:52:45Z | NOASSERTION | Open-source projects → Agents (SOP-controlled multi-agent), Agent4Rec | Pattern: parallel research agents over many public sources — prior art for Module shape orchestration |
| 18 | [Shubhamsaboo/awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps) | 135,162 | 2026-08-22T04:01:54Z | Apache-2.0 | `advanced_ai_agents` → AI Deep Research Agent (Firecrawl + Agents SDK), DevPulse AI (scores technical signals into daily digest), Product Launch Intelligence Agent; `RAG` → hybrid search RAG | Demonstrates *aggregation + scoring* without LinkedIn — direct template for Content Research briefing. |
| 19 | [igorbarinov/awesome-data-engineering](https://github.com/igorbarinov/awesome-data-engineering) | 9,004 | 2026-07-18T15:19:21Z | CC0-1.0 | Data Ingestion, Stream Processing, Datasets (Common Crawl, Pushshift), Monitoring | Pipeline shapes for polling/ingest without auth. |
| 20 | [awesomedata/awesome-public-datasets](https://github.com/awesomedata/awesome-public-datasets) | 78,709 | 2026-08-29T18:38:59Z | MIT | Datasets → Social, News, Reddit (Pushshift), HN, Financial | Historical baselines for resonance normalization. |
| 21 | [brettkromkamp/awesome-knowledge-management](https://github.com/brettkromkamp/awesome-knowledge-management) | 869 | 2026-08-27T06:33:02Z | CC0-1.0 | Platforms (Obsidian, Logseq), Semantic Web, Libraries (NetworkX) | Graph/ledger shapes for engagement ledger replacement. |
| 22 | [googleworkspace/awesome-workspace](https://github.com/googleworkspace/awesome-workspace) | 600+ (**Unverified** via `googleworkspace/awesome-workspace`) | — | Apache-2.0 (**Unverified**) | Apps Script samples, Workspace add-ons | Output Adapter prior art — but real adapter docs are at `developers.google.com`. |
| 23 | [oshliaer/google-apps-script-awesome-list](https://github.com/oshliaer/google-apps-script-awesome-list) + [grant/awesome-apps-script](https://github.com/grant/awesome-apps-script) | 800+ / 200+ (**Unverified**) | — | NOASSERTION / CC0-1.0 | Apps Script utilities, auto-triggers, Sheets/Gmail patterns | Sheets upsert / Gmail draft patterns — but app's `apps/server/src/google/*.ts` already ships these. |
| 24 | [spencerpauly/awesome-notion](https://github.com/spencerpauly/awesome-notion) | 1,200+ (**Unverified**) | — | NOASSERTION | Tools, APIs (notion-sdk-js, notion-sdk-py), Notion2Sheets | Notion write path prior art — but official docs are at `developers.notion.com`. |
| 25 | [lorey/awesome-hubspot](https://github.com/lorey/awesome-hubspot) | 100+ (**Unverified**) | — | **Unverified** | Thin list of HubSpot CMS projects | Confirms HubSpot awesome space is weak; primary is `developers.hubspot.com`. |
| 26 | [DIYgod/RSSHub](https://github.com/DIYgod/RSSHub) *(via awesome-web-scraping + ALL-about-RSS; referenced in content-scout-source-adapters.md)* | 45,938 | 2026-08-29T19:51:30Z | AGPL-3.0 | 5,000+ routes — feed synthesis factory | Single most valuable adjacent adapter factory — see verdict below (conditional). |

Not-found (verified no canonical list): `awesome-brand-monitoring` and `awesome-competitor-analysis` return no canonical awesome list (top hits are Zapier/Semrush blog posts, not GitHub lists). Satisfied via OSINT `Company Research` sections + `firecrawl/firegeo` — cited.

---

## 3. Harvest — RSS / Newsletter / Content curation (for #21 without LinkedIn)

This is the richest harvest. Eleven candidates below are ordered by how directly they prove the job: *read a set of public sources, score what is resonating, explain why, publish a briefing/ledger* — without a LinkedIn read.

| # | Candidate (repo) | Stars | License | What it returns (replaces LinkedIn reactions) | Auth / Cost | Credential fit | Notes |
|---|---|---|---|---|---|---|---|
| C1 | [umputun/newscope](https://github.com/umputun/newscope) — <https://github.com/umputun/newscope> | 50 | MIT (**Unverified** — LICENSE in repo) | AI-powered RSS curator: polls RSS/OPML → classifies + scores articles on user natural-language interest profile; learns from feedback (read/finish → score) | Single provider key (OpenAI/Anthropic/local Ollama) + public RSS fetch | **PASS** — clean anonymous polling, single Shell key | Pattern: interest-profile → LLM relevance 0–10 → filter/surface. Direct template for resonance scoring. |
| C2 | [leozqin/precis](https://github.com/leozqin/precis) | 93 | **Unverified** | Self-hosted AI RSS reader: theming, notifications, LLM tagging/summarization | Single LLM key; self-hosted Python | **PASS** | In-process enrichment: RSS → LLM tags → notification dispatch. |
| C3 | [CartesianXR7/Meridian](https://github.com/CartesianXR7/Meridian) | 4 | MIT | Intelligent RSS aggregator: DBSCAN clustering, impact/authority scoring via NLP | Optional LLM key; Python, no API key for fetch | **PASS** — anonymous-only scoring | Authority tier + clustering — non-LLM signal to complement LLM relevance; useful for Content Scout dedup. |
| C4 | [jbrunclik/sift](https://github.com/jbrunclik/sift) | 1 | **Unverified** | Personal news aggregator: RSS → Gemini relevance scoring, FastAPI backend | Single Gemini key in `.env.example` | **PASS** | Minimal FastAPI+Gemini scoring ref. |
| C5 | [kronprinzmagma/ki-news-aggregator](https://github.com/kronprinzmagma/ki-news-aggregator) | 2 | **Unverified** | Daily AI news pipeline: ingests 14 sources (RSS), scores with Claude Haiku, publishes curated briefing as GitHub Issue; GitHub Actions cron + SQLite | Single `ANTHROPIC_API_KEY` in Shell pattern | **PASS** — canonical briefing shape | 14 sources → LLM score → Issue brief is *exact* Content Research brief artifact. |
| C6 | [eschnou/morningdeck](https://github.com/eschnou/morningdeck) | 12 | **Unverified** | Self-hostable AI news intelligence: aggregates RSS + newsletters + websites + **Reddit**, scores → daily briefings | Single LLM key + Reddit public JSON/RSS (anonymous) + newsletter public HTML | **PASS** — proves Reddit-in-RSS-stack | Bundles RSS+website+Reddit+newsletter under one scoring UI — validates Content Scout's Experimental Reddit route. |
| C7 | [claude-world/trend-pulse](https://github.com/claude-world/trend-pulse) | 57 | **Unverified** (pyproject) | Free trending-topics aggregator: **20 sources, zero auth** — CLI + lib + MCP server; sources include HN, GitHub Trending, Reddit, HN Algolia, RSS | **Zero API keys** for collection; optional LLM only for summarization | **PASS** — best anonymous posture | 20-source free fetch proves #21 without LinkedIn can aggregate many public signals, not one brittle scraper. |
| C8 | [DanieleGiovanardi2408/idea-radar](https://github.com/DanieleGiovanardi2408/idea-radar) | 0 | MIT | Emerging-tech radar: collects **8 free sources** (HN, GitHub, HF, SE, npm, arXiv, PH, 20 tech RSS), semantic dedup via local `nomic-embed-text`, opportunity ranking by *velocity* (growth/day) not cumulative, local Ollama insights, live radar UI | **Zero cloud keys** by default (Ollama local); polite fetching (honest UA, `Retry-After`) | **PASS** — offline + polite | Opportunity = velocity × room × fit; embedding dedup + momentum scoring for content opportunity detection. |
| C9 | [YanCheng-go/my-focal-ai](https://github.com/YanCheng-go/my-focal-ai) | 13 | **Unverified** | Personal news intelligence: aggregate curated AI sources → LLM score → dashboard (FastAPI) | Single LLM key | **PASS** | Dashboard shape alternative to Issue brief. |
| C10 | [DIYgod/RSSHub](https://github.com/DIYgod/RSSHub) — <https://github.com/DIYgod/RSSHub> | 45,938 | AGPL-3.0 | Synthesizes **thousands of RSS feeds** for sites lacking native feeds; self-hostable Node + Radar extension | Self-hosted = no vendor key; public-site HTML fetch (respect `robots.txt` per route) | **CONDITIONAL** — many routes anonymous, some require cookies/auth → **must allowlist anonymous-only routes** | Exactly `content-scout-source-adapters.md` recommendation: "useful optional self-hosted compatibility layer, not the default dependency" — do not vendor into app (AGPL). |
| C11 | [taielab/awesome-ai-news](https://github.com/taielab/awesome-ai-news) (index) → [LearnPrompt/ai-news-radar](https://github.com/LearnPrompt/ai-news-radar), [sansan0/TrendRadar](https://github.com/sansan0/TrendRadar), [Colin-XKL/FeedCraft](https://github.com/Colin-XKL/FeedCraft), [TD21forever/RSS-Master](https://github.com/TD21forever/RSS-Master) | 50 / **Unverified** | **Unverified** | News Aggregation + RSS Management (7 tools), feed search, podcast generation; FeedCraft (Go, HTML→RSS+AI), RSS-Master (filtering + AI summarization) | Varies | **PASS** (verify license before vendoring) | Surfaces additional proven candidates not in code search. |

### GitHub code-search hits that corroborate this harvest

`gh search repos` / `xd://mcp__gh_grep_searchgithub` for the six requested queries (stars at check time):

| Query | Repo hit | Stars | What it demonstrates |
|---|---|---|---|
| `rss aggregator scoring` | `CartesianXR7/Meridian` | 4 | RSS fetch + NLP clustering + authority scoring |
| `rss aggregator scoring` | `umputun/newscope` | 50 | LLM relevance on interest profile, feedback-trained filter |
| `content curation llm` | `eschnou/morningdeck` | 12 | Multi-source curation → LLM organize → daily brief |
| `content curation llm` | `TD21forever/RSS-Master` | **Unverified** | Custom filtering + AI summarization (TypeScript) |
| `trending topics detector` | `claude-world/trend-pulse` | 57 | 20 free sources, zero auth, MCP |
| `trending topics detector` | `DanieleGiovanardi2408/idea-radar` | 0 | Momentum trending (velocity/day) + semantic dedup |
| `subreddit monitor` | `nktfh100/reddit-posts-notifier` | **Unverified** | Multi-subreddit watch via RSS/JSON |
| `hacker news curation` | `rcarmo/newsfeed-corpus` | **Unverified** | Dockerized RSS fetcher + ML trending corpus |
| `newsletter aggregator` | `leozqin/precis` | 93 | AI tagging/summarization + notification delivery |
| `newsletter aggregator` | `davpu/news-digest` | **Unverified** | Personal RSS digest with optional LLM, exposed as **MCP server** + FastAPI |

### Build-without-X shapes

**Shape A — Generic RSS + website + YouTube + Reddit stack (baseline, ship as #21 V1).** Sources: 14–20 RSS feeds (from <https://github.com/plenaryapp/awesome-rss-feeds> OPMLs or custom), Substack feeds via `rss-parser` (<https://github.com/rbren/rss-parser>) — every Substack exposes a native RSS/Atom feed — website targets via Crawlee (<https://github.com/apify/crawlee>, Apache-2.0) + Readability (<https://github.com/mozilla/readability>), YouTube via existing Data API, Reddit via public RSS/JSON (Experimental, slow poll, explicit UA). Pipeline: `fetch → normalize to SourceItem envelope → dedup (URL + embedding) → LLM relevance/opportunity scoring (single Shell key or local Ollama) → cluster (DBSCAN as in Meridian / nomic-embed-text as in idea-radar) → briefing`. Proof: morningdeck (RSS+website+Reddit) + trend-pulse 20 sources + idea-radar 8 sources.

**Shape B — RSSHub as optional feed-synthesis compatibility layer.** Self-host <https://github.com/DIYgod/RSSHub> (AGPL-3.0) behind Content Scout; enable only vetted anonymous routes; degrade gracefully. Add <https://github.com/DIYgod/RSSHub-Radar> for feed discovery during allowlisting. Not default — mirrors `content-scout-source-adapters.md` "optional self-hosted compatibility layer". Flag: some routes need cookies/auth → mark non-anonymous and skip.

**Shape C — OPML + feed finding + Full-Text enhancement.** Discover via HTML `<link rel="alternate">` before custom scrape (<https://github.com/AboutRSS/ALL-about-RSS#rss-feed-findingdetection>), import OPML, full-text extraction via <https://github.com/AboutRSS/ALL-about-RSS#free-servers>, filtering/combining (<https://github.com/AboutRSS/ALL-about-RSS#feed-item-filtering>). Substack trick: single-post media enrichment via <https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/substack.py> only if audio/video.

**Shape D — LLM scoring + opportunity brief (the #21 artifact).** Patterns: interest-profile relevance 0–10 (newscope/sift), authority+clustering (Meridian DBSCAN), momentum = velocity × saturation gate × fit (idea-radar), keyword prefilter + LLM rerank (RSS-Master). Brief shapes: daily digest as GitHub Issue (ki-news-aggregator via Actions cron → SQLite dedup → Issue), MCP server + FastAPI (davpu/news-digest). Single LLM key in Shell config or local Ollama (zero vendor cost).

**Shape E — Subreddit + HN without authenticated APIs.** Public RSS per subreddit/user/search + public JSON/HTML, slow polls, caching, explicit UA, fixture parsers — exactly the `content-scout-source-adapters.md` Reddit guidance. HN: Algolia `<https://hn.algolia.com/api>` + official Firebase API (no auth) — idea-radar and newsfeed-corpus demonstrate velocity (points/day) as trending signal. See also <https://github.com/finaldie/auto-news> for YouTube + Reddit extension of same pattern.

All five respect `https://www.linkedin.com/robots.txt` (no LinkedIn read) and use **zero or one** Shell-stored key — see §7 posture verdict.

---

## 4. Harvest — LinkedIn post/profile collection via awesome lists & code search

This is the "prove it is not there" harvest. The question is not "which scraper looks good" but "does GitHub ship an anonymous linkedIn post collector that respects robots.txt and does not require a LinkedIn login".

### 4.1 What the awesome lists actually contain

All LinkedIn-tagged repos surfaced by `jivoi/awesome-osint` and `lorien/awesome-web-scraping` fall into three buckets, each posture-violating:

| Repo | License | Auth shape | What disqualifies it |
|---|---|---|---|
| [joeyism/linkedin_scraper](https://github.com/joeyism/linkedin_scraper) — evaluated in `content-scout-source-adapters.md` LinkedIn table | GPL-3.0 | Playwright **requires login/session state** | Breaks Content Scout posture + needs per-user LinkedIn login (anti-ADR-0001). |
| [pratik-dani/LinkedIn-Scraper](https://github.com/pratik-dani/LinkedIn-Scraper) — same table | AGPL-3.0 | Requires a valid LinkedIn account despite HTTP | Same. |
| [linvo-io/linvo-scraper](https://github.com/linvo-io/linvo-scraper) | MIT | Authenticated automation, 2022-valid | Same + stale. |
| [eilonmore/linkedin-private-api](https://github.com/eilonmore/linkedin-private-api) — listed in awesome-linkedin | MIT (**Unverified**) | Wraps LinkedIn's **private Voyager API**, needs `li_at` / `JSESSIONID` / `jsession` + `csrf` | Emulates authenticated client; exactly the member-authenticated path that violates UA Help Centre risk warning — <https://www.linkedin.com/help/linkedin/answer/a1341387> ("risk having their accounts restricted"). |
| [tomquirk/linkedin-api](https://github.com/tomquirk/linkedin-api) — listed in awesome-linkedin | MIT | Unofficial Python wrapper — same session-cookie requirement | Same. |
| [austinoboyle/scrape-linkedin-selenium](https://github.com/austinoboyle/scrape-linkedin-selenium) | MIT (**Unverified**) | Selenium **login flow** | Same. |
| [m8r0wn/crosslinked](https://github.com/m8r0wn/crosslinked) — OSINT employee enumeration | GPL-3.0 (**Unverified** via `gh api`) | Needs LinkedIn session or SERP scraping | Scrapes employee lists via Google/Bing dorks, not post content; still relies on LinkedIn UX. |
| `christophe-garon/Linkedin-Post-Scraper` — flagged in prior research | No recognized license | GitHub availability alone | No reuse rights; stale. |

**yt-dlp's LinkedIn extractor** is the only permissively licensed exception: <https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md> marks it as limited to **supported video/event/learning URLs** — it does not enumerate arbitrary profile or company posts. Public search HTML may expose a small subset but is incomplete, login-walled, and shaped by `Disallow: /`.

Conclusion: no awesome-listed repo provides anonymous LinkedIn post enumeration that survives the `robots.txt` + UA + posture gate. The `LinkedInComingLaterAdapter` staying "Coming later behind an evidence gate" is therefore honest — it correctly refuses to ship.

### 4.2 GitHub code search corroboration (LinkedIn queries)

| Query | Top repo hits (`gh api search/repositories`) | Stars | Verdict on shape |
|---|---|---|---|
| `linkedin scraping` | `joeyism/linkedin_scraper` (2k+ stars, **Unverified**), `austinoboyle/scrape-linkedin-selenium` (~900), `crosslinked` | 2k+ | All require login/session. No anonymous post route. |
| `reverseContact OR proxycurl OR brightdata linkedin` | `linkdapi/linkdapi` (Proxycurl migration shim) | **Unverified** | Confirms Proxycurl → LinkDAPI path; not LinkedIn-native. |
| `linkedin api posts` | `tomquirk/linkedin-api`, `eilonmore/linkedin-private-api` | — | Private/authenticated APIs, not anonymous. |
| `r_member_social` | No repo renders authentic `r_member_social` post read — only docs mirroring <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api> | — | Confirms linkedin-reading-options.md §1.2: permission is **closed** — <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview> ("not accepting access requests"). |
| `linkedin stealth playwright` | `AtuboDad/playwright_stealth` (983★ — <https://github.com/AtuboDad/playwright_stealth>), `Mattwmaster58/playwright_stealth` (266★), `tinyfish-io/tf-playwright-stealth` (221★) | 983 | **Anti-pattern.** Patches `navigator.webdriver`, `chrome` object to evade bot detection — violates UA §8.2 "bypass or circumvent any access controls" + robots.txt. See §6. |

No code hit surfaced a maintained anonymous LinkedIn post collector that respects `robots.txt`. The few that claim "No Cookies" (Apify Actors — §4.3) disclaim legality at the Actor level, not the platform level.

### 4.3 The vendor replacement layer — Apify Actors as code distribution

Apify's LinkedIn store (<https://apify.com/store?search=linkedin>) is not a single vendor but a **marketplace of third-party Actors**, each with per-Author ToS. Sampled primary pages (all require `apify` token + per-Actor billing):

- `apimaestro/linkedin-profile-posts` — <https://apify.com/apimaestro/linkedin-profile-posts> — advertises "Profile Posts Scraper for LinkedIn", pay-per-event, **Unverified** "No Cookies" claim is the Actor author's, not Apify's.
- `harvestapi/linkedin-profile-posts` — <https://apify.com/harvestapi/linkedin-profile-posts-scraper-no-cookies> — "(No Cookies)" in title, same per-Actor legality.
- `supreme_coder/linkedin-post` — <https://apify.com/supreme_coder/linkedin-post-scraper> — "✅ No cookies" with flat jobs pricing ~$0.40–$0.45 per 1,000 jobs (**Unverified** — only two jobs Actors published flat rates in prior pass).

ToS posture: store page carries **no legality statement**; each Actor page disclaims separately. User Agreement §8.2 still reaches data "through third parties (such as … data aggregators or brokers)" regardless of Actor's "No Cookies" marketing. All require Apify platform key + per-run spend — would fit Shell's single-key shape technically, but inherit the durability risk proven by reverseContact's retirement and Proxycurl's sunset.

---

## 5. Harvest — transcription / meeting notes / speech-to-text (for #114 Executive Assistant, #22 Meeting Follow-Up, #18 AI Wins Capture)

### 5.1 Awesome lists

| Slice (query) | Repo | What it proves | License | Verdict vs local-first (ADR-0001) |
|---|---|---|---|---|
| `awesome-whisper` | [sindresorhus/awesome-whisper](https://github.com/sindresorhus/awesome-whisper) | Official `openai/whisper` (MIT) + variants: `whisper.cpp` (MIT, C/C++), `faster-whisper` (CTranslate2), `WhisperX` (diarization), `whisper-timestamped` | MIT / MIT | **PASS — local-first hierarchy.** `whisper.cpp` avoids Python runtime, runs on CPU or local accelerator. `openai/whisper` → `ggml-org/whisper.cpp` → `SYSTRAN/faster-whisper` → `m-bain/whisperX` is the ordering already adopted in `content-scout-source-adapters.md` Transcript fallback. |
| `awesome-whisper-apps` | [danielrosehill/Awesome-Whisper-Apps](https://github.com/danielrosehill/Awesome-Whisper-Apps) | CLI tools (`yt-whisper`, `whisper-standalone-win`, `whisper-diarization`), web apps, playgrounds | MIT (apps vary) | **PASS** as enrichment routes. |
| `awesome-ai-meeting-notes` | [ishandutta2007/Awesome-AI-Meeting-Notes](https://github.com/ishandutta2007/Awesome-AI-Meeting-Notes) | SaaS table (Fathom/Fireflies/Otter — cloud bot-in-meeting) vs **Self-Hosted Assistants** (`meetily`, `anarlog`, `pensieve`, `screenpipe`) vs Frameworks (Whisper, Ollama, LangGraph, pyannote-audio) | MIT (list) | **Split verdict.** SaaS bots = anti-pattern for local-first/private transcripts. Self-hosted `Zackriya-Solutions/meetily` (Whisper + Ollama, macOS/Win/Linux) and `screenpipe/screenpipe` (24/7 local capture, Whisper indexed) are prior art that matches the app's Transcripts Drive Intake + local 12-stage extraction (ADR for Idea Engine). |
| `awesome-meetings` | [Meeting-Mistro/awesome-meetings](https://github.com/Meeting-Mistro/awesome-meetings) | Meeting templates/checklists | — | No data surface — not a transcript source. |
| General speech | [zzw922cn/awesome-speech-recognition-speech-synthesis-papers](https://github.com/zzw922cn/awesome-speech-recognition-speech-synthesis-papers) | Papers list | — | Research reference only. |

### 5.2 Candidate pipeline for transcript intelligence

| Stage | Candidate (repo) | What it returns | License / Cost | Auth | Verdict |
|---|---|---|---|---|---|
| STT (local) | [openai/whisper](https://github.com/openai/whisper) | Speech-to-text | MIT | None (local weights) | **PASS** — reference local model. |
| STT (local, no Python) | [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Same, via C++ | MIT | None | **PASS** — recommended default; avoids Python runtime, CPU or GPU. |
| STT (faster) | [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) | Optimized Whisper via CTranslate2 | MIT | None | **PASS** — Python alternative. |
| Diarization | [m-bain/whisperX](https://github.com/m-bain/whisperX) | Word-level timestamps + speaker ID | BSD-3 / MIT (**Unverified**) | None | **PASS** — adds meeting efficacy assessment evidence. |
| Diarization | [pyannote/pyannote-audio](https://github.com/pyannote/pyannote-audio) + [collabora/WhisperLive](https://github.com/collabora/WhisperLive) | Speaker diarization + streaming | MIT | None / local | **PASS** — for wait-and-expire + regenerate use case. |
| Self-hosted assistant | [Zackriya-Solutions/meetily](https://github.com/Zackriya-Solutions/meetily) | Whisper+Ollama meeting assistant, local-only | MIT (**Unverified**) | Local Ollama | **PASS** — closest prior art to #114 spec (`convert → debrief → [wait 30d] → regenerate:<field> → deliver`). |
| 24/7 capture | [screenpipe/screenpipe](https://github.com/screenpipe/screenpipe) | Always-on screen+mic → Whisper → indexed AI search | MIT | Local | **PASS** as enrichment; not Intake prerequisite ( expensive, and transcripts are the Intake). |
| Cloud SaaS | [Fathom](https://fathom.video/), [Fireflies.ai](https://fireflies.ai/), [Otter.ai](https://otter.ai/) — per Awesome-AI-Meeting-Notes table | Bot joins meeting, cloud transcript | $8–$18/mo | OAuth to meeting platform | **FAIL** — violates ADR-0030 classified-failure rule (transcripts are private, no verbatim in failure facts) and local-first; plus requires third-party bot in meeting. |

### 5.3 GitHub code hits (meeting queries)

| Query | Repo hit | Stars | Shape |
|---|---|---|---|
| `meeting debrief` | `meetily`, `anarlog` (`fastrepl/anarlog` — open-source Granola alternative) | **Unverified** | Debrief extraction from transcript is stable shape. |
| `action item extraction` | `m-bain/whisperX` downstream apps + LangGraph multi-agent workflows | — | LLM extraction with Result Shape binding pattern (ADR-0029). |
| `transcript summarizer` | `scriberr` ([rishikanthc/scriberr](https://github.com/rishikanthc/scriberr)), `vibe` ([thewh1teagle/vibe](https://github.com/thewh1teagle/vibe)) | **Unverified** | Whisper transcript summarizer GUIs — prior art for Brief generation. |
| `whisper.cpp transcription` | `ggml-org/whisper.cpp` (11k+ stars, **Unverified** this pass — known 9k+) | — | Local transcription fallback when no published transcript exists. |
| `diarization` | `pyannote/pyannote-audio` | 9k+ (**Unverified**) | Speaker attribution for coaching/effectiveness evidence. |

**Posture note.** `app-functional-audit.md` already verified Shell's single LLM seam under ADR-0029/0030 (model-boundary failures as classified facts, not sentences; no payload in error logs). That aligns perfectly with `openai/whisper` local + single Shell model key for debrief synthesis — no additional credential needed. Creative adjacent shape B in §6 reuses this seam.

---

## 6. Harvest — Google Workspace / Sheets / Gmail / Tasks / YouTube / Notion / HubSpot (Output Adapters & ledger shapes for #23)

### 6.1 Awesome lists

| Slice | Repo | Yield | Verdict |
|---|---|---|---|
| `awesome-google-workspace` | [googleworkspace/awesome-workspace](https://github.com/googleworkspace/awesome-workspace) | Apps Script samples, add-ons | Index only — real docs at `developers.google.com`. |
| `google-apps-script-awesome-list` | [oshliaer/google-apps-script-awesome-list](https://github.com/oshliaer/google-apps-script-awesome-list) (800+ stars) + [grant/awesome-apps-script](https://github.com/grant/awesome-apps-script) | Auto-triggers, Sheets/Gmail patterns (e.g., `youtube-tracker` Code.gs) | Same — but confirms Sheets upsert / Gmail draft / Drive poll patterns are well-trodden. |
| `awesome-notion` | [spencerpauly/awesome-notion](https://github.com/spencerpauly/awesome-notion) (1,200+ stars) → APIs: `notion-sdk-js` (<https://github.com/makenotion/notion-sdk-js>), `notion-sdk-py`, `notion-py` | Reference SDKs for Notion pages/databases | Prior art for Notion Output Adapter (app already ships `apps/server/src/modules/content-scout/notion.ts`). |
| `awesome-hubspot` | [lorey/awesome-hubspot](https://github.com/lorey/awesome-hubspot) + [Triippz/awesome-hubspot-projects](https://github.com/Triippz/awesome-hubspot-projects) | Thin CMS-template list | Confirms HubSpot awesome space is weak — primary is `developers.hubspot.com`. |
| `awesome-spreadsheet` | [d2s/awesome-spreadsheet](https://github.com/d2s/awesome-spreadsheet) | Spreadsheet tools | No Shell adapter — generic. |
| `awesome-n8n-templates` | [enescingoz/awesome-n8n-templates](https://github.com/enescingoz/awesome-n8n-templates) | n8n HubSpot/Sheets workflows | Workflow prior art for ledger vs N8N — not a source adapter. |

**Lesson:** awesome lists for Google/Notion/HubSpot index *templates*, not *adapter contracts*. The real evidence is the vendors' own API docs + the app's already-shipped `apps/server/src/google/*.ts`.

### 6.2 What the app already ships (ground truth)

- `apps/server/src/google/connection.ts` — Shell Google connection (OAuth client per ADR-0007/0011, expiry is weekly event).
- `apps/server/src/google/sheets.ts` — Sheets read/write path.
- `apps/server/src/modules/youtube/spreadsheet.ts` — YouTube view-count ledger (trend) — proves Sheets upsert already works.
- `apps/server/src/modules/content-scout/notion.ts` — Notion page creation for Content Drafts.
- `apps/server/src/google/gmail.ts` + `apps/server/src/google/tasks.ts` + `apps/server/src/google/outputs.ts` — Gmail draft + Tasks + Output Adapter seam.
- `apps/server/src/intake/drive.ts` — `drive.fileAddedToFolder` intake (used by Idea Engine + Executive Assistant).

These already satisfy the Output Adapter pattern for any Module — no new awesome-catalogued tool needed.

### 6.3 Primary API docs → quotas / limits (what actually constrains a ledger)

All citations are first-party docs, not lists:

| Surface | Primary doc(s) | Limit | Fit with Shell single connection |
|---|---|---|---|
| Sheets | <https://developers.google.com/workspace/sheets/api/limits> | **100 requests per 100 seconds per user** (all methods); batch writes recommended | PASS — `batchUpdate`/`spreadsheets.values.batchUpdate` collapses many rows into one quota hit. |
| Drive (file poll + copy) | <https://developers.google.com/workspace/drive/api/guides/limits> | **~20,000 requests per 100 seconds** (project) | PASS — `fileAddedToFolder` poll with `q` filter + page tokens is cheap. |
| Gmail (draft create) | <https://developers.google.com/workspace/gmail/api/reference/quota> | **250 quota units / user / second** rolling avg; `drafts.create` = 5 units | PASS — one draft per Run. |
| Tasks | Google Tasks API (<https://developers.google.com/workspace/tasks>) — quota via Cloud Console (**Unverified** — not in separate published limits page; enforced per-project) | Per-project QPS, typically 1–10 QPS default | PASS — single Module. |
| YouTube Data API | <https://developers.google.com/youtube/v3/determine_quota_cost> | **10,000 units/day** default; `search.list` = 100 units, `videos.list` = 1 unit | PASS — walk uploads playlist, not search. |
| Notion | <https://developers.notion.com/reference/request-limits> | **~3 requests/second** avg; `429` with `Retry-After` | PASS — Notion writes are per-Content Draft, not bursty. |
| HubSpot | <https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines> | **100 req/10s** + burst 20; Search API is tighter | PASS — single token in Shell config (notion/hubspot pattern in `packages/shared/src/schemas.ts`). |

### 6.4 GitHub code-search hits (ledger / Output Adapter shapes)

`xd://mcp__gh_grep_searchgithub` results (ranked hits, language-agnostic, at 2026-08-30):

| Query | Top hits (owner/repo: path fragment) | What it demonstrates |
|---|---|---|
| `sheets upsert` | `googleworkspace/apps-script-samples` — `sheets/sheets-api` samples | Sheets append/upsert via `spreadsheets.values.append` + dedup via read-then-write transaction |
| `notion database upsert` | `makenotion/notion-sdk-js` — tests + `notion-cli` — page create + database query with `filter: {property:"activityUrl", rich_text:{equals:"..."}}` | Notion database upsert = query by `activityUrl` key → update else create — same pattern #23 wants for Sheets |
| `gmail draft create` | `googleworkspace/apps-script-samples` — Gmail samples + `googleapis/google-api-nodejs-client` — `gmail.users.drafts.create({userId:"me", resource:{message:{raw:...}}})` | Single-call draft creation behind Google connection — no new cred |
| `google tasks api` | `googleapis/google-api-nodejs-client` — `tasks.tasks.insert` samples | One task = one action item; list per Run — matches Executive Assistant `→ Tasks` step |
| `drive fileAddedToFolder poll` | `apps/server/src/intake/drive.ts` in **this repo** + `googleworkspace/apps-script-samples` — Drive watch + listChanges | Poll with `drive.files.list(q:"'FOLDER_ID' in parents")` + `nextPageToken` — already ships |
| `youtube view count trends` | `googleworkspace/apps-script-samples/solutions/automations/youtube-tracker/Code.gs` | Channel daily enumerate → viewCount → Sheet row — exactly this app's YouTube Trends Module |

All six patterns map to **one Output Adapter each** that already fits Shell: single Google connection + single Notion token (`notion.token` shape) + single HubSpot token (`hubspot` shape) — no per-Module OAuth. The "does the Shell learn to upsert a Sheet row?" question in #23 is answered: **it already does** (YouTube Trends ledger). No new adapter primitive needed — only a new ledger sheet keyed differently.

### 6.5 Creative ledger shapes for #23 without LinkedIn

Two shapes, both lawful, both fit Shell:

**Ledger A — Resonance ledger (replaces LinkedIn Engagement Tracker 1:1).** Sheet: `Resonance Ledger` keyed on `(person, canonicalUrl)` with columns `publishedAt, platform, title, url, views/likes/reposts/points/comments, resonanceScore, evidenceUrl`. Feeds as in §3 Shape A (Bluesky favs/reblogs, Mastodon, HN points, YouTube views, Reddit score, Google News frequency). One Gmail draft per run to owner-only (ADR-0034), one Home card. No `w_member_social`. Credential: YouTube key in Shell Google connection or env `YOUTUBE_API_KEY`; PH token only if enabled — otherwise entirely keyless.

**Ledger B — Topic spread ledger (pivot from person → topic).** Sheet: `Topic Spread Ledger` keyed on `(person, topicClusterId)` with `lastSeen, spreadScore, evidenceJson, topPostUrl`. Sources as in §3 Shape B/D (RSS + Reddit + HN + PH + podcast transcripts). Useful when the tracked people publish across heterogeneous surfaces (blog + YT + podcast) rather than one feed — closer to Content Scout's Source Target ontology.

Both survive the gear shift: if Bluesky is empty for a week, HN + News + YT still score. That graceful degradation is precisely what the LinkedIn stack lacked (single point of failure on `scraping.reverseContact.post.fromProfileUrl`).

---

## 7. Vendor durability & terms audit — primary-source verdict

Each row cites the **vendor's own** ToS / docs / pricing, and LinkedIn's **own** robots/UA/API Terms. "Returns" means the vendor's advertised LinkedIn surface (not this app's need for engagement counts).

| Vendor | What it returns (advertised LinkedIn surface) | Access model | Terms posture (primary URL, one line) | Credential shape vs Shell | Cost (published) | Durability | Verdict vs appetite for #21 / #23 |
|---|---|---|---|---|---|---|---|
| **reverseContact / Visum** — <https://reversecontact.com> | Person & company enrichment, search, resolve — **posts/comments/reactions retired** | Commercial API key `rc_*` Bearer — <https://app.reversecontact.com/docs/public/getting-started> | <https://www.reversecontact.com/legal/terms-of-services>: operator is **Visum, French SAS, French law**; **"Visum makes no representation, warranty, or guarantee that Customer's use … complies with the terms of service … imposed by any third-party platform"**; customer indemnifies Visum. | Fits single-key pattern technically; legally the risk is contractually yours. | PAYG from $100, datasets $1k–$8k/mo — <https://reversecontact.com/pricing> | **DEAD CAPABILITY + FRAGILE.** Activities `POST /v2/fetch/persons/posts/live` etc retired **2026-07-01, no replacement** — <https://app.reversecontact.com/docs/public/guides/july-2026-platform-update> + <https://app.reversecontact.com/docs/public/changelog> v2.7.0. Explains every Relay `FAILED` after 2026-07-14. | **DO NOT REBUILD.** Moot for posts. Viable only for B2B identity enrichment replacement of guestProfile if needed. |
| **Proxycurl / Nubela → NinjaPear** — <https://nubela.co/proxycurl> | LinkDAPI migration shim; no longer Proxycurl-direct | Sunset | <https://nubela.co/proxycurl>: **"Proxycurl is no longer in service. See NinjaPear, a data platform for customer data instead."** Sunset notice <https://nubela.co/blog/goodbye-proxycurl/> (read 2026-08-30). Migration post <https://linkdapi.com/blog/migrating-from-proxycurl-to-linkdapi> | Would have been single key — now moot | Not published on sunset page | **GONE.** | Moot. Confirms vendor durability risk is not hypothetical. |
| **Bright Data** — <https://brightdata.com/products/datasets/linkedin> | LinkedIn datasets: people profiles 123.5M+, companies 34.4M+, jobs 15.6M+, **posts 11.6M+ with "content, engagement metrics, timestamps"**; plus real-time **LinkedIn Scraper API** — <https://brightdata.com/products/web-scraper/linkedin> | Dataset download (S3/GCS/Azure/Snowflake/SFTP) or Scraper API; Bearer `Authorization` — <https://brightdata.com/products/datasets/linkedin> | Claims **"exclusively from publicly available online sources in compliance with applicable laws … including GDPR, CCPA"** + ISO 27001, SOC 2; Acceptable Use at <https://brightdata.com/acceptable-use-policy>; Trustcenter GDPR page <https://brightdata.com/trustcenter/gdpr>. **BUT** LinkedIn UA §8.2 reaches data **"whether directly or through third parties (such as search tools or data aggregators or brokers)"** — <https://www.linkedin.com/legal/user-agreement> — so vendor's compliance claim does not waive LinkedIn's member terms for this app's consumption. | Single Bearer key — **mechanically best fit** (notion/hubspot shape). | **"$250 for 100K records (approximately $0.0025 per record)"**; subscription discounts — <https://brightdata.com/products/datasets/linkedin> marketplace section | Sued twice: `Meta Platforms, Inc. v. Bright Data Ltd.`, No. 3:23-cv-00077 (N.D. Cal., terminated 2024-02-26) and `X Corp. v. Bright Data Ltd.`, No. 3:23-cv-03698 (N.D. Cal., terminated 2025-07-01) — dockets confirmed on CourtListener (see linkedin-reading-options.md §3.2), **merits not read; nothing about holdings asserted here**. | **Legally worst, mechanically best.** Would unblock #21 as designed but on terms-risk + price + third single-point-of-failure. See §8 strongest case against. |
| **Apify (store)** — <https://apify.com/store?search=linkedin> | Marketplace of third-party Actors: `apimaestro/linkedin-profile-posts`, `harvestapi/linkedin-profile-posts-scraper-no-cookies`, `supreme_coder/linkedin-post-scraper`, jobs scrapers etc. Many advertise **"No Cookies"**. | Pay-per-event Actors on Apify platform; Apify token + per-Actor run billing | Apify store carries **no legality statement**; ToS is **per-Actor per-Author**. Actor pages: `apimaestro` / `harvestapi` / `supreme_coder` (above). "No Cookies" is the **Actor author's claim**, not Apify's. | Single platform key — fits shape | Mostly **"Pay per event"**, rate not shown on listing; two jobs Actors published ~$0.40–$0.45/1k jobs (**Unverified** this pass) | Durability is per-Author; marketplace is durable but individual Actors churn; same class risk as Proxycurl. | **FRAGILE + TERMS-OPAQUE.** Do not build high-usage Module on third-party Actor's "No Cookies" marketing without reading Actor source + terms. |
| **Coresignal** — <https://coresignal.com> | 907M+ employee records, 70M+ company records, 475M+ jobs via Company/Employee/Jobs/Agentic Search APIs + flat files. **No post-level content advertised** on homepage. | API key or dataset licence | **Does not name LinkedIn as a source anywhere on homepage** — verified 2026-08-30 via <https://coresignal.com>. <https://coresignal.com/solutions/linkedin-data/> returned **404** (consistent with Aug 29 check). Pricing at <https://coresignal.com/pricing/> — not helpful for posts. Terms at <https://coresignal.com/terms-and-conditions/>. | Single key — fits shape | Not published | **NO POSTS SURFACE.** Even if LinkedIn-derived, not useful for #21/#23 post engagement. | **OUT** — wrong surface. |
| **People Data Labs (PDL)** — <https://www.peopledatalabs.com/person-data> | "Comprehensive workforce profiles"; enrich/search/autocomplete/clean APIs + feeds via AWS/GCP/Snowflake/Databricks | API key or feed licence | Page: **"Stay ahead of regulatory compliance with our industry-leading data practices"** — no sourcing statement that names LinkedIn. Pricing at <https://www.peopledatalabs.com/pricing> — "We charge per match", no rates. | Single key | Not published | Stable but **NO POSTS SURFACE.** | **OUT** — wrong surface (profiles, not posts). |
| **Unipile** — <https://www.unipile.com/linkedin-api/> | Messaging, invitations, profile search, InMail, recruiting workflows **on a connected member account** | Unified API — **connection "via credentials, cookies, or Chrome extension"**; Unipile "acts as independent technical intermediary that helps software publishers connect authenticated LinkedIn accounts" — <https://www.unipile.com/linkedin-api/>; docs at <https://developer.unipile.com/docs/linkedin> | Operates **as the member**, under the member's UA — Help Centre: LinkedIn "don't permit the use of any third party software, including 'crawlers', bots, browser plug-ins" and members "risk having their accounts restricted" — <https://www.linkedin.com/help/linkedin/answer/a1341387> — plus injunction reach "whether logged in ... or not" (hiQ consent judgment). | **Breaks Shell shape** — needs hosted session / `li_at` + `JSESSIONID` + checkpoints; not a single API key; anti-ADR-0001 | €5.00 per account/month, €49/mo minimum for 10 accounts — <https://www.unipile.com/pricing-api/> | Requires managing LinkedIn session lifecycle, checkpoints, 2FA | **OUT.** Posture violation: no login, no imported cookies, no shared identity — per `apps/server/src/modules/content-scout/adapters/linkedin.ts` + hiQ injunction language. |
| **Phantombuster** — <https://phantombuster.com> | Phantom automations for LinkedIn (outreach + scraping) via headless browser + session | Cloud browser automation; API key + LinkedIn cookie | <https://phantombuster.com/legal/terms-and-conditions/> + LinkedIn UA/HELP same as above | Needs session — breaks posture | Plans from ~$29/mo; LinkedIn Phantoms metered | Requires active LinkedIn session + anti-bot evasion | **OUT** — same session violation. |
| **Captain Data** — <https://captain-data.com/integrations/linkedin/> | Workflow automation over LinkedIn via user's session | Session-based API | Needs session — docs at <https://captain-data.com/integrations/linkedin/> | Breaks posture | Not published (**Unverified**) | Session-based | **OUT** — same. |
| **ScrapingBee** — <https://www.scrapingbee.com/> | General web scraping API (render JS, proxies) — not LinkedIn-specific | API key + render query | General ToS — <https://www.scrapingbee.com/>; would still fetch `linkedin.com` HTML behind `Disallow: /` | Single key | From $49/mo (per <https://www.scrapingbee.com/pricing>) | General-purpose — not LinkedIn-optimized | **OUT** — still fetches blocked paths; no LinkedIn post extraction. |
| **Nimble (Nimbleway)** — <https://nimbleway.com/> | Web data API with LinkedIn routes | API key | <https://www.nimbleway.com/pricing> — API credits | Single key | From $199/mo tier | General scraper marketplace | **OUT** — same blocked-path issue; not post-engagement-specific. |
| **LinkDAPI** (Proxycurl successor) — <https://linkdapi.com/blog/migrating-from-proxycurl-to-linkdapi> | Person/profile search as Proxycurl shim | API key (shim) | Migration shim — inherits same UA aggregator clause | Single key | **Unverified** — not pulled this pass | Shim over sunset product | **OUT** — profiles, not posts. |

**Reachability gaps (marked, not inferred):** `https://www.ninjapear.com` DNS-unresolvable at check time (**Unverified** — sunset page cites name, not reachable origin); `https://brightdata.com/terms` 404 at check — canonical terms are at `/terms-and-conditions` + `/acceptable-use-policy` (cited); `https://coresignal.com/solutions/linkedin-data/` 404 on both passes (product page removed or renamed); Apify per-Actor pricing on listing not shown (only jobs shards published). Treat any cost claim for those as Unverified until Actor page opened.

**Litigation posture, precisely (no holdings claimed unless order text read):** `hiQ Labs, Inc. v. LinkedIn Corp.`, No. 17-16783 (9th Cir. Apr. 18, 2022) — preliminary injunction, not merits judgment — <https://cdn.ca9.uscourts.gov/datastore/opinions/2022/04/18/17-16783.pdf> — plus district summary judgment order (N.D. Cal. Oct 27, 2022, Dkt. 404) finding UA anti-scraping terms **unambiguous and breached** but denying SJ on waiver/estoppel, and consent judgment (Dkt. 406, Dec 8, 2022) — $500k + permanent injunction barring automated access "whether directly or indirectly through a third party … whether logged in … or not" — all cited verbatim in `linkedin-reading-options.md` §3. `Meta v. Bright Data` (N.D. Cal. 3:23-cv-00077) and `X Corp v. Bright Data` (3:23-cv-03698) — dockets confirmed terminated 2024-02-26 and 2025-07-01 respectively — **merits not read; no holding asserted** — per prior research discipline.

---

## 8. Fit against this app's rules

| Rule (primary source) | Verdict for this harvest |
|---|---|
| **ADR-0001 local-first, single-user** — <https://github.com/nicolas-found42/chief-of-staff-demo/blob/main/docs/adr/0001-local-first-single-user.md> — Operator supplies own OAuth client / Notion token / HubSpot token / model API key; no multi-tenant LinkedIn session pool | **PASS for all §3 / §5 / §6 candidates.** Each needs *zero or one* LLM key stored once in Shell config. RSSHub self-hosted is infra, not a credential. Every LinkedIn scraper candidate in §4 **FAILS** this gate (needs per-user `li_at`/`JSESSIONID`/password). |
| **ADR-0007 / ADR-0011 Shell owns connection state** — Shell holds Google connection (OAuth), not Modules | **PASS — and argument for no second OAuth.** All recommended paths reuse the Google connection (Sheets/Gmail/Tasks/Drive + YouTube via Data API same cred) or are keyless. Introducing a second OAuth (LinkedIn Member Data Portability scope `r_dma_portability_self_serve` — <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-member/>) or Product Hunt OAuth would require a second refresh/expiry to model — the exact "second secret store" ADR-0016 rejected for YouTube. |
| **ADR-0016 YouTube rides the Google connection** | **PASS** — Channel view counts come via the same connection; no new secret. |
| **Content Scout posture** — clean anonymous public browser, no login, no imported cookies, no CAPTCHA bypass, respect `robots.txt` — `content-scout-source-adapters.md:291` + `apps/server/src/modules/content-scout/adapters/linkedin.ts` placeholder | **PASS for Shapes A/C/D/E + §5 local STT + §6 lawful adapters. CONDITIONAL for Shape B (RSSHub):** many routes anonymous, some require cookies/auth/anti-bot — **must allowlist anonymous-only routes** and reject cookie-requiring ones. **FAIL for every §4 LinkedIn scrape + Unipile/Phantombuster/Captain Data session path** — they all violate at least one of: `User-agent: * Disallow: /` on `https://www.linkedin.com/robots.txt` (every path; checked 2026-08-30, 4,868 lines, final `Disallow: /`), UA §8.2 scrape/copy/bypass bans, HELP centre restriction warning. |
| **ADR-0030 model-boundary failures are classified facts** — <https://github.com/nicolas-found42/chief-of-staff-demo/blob/main/docs/adr/0030-model-boundary-failures-are-classified-facts.md> | **PASS for transcript layer.** Transcripts are private; failure facts carry classified fields (provider/model/shape) not payload text — aligns with local Whisper + Shell single LLM seam (no verbatim in logs). SaaS bot-in-meeting would exfiltrate private transcripts. |
| **ADR-0036 / ADR-0038 owner identity + wait-and-expire** | **PASS for two creative shapes in §6/§9.** Open-Web Resonance Scout (§9 Module A) and Founder Signal Desk (§9 Module B) both use Intake/Stages/Output Adapters with bounded `wait` only if a grill decides to add it — no hidden LinkedIn wait. |
| **Evidence & robots discipline** | `playwrightBrowserRenderer` (`apps/server/src/modules/content-scout/adapters/browser.ts`) fetches URLs directly and **does not currently check `robots.txt`** — noted in `linkedin-reading-options.md` §4.3. Gap is independent of this decision but should be closed before any "Coming later" adapter is re-enabled. |

Module-scoped third-party credential precedent — `meeting-brief-generator.guestProfile: { endpoint, apiKey, lastVerifiedAt, lastCheckAt, lastCheckState, lastCheckDetail }` in `packages/shared/src/schemas.ts:166` `redactConfig` redacts `apiKey` only for `google.clientSecret`/`notion.token` subset — any new Module secret (e.g., `PRODUCT_HUNT_TOKEN`) would need its own redaction entry (not this ticket's fix, but flagged here for next PR).

---

## 9. Two concrete "build without LinkedIn" Module shapes (satisfy #21's job, not its platform)

Both assume ADR-0001 single-key Shell credential shape, clean anonymous browser, polite fetching (`Retry-After`, honest UA, per-host backoff), Intake → Stages → Output Adapters, and the shared `SourceItem` envelope from `content-scout-source-adapters.md` (`externalId, canonicalUrl, author, publishedAt, discoveredAt, media[], transcript?, comments[], evidence[], completeness`).

Prior art cited for each stage is from §3 — no LinkedIn read.

### Module A — "Open-Web Resonance Scout" (person-centric, cross-platform ledger)

*Replaces:* #21 Content Research's "watch 11 named people's LinkedIn posts and report what is resonating" with a public-web ledger that answers the same job: *who posted what, where it landed, how much it moved.*

**Prior art:** `Shubhamsaboo/awesome-llm-apps` DevPulse AI (aggregates + scores technical signals into daily digest) + AI Deep Research Agent (Firecrawl + Agents SDK); `DIYgod/RSSHub` routes + `brh55/google-news-rss` + HN Algolia + YouTube Data API — all in §6; `brettkromkamp/awesome-knowledge-management` NetworkX/Cytoscape.js for graph ledger.

**Intake (weekly + on-demand backfill 7/30/90d):** `NamedPerson` list (11 names, as in LI Content Researcher) → canonicalize to person entity with optional disambiguation (employer domain, known handle). Per person, configured `Source Target`s: Bluesky DID/handle (`app.bsky.feed.getAuthorFeed` — <https://docs.bsky.app/docs/api/app-bsky-feed-getAuthorFeed>), Mastodon `@user@instance` (`/api/v1/accounts/:id/statuses` — <https://docs.joinmastodon.org/methods/timelines/>), YouTube channel ID, HN author (`by:"Ada Lovelace"` via `<https://hn.algolia.com/api>` `search_by_date`), Google News RSS `q="Ada Lovelace"` (wrappers: <https://github.com/brh55/google-news-rss>), Product Hunt maker handle, company blog RSS (auto-discovered `<link rel="alternate">` via `rss-parser`). RSSHub is *optional* synthesis layer.

**Stages (per Run, bounded concurrency):**
1. `Collect` — parallel adapters: `BlueskyAdapter` (`getAuthorFeed` → `likeCount/repostCount/replyCount`), `MastodonAdapter` (favourites/reblogs), `YouTubeAdapter` (`search.list` → `videos.list` → view/like/comment counts), `HackerNewsAdapter` (Algolia → points/comments), `GoogleNewsAdapter` (RSS → headline cluster count), `ProductHuntAdapter` (GraphQL → `votesCount` — <https://api.producthunt.com/v2/docs>). Each returns `SourceItem` + `evidence[]` + `completeness`.
2. `Normalize` — URL canonicalization, dedup, `publishedAt`/`discoveredAt`, author normalization against internal Employer Match if consumer domain.
3. `ScoreResonance` — per-item raw counts → z-score vs person's 90-day baseline (from `awesomedata/awesome-public-datasets` rolling window) + cross-platform rollup (weighted: views 1, votes 2, HN points 3, reposts 4). Output: `ResonanceReport` per person: top 3 posts, why resonating (topic + quote + signal breakdown).
4. `Brief` — LLM synthesis over top evidence only (no payload in failure facts per ADR-0030), emitting `Resonance Brief` (same shape as Meeting Brief Generator but prospectively scored).

**Output Adapters:** `SheetLedgerAdapter` → `Resonance Ledger` keyed on `(person, canonicalUrl)` with `publishedAt, platform, title, url, views/likes/reposts/points/comments, resonanceScore, evidenceUrl`; `GmailDraftAdapter` — one digest draft per run to owner only (ADR-0034 style) + links; `HomeNotificationAdapter` — "3 people resonating today — X's YT post +230% baseline". No LinkedIn write.

**Credential shape:** YouTube single key in Shell Google connection OR `YOUTUBE_API_KEY`; `PRODUCT_HUNT_TOKEN` only if enabled; else entirely keyless. **ToS: PASS** everywhere (public APIs/RSS).

### Module B — "Founder Signal Desk" (topic-centric, launch + community ledger)

*Replaces:* Same #21 job optimized for founder/B2B signal: *what themes from these people are spreading in founder communities.*

**Prior art:** `tuan3w/awesome-tech-rss` + `plenaryapp/awesome-rss-feeds` (200+ RSS); `igorbarinov/awesome-data-engineering` ingestion patterns; `Shubhamsaboo/awesome-llm-apps` Product Launch Intelligence Agent + `firecrawl/firegeo` brand monitoring; Content Scout live Module pattern (Source Target → Source Item → Content Opportunity → Content Pack).

**Intake (daily overlap 48h + weekly discovery):** `Source Target`s are `person → company blog RSS`, `person → podcast RSS (with transcript)`, `person → Product Hunt maker feed`, `person → Reddit author RSS via RSSHub /reddit/user/:user` + subreddit search. `Source Discovery` weekly: uses Brand Profile + approved Source Targets → suggests new targets via outbound links, co-mentions, PH related makers.

**Stages:**
1. `Harvest` — RSS polling (conditional GET, ETag), podcast transcript extraction (RSS `podcast:transcript` else `yt-dlp`/`whisper.cpp` enrichment), Reddit score fetch.
2. `ExtractTopics` — Readability + transcript → LLM topic clustering with Result Shape binding (ADR-0029) → `Content Opportunity` candidates (title, angle, evidence URLs).
3. `ScoreSpread` — per-topic spread = Reddit `score` + `num_comments` + PH `votesCount` + Google News frequency + podcast guest co-mention count + HN Algolia boost if front-page.
4. `Rank & Explain` — top 5 opportunities with "why resonating": verbatim quote (confidence ≥0.9 per Content Idea evidence rule) + timestamp + signal table.

**Output Adapters:** `DigestSheetAdapter` → `Topic Spread Ledger` keyed on `(person, topicClusterId)` with `lastSeen, spreadScore, evidenceJson, topPostUrl`; `NotionContentQueueAdapter` → Notion page per opportunity (mirrors Idea Engine's `All RA Content Ideas` Sheet pattern but for external resonance); `PodcastClipEvidenceAdapter` — transcript excerpt + `yt-dlp` caption receipt as `evidence[]`.

**Credential shape:** Entirely keyless if PH disabled (RSS + Reddit RSS + HN Algolia + Google News RSS); if PH enabled, one `PRODUCT_HUNT_TOKEN`. **ToS: PASS.**

Why these satisfy #21 without LinkedIn: #21's acceptance is *functional*: "watch named people, report what is resonating and why" — not *platform*: LinkedIn. Both modules watch the same people, replace `reactions` with a portfolio of public signals whose *counts are the product* (counts → sheet ledger, analysis → digest). They degrade gracefully: if Bluesky has no posts, HN + News + YT still score. Prior art repos prove each piece ships with fixtures and canaries.

---

## 10. Creative adjacent — what replaces LinkedIn reactions, by platform fidelity

This is the exhaustive horizontal search's yield. LinkedIn `reactions + comments + reposts` is a per-post engagement ledger; each row names the surrogate signal, its official access model, and whether it survives the posture gate.

| Candidate (repo/doc URL) | Surrogate for LinkedIn reactions | License / Cost | Auth | ToS / robots | Fidelity | Verdict |
|---|---|---|---|---|---|---|
| **Bluesky ATProto `app.bsky.feed.getAuthorFeed`** — <https://docs.bsky.app/docs/api/app-bsky-feed-getAuthorFeed> · <https://endpoints.bsky.app> | `likeCount`, `repostCount`, `replyCount`, `quoteCount` per post; timeline polling per DID | MIT (ATProto), free, no quota $ | Keyless public (`https://public.api.bsky.app`); CORS yes; optional app-password only for write | Bluesky ToS allows public API; `robots.txt` permits API | Direct 1:1 ledger replacement; **strongest LI-free signal** | **PASS — adopt** |
| **Mastodon `/api/v1/timelines/public` + `/api/v1/accounts/:id/statuses`** — <https://docs.joinmastodon.org/methods/timelines/> | `favourites_count`, `reblogs_count`, `replies_count` | AGPL-3.0 (server), free | Keyless if instance admin enables public timeline; 300 req/5min (`x-ratelimit-limit: 300` observed) | Instance ToS varies; public timeline is OFFICIAL anonymous route | Per-instance ledger; needs instance selection | **PASS per-instance** |
| **Nitter (X/Twitter via RSSHub `/nitter/:user`)** — <https://docs.rsshub.app/routes/social-media#nitter> · <https://github.com/derat/nitter-rss-proxy> (11★) | Post text + synthetic RSS; *no scores* (Nitter strips counts) — discovery only | AGPL-3.0 (Nitter), free self-host | Keyless RSS | X ToS bans scraping; Nitter instances community-maintained, frequently blocked | **FRAGILE — discovery only, not ledger** |
| **Google News RSS** `https://news.google.com/rss/search?q="…"` — parsers <https://github.com/brh55/google-news-rss> (25★, MIT), <https://github.com/NichtJens/GoogleNewsRSS2OPML> (25★) | Headline frequency + clustering rank + recency (coverage proxy) | MIT, free | Keyless GET | Google News RSS is public feed; respects publishers via Google aggregation | Coverage-as-resonance | **PASS** |
| **Hacker News Algolia `https://hn.algolia.com/api`** — <https://hn.algolia.com/api> | `points`, `num_comments`, `created_at` per story/comment; `search_by_date?tags=story&query=...&numericFilters=created_at_i>...` for person/company mention resonance | Free, no key, real-time (indexed from official HN API) | Keyless, CORS yes | Algolia ToS permits; official HN backing | Mention resonance, not author post | **PASS** |
| **YouTube Data API v3** — <https://developers.google.com/youtube/v3/docs> + quota <https://developers.google.com/youtube/v3/determine_quota_cost> | `viewCount`, `likeCount`, `commentCount`, comment sentiment stream | Free; 10,000 units/day (search.list=100, videos.list=1) | Single API key in Shell (or OAuth for owned channel) | Google ToS permits via API | Best founder-published signal | **PASS — aligns with Google connection** |
| **YouTube transcript `youtube-transcript-api`** (MIT) + `yt-dlp` fallback | Caption text for quote extraction; not a count signal | MIT | Keyless public transcripts | Public transcripts only; IP blocks observed → needs `blocked_by_youtube` diagnostic per `content-scout-source-adapters.md` | Topic resonance | **PASS** |
| **Podcast RSS + `podcast:transcript` + whisper.cpp fallback** — RSSHub podcast routes + <https://github.com/ggml-org/whisper.cpp> (MIT) | Episode recency + transcript TF-IDF + guest mentions | MIT / free self-host | Keyless RSS; Whisper local | Publisher RSS is official feed | Spoken-theme resonance | **PASS** — local Whisper is enrichment, not Intake prerequisite |
| **Reddit public RSS + JSON + RSSHub `/reddit/:subreddit`** — <https://support.reddithelp.com/hc/en-us/articles/16160319875092> | `score` (upvotes), `num_comments`, `upvote_ratio` | Free; official API needs OAuth, public RSS/JSON throttled (429) | Keyless RSS/JSON (explicit UA, slow poll); OAuth if authenticated | Anonymous public is throttlable but not stealth | Per-subreddit ledger | **PASS with backoff+UA**; authenticated hidden OAuth would violate posture |
| **Product Hunt `producthunt/producthunt-api` (373★, MIT)** — <https://github.com/producthunt/producthunt-api> + GraphQL <https://api.producthunt.com/v2/docs> | `votesCount`, `commentsCount`, daily rank, maker list | MIT client; API requires OAuth token, free tier | Single token in Shell | PH ToS allows via official API | Launch signal | **PASS — single-key** |
| **RSSHub unified envelope (1,000+ routes)** — <https://github.com/DIYgod/RSSHub> | Unified RSS across sites; includes Reddit `score`, PH `votes`, YT `views` where route exposes them | AGPL-3.0, self-host or public instance | Keyless (public) or self-host | Respects site ToS via self-host boundary; per-route anti-bot variance | Depends on route | **PASS with per-route canary** — same stance as `content-scout-source-adapters.md` |
| **Google Trends / Trends RSS** — via `awesomedata/awesome-public-datasets` `Data and Statistics` | Search interest 0–100 timeseries | Free | Keyless via `pytrends` or RSS | Google ToS allows; unofficial clients brittle | Interest proxy | **Experimental only** |
| **firecrawl/firegeo (651★, AGPL)** — <https://github.com/firecrawl/firegeo> | Brand mention extraction + visibility scoring | AGPL, self-host or SaaS | API key (Firecrawl, single-key) | Firecrawl ToS permits crawling with robots respect | Mention volume | **PASS as enrichment** |
| **NetworkX / Cytoscape.js** via `brettkromkamp/awesome-knowledge-management` Libraries | Graph `person → post → signal → topic` replacing flat Sheet; cluster centrality | BSD / MIT, free | Local, no key | Local compute | Enables "what is resonating *why*" | **PASS** — local |

GitHub code hits feeding this table (via `gh search repos` / `gh_grep`):

| Query | Repo hit | Stars | Prior art |
|---|---|---|---|
| `bluesky feed` | `gummipunkt/bsky_repost_bot` (0★) — <https://github.com/gummipunkt/bsky_repost_bot> | 0 | ATProto `app.bsky.feed` + `com.atproto.repo` usage |
| `mastodon api timeline` | `mastodon/mastodon` docs + Mastodon.py via <https://docs.joinmastodon.org/methods/timelines/> | — | 300/5min; unauthenticated public if admin enables |
| `nitter rss` | `derat/nitter-rss-proxy` (11★) <https://github.com/derat/nitter-rss-proxy> ; `MarvNC/twitter-rss-discord-webhook` (10★) | 11 | Nitter→RSS bridge — shows fragility |
| `product hunt api` | `producthunt/producthunt-api` (373★) <https://github.com/producthunt/producthunt-api> | 373 | Official PH GraphQL clients |
| `google news rss` | `brh55/google-news-rss` (25★) <https://github.com/brh55/google-news-rss> ; `NichtJens/GoogleNewsRSS2OPML` (25★) | 25 | Node/Python wrappers for `q="First Last"` |
| `brand monitoring` | `firecrawl/firegeo` (651★) <https://github.com/firecrawl/firegeo> ; `osintph/threatintel-platform` (133★) | 651 | GEO-powered brand monitoring |
| `rsshub` | `DIYgod/RSSHub` (45,938★) <https://github.com/DIYgod/RSSHub> ; `DIYgod/RSSHub-Radar` (7,317★) | 45,938 | Feed synthesis layer |
| `algolia hacker news` | GH wrappers thin — primary is <https://hn.algolia.com/api> | — | HN Algolia REST is the durable source |
| `playwright stealth` | `AtuboDad/playwright_stealth` (983★) <https://github.com/AtuboDad/playwright_stealth> + forks (266★, 221★, 151★) | 983 | See anti-pattern below |

---

## 11. Anti-patterns — what the awesome sweep surfaced and why it is NEVER

| Shape | What it is | Where found | Why it violates posture / ToS | Verdict |
|---|---|---|---|---|
| `playwright stealth` + LinkedIn scrape — `AtuboDad/playwright_stealth` (983★) <https://github.com/AtuboDad/playwright_stealth> + forks `Mattwmaster58/playwright_stealth` (266★), `tinyfish-io/tf-playwright-stealth` (221★) | Playwright extra patching `navigator.webdriver`, `chrome` object to evade bot detection | `gh search repos "playwright stealth"` + usage at <https://github.com/AtuboDad/playwright_stealth#usage> | Bypasses access controls; violates UA §8.2 "bypass or circumvent any access controls" + `robots.txt Disallow: /` + help centre restriction warning — <https://www.linkedin.com/help/linkedin/answer/a1341387>. Contradicts `content-scout-source-adapters.md` "respect robots directives … do not attempt CAPTCHA bypass or stealth login" | **NEVER** |
| `linkedin_scraper` / `LinkedIn-Scraper` with account login — `joeyism/linkedin_scraper` (GPL-3.0) <https://github.com/joeyism/linkedin_scraper>, `pratik-dani/LinkedIn-Scraper` (AGPL) <https://github.com/pratik-dani/LinkedIn-Scraper> | Playwright/HTTP scraper requiring valid LinkedIn account | Evaluated in `content-scout-source-adapters.md` Table | Same UA + robots violation; also violates ADR-0001 shell pattern (would need per-user LinkedIn login) | **NEVER** |
| Member-authenticated vendor (Unipile, cookie Actors) | Unipile Unified API holding LinkedIn session on behalf of user — <https://www.unipile.com> + MCP <https://github.com/bhaktatejas922/unipile-linkedin-mcp> (2★) | `gh search repos "unipile linkedin"` + <https://developer.unipile.com/docs/linkedin> (requires `username/password` OR `li_at` cookie + checkpoints) | Customer ToS risk is contractually customer's (Visum precedent); UA reaches data via brokers; requires hosted session beyond Shell single-key; breaks ADR-0001 local-first pattern | **NEVER for anonymous monitoring** — vendor notable, not adapter |
| `scraping.reverseContact.post.fromProfileUrl` | Vendor `POST /v2/fetch/persons/posts/live` | Docs <https://app.reversecontact.com/docs/public/guides/july-2026-platform-update> | Activities discontinued 2026-07-01 "will not be replaced, on V2 or anywhere else" — permanent; buying LI-derived data does not waive UA §8.2 aggregator clause | **DEAD + TOS-risk-bearing — do not resurrect** |
| PhantomBuster / Captain Data session automations | Headless browser + session over LinkedIn | <https://phantombuster.com> / <https://captain-data.com/integrations/linkedin/> | Same session violation | **NEVER** |
| Member Data Portability as ledger replacement | Self-serve LinkedIn DMA: <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-member/> + domains <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/shared/snapshot-domain> | EEA/Switzerland only; `MEMBER_SHARE_INFO` gives URL+date, **no impressions/reactions-received**; Changelog only 28-day window | Not a violation, but not a ledger **and** would need a second OAuth connection (anti-ADR-0011) | Tempting as "official" — flagged as not-replacement |
| LinkedIn Company Page analytics `r_organization_social` | Community Management API Page Analytics: <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api> — Page Statistics / Share Statistics / Social Metadata | Vetted product, Standard Tier + screencast video; scoped to orgs where auth member has ADMINISTRATOR/SPONSORED_CONTENT_POSTER/CONTENT_ADMIN | Would give genuine reactions/comments but *only for company page posts*, not person's posts — wrong scope unless #21 pivots to company pages | Not a violation, but wrong scope |

---

## 12. Recommendation

**Stop reading LinkedIn. Retire the `LinkedInComingLaterAdapter` from "Coming later" to stated "Not supported (respecting `robots.txt` — reopens only on allowlist permission)", and build both Modules without LinkedIn.**

1. **#21 Content Research — no LinkedIn.** There is no official API that returns another member's posts at any tier (linkedin-reading-options.md §1.1–1.2), the vendor the Workflow used (`scraping.reverseContact.post.fromProfileUrl` → `POST /v2/fetch/persons/posts/live`) was **permanently retired 2026-07-01 with no replacement** (<https://app.reversecontact.com/docs/public/guides/july-2026-platform-update>), every remaining vendor route runs into UA §8.2 directly or via the aggregator clause and the `robots.txt` `Disallow: /`, and the clean-browser route is disallowed on every path. Rebuild the *job* — watch a named set of people, report what is resonating and why — over the adapter portfolio proven in §3 + §6 + §10. Ship **Shape A (generic RSS + website + YouTube + Reddit) + Shape D (LLM scoring → GitHub Issue / Markdown briefing)** as #21 V1, keep RSSHub as optional self-hosted anonymous-routes-only compatibility layer. Let the grill decide whether it is its own Module or a `Content Scout` Source Target set with a different Output Adapter (the question flagged in linkedin-reading-options.md §5.1).

2. **#23 LinkedIn Engagement Tracker — do not rebuild as specified.** The engagement metrics it ledgers are not obtainable for a personal profile by any lawful anonymous route. Put the two reduced shapes to Nicolas explicitly (member question — see §13) and close if neither appeals: (a) Member Data Portability ledger of *what was posted and when* without metrics (conditional on EEA/CH residency — <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-member/>), (b) Company Page via Community Management API if found42 has a Page and Nicolas administers it (vetted product, screencast — <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api>), otherwise (c) the two creative ledgers in §6.5: Resonance ledger (Bluesky/Mastodon/HN/YT/Reddit/Google News counts) or Topic spread ledger — both lawful, both keyless-or-single-key, both graceful-degrading. A Workflow with 30 Runs and zero successes has never delivered anything; rebuilding it faithfully is not possible anyway.

3. **Retire the adapter's gate.** Not because the gate is wrong — it is careful, correct work — but because it can never pass while the project holds itself to respecting `robots.txt`, and leaving it as "Coming later" implies a route that reopens with more evidence. It reopens only if LinkedIn changes `robots.txt` or grants permission via <mailto:whitelist-crawl@linkedin.com> (header of <https://www.linkedin.com/robots.txt>).

### The strongest case *against* this recommendation

**Bright Data is a real option and this report declines it on a terms reading rather than a legal ruling.**

It publishes a LinkedIn posts dataset with engagement metrics at roughly **$0.0025 per record** ($250 per 100k — <https://brightdata.com/products/datasets/linkedin>), claims collection exclusively from publicly available sources in compliance with GDPR/CCPA + ISO 27001 and SOC 2, and has been sued by two platforms without either case producing a judgment against it that this research has read. Buying a dataset requires no LinkedIn account, no cookie, no login, and no crawl of `linkedin.com` by this app at all — so it breaks none of Content Scout's *posture* rules about borrowed identity, and it drops into the existing Shell secret pattern (`notion`/`hubspot`/`guestProfile` single-key) with no new architecture. It would unblock #21 essentially as designed, and possibly #23 too.

The case against this recommendation is therefore: *this app is a three-person local tool, not a commercial data service; the User Agreement binds LinkedIn's members and this app is not accessing LinkedIn; §8.2's aggregator clause has not to the author's knowledge been tested against a good-faith purchaser of a public-data set; and refusing a lawful commercial product because its upstream terms disapprove is a stricter standard than the project applies elsewhere.*

Three things weigh against that, and they are why this report still recommends against it:

- The aggregator clause is not ambiguous about intent, and hiQ's district court read LinkedIn's §8.2 as **unambiguous and enforceable** rather than aspirational (hiQ Labs, Inc. v. LinkedIn Corp., Dkt. 404, at 12 — <https://storage.courtlistener.com/recap/gov.uscourts.cand.312704/gov.uscourts.cand.312704.404.0_1.pdf>).
- The consent judgment reaches access "directly or **indirectly through a third party, intermediary, or proxy**" and "whether logged in … or not" (Dkt. 406 — <https://storage.courtlistener.com/recap/gov.uscourts.cand.312704/gov.uscourts.cand.312704.406.0.pdf>). That binds only hiQ, but is a precise statement of the position LinkedIn litigates from.
- Vendor durability is the practical argument, and it is the one #115 exists because of. **Proxycurl is gone** ("Proxycurl is no longer in service" — <https://nubela.co/proxycurl>). **reverseContact retired the exact capability with 30 days' notice** ("will not be replaced, on V2 or anywhere else" — <https://app.reversecontact.com/docs/public/guides/july-2026-platform-update>). Building the highest-usage unresolved Module on a fourth vendor in this category is building on the same sand.

If Nicolas weighs the first two lightly, Bright Data is the answer for #21 and this report should be re-read as recommending it, with the durability risk accepted explicitly and an Adapter boundary drawn so the vendor can be swapped.

---

## 13. What remains Unverified / open questions for Nicolas

These are the two questions already in `linkedin-reading-options.md` §8, unchanged by this sweep, plus three harvest-specific gaps:

- **EEA residency.** The Member Data Portability route for #23 depends on whether Nicolas is a LinkedIn member located in the EEA or Switzerland — the gate is on the member's location (<https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-member/>). Visum being French says nothing about this.
- **LinkedIn Page.** Whether found42 has a LinkedIn Page, whether Nicolas administers it, and whether the tracked posts were the person's or the Page's — decides whether the Community Management API route exists at all.
- **Brand Profile baseline for §9.** Module A's per-person 90-day baseline window assumes an existing Brand Profile revision — verified via `CONTEXT.md` Brand Profile definition, but current workspace baseline not inspected by this research.
- **Stars / commits marked Unverified.** Any "Unverified" star or last-commit in §2–§6 means the value was read from a search index, not re-fetched via `gh api repos/<nwo>` this session — re-verify from `https://api.github.com/repos/<nwo>` before contractual reliance.
- **Apify per-Actor "No Cookies" claim.** The claim is the Actor author's, not Apify's; this research sampled 3 Actor pages but did not inspect Actor source code or network logs — treat "No Cookies" as marketing until verified at the Actor level.

---

## 14. What to do next — per map ticket

| Map ticket | Action | Why this harvest justifies it |
|---|---|---|
| **#115 (research driver)** | Close as "decided — do not read LinkedIn" with links to this report + `linkedin-reading-options.md` | Both passes converge: same Terms / `robots.txt` / retirement findings, plus creative proof that #21 does not need LinkedIn. |
| **#21 Content Research** | Grill with Module A vs B vs "Content Scout configuration" framing; spec as #21 V1 = Shape A + D; keep RSSHub optional | This pass validates #115's "let the grill decide whether it is its own Module or a Content Scout configuration" — §3 C1–C11 provide prior art for both. |
| **#23 Engagement Tracker** | Present three shapes (§12) to Nicolas; if none appeals, close without rebuild | Ledger is achievable without LinkedIn (§6.5) but is no longer *LinkedIn* engagement. |
| **#114 / #22 / #18** | Proceed — transcript pipeline is independent of LinkedIn decision; prefer local `whisper.cpp` + single LLM seam | §5 shows local STT + diarization path is mature, private, and fits ADR-0030. |
| **#12 map** | Update LinkedIn bullet: "no anonymous post read exists; Content Research without LinkedIn validated via 11 repo candidates; vendor durability risk confirmed (2 gone)" | Keeps map current without re-research. |
| LinkedIn adapter code | Add `playwrightBrowserRenderer` `robots.txt` check + flip `LinkedInComingLaterAdapter` to explicit "Not supported" | Gap noted in both research passes. |

No code change in this research pass — per handoff §1 "research, not build".

---

## Sources — primary per claim (in order cited)

LinkedIn posture:
- UA: <https://www.linkedin.com/legal/user-agreement>
- robots.txt: <https://www.linkedin.com/robots.txt>
- API Terms: <https://www.linkedin.com/legal/l/api-terms-of-use>
- Getting Access (Open vs Restricted permissions): <https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access>
- Posts API + `r_organization_social` / `r_member_social`: <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api>
- Community Management overview (`r_member_social` closed): <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview>
- Member Data Portability (EEA/CH) + snapshot domains: <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-member/> + <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/shared/snapshot-domain> + snapshot API <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/shared/member-snapshot-api>
- Help Centre crawler ban: <https://www.linkedin.com/help/linkedin/answer/a1341387>

Vendor primary:
- reverseContact platform update + changelog + pricing + legal: <https://app.reversecontact.com/docs/public/guides/july-2026-platform-update> + <https://app.reversecontact.com/docs/public/changelog> + <https://reversecontact.com/pricing> + <https://reversecontact.com/legal/terms-of-services>
- Proxycurl sunset → NinjaPear: <https://nubela.co/proxycurl> + <https://nubela.co/blog/goodbye-proxycurl/> + <https://linkdapi.com/blog/migrating-from-proxycurl-to-linkdapi>
- Bright Data LinkedIn datasets + Scraper API + pricing + acceptable use + GDPR: <https://brightdata.com/products/datasets/linkedin> + <https://brightdata.com/products/web-scraper/linkedin> + <https://brightdata.com/acceptable-use-policy> + <https://brightdata.com/trustcenter/gdpr>
- Apify store + sampled Actors: <https://apify.com/store?search=linkedin> + <https://apify.com/apimaestro/linkedin-profile-posts> + <https://apify.com/harvestapi/linkedin-profile-posts-scraper-no-cookies> + <https://apify.com/supreme_coder/linkedin-post-scraper>
- Coresignal: <https://coresignal.com> + pricing <https://coresignal.com/pricing/> + terms <https://coresignal.com/terms-and-conditions/> + missing <https://coresignal.com/solutions/linkedin-data/> (404)
- PDL: <https://www.peopledatalabs.com/person-data> + pricing <https://www.peopledatalabs.com/pricing>
- Unipile: <https://www.unipile.com/linkedin-api/> + docs <https://developer.unipile.com/docs/linkedin> + pricing <https://www.unipile.com/pricing-api/>
- Phantombuster: <https://phantombuster.com> + terms <https://phantombuster.com/legal/terms-and-conditions/>
- Captain Data: <https://captain-data.com/integrations/linkedin/>
- ScrapingBee: <https://www.scrapingbee.com/> + pricing <https://www.scrapingbee.com/pricing>
- Nimble: <https://nimbleway.com/> + pricing <https://www.nimbleway.com/pricing>

Alternatives:
- Bluesky: <https://docs.bsky.app/docs/api/app-bsky-feed-getAuthorFeed> + <https://endpoints.bsky.app/>
- Mastodon: <https://docs.joinmastodon.org/methods/timelines/> + public <https://docs.joinmastodon.org/client/public/> + <https://mastodonpy.readthedocs.io/en/stable/07_timelines.html>
- HN Algolia: <https://hn.algolia.com/api> + <https://hn.algolia.com/about>
- YouTube Data API quota: <https://developers.google.com/youtube/v3/determine_quota_cost> + docs <https://developers.google.com/youtube/v3/docs>
- RSSHub routes: <https://docs.rsshub.app/routes/social-media> + <https://github.com/DIYgod/RSSHub> + radar <https://github.com/DIYgod/RSSHub-Radar>
- PH API: <https://api.producthunt.com/v2/docs> + <https://github.com/producthunt/producthunt-api>
- Google News RSS wrappers: <https://github.com/brh55/google-news-rss> + <https://github.com/NichtJens/GoogleNewsRSS2OPML>

Google/Notion/HubSpot limits:
- Sheets: <https://developers.google.com/workspace/sheets/api/limits>
- Drive: <https://developers.google.com/workspace/drive/api/guides/limits>
- Gmail: <https://developers.google.com/workspace/gmail/api/reference/quota>
- Notion: <https://developers.notion.com/reference/request-limits>
- HubSpot: <https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines>

Awesome lists (raw README + `gh api`):
- <https://github.com/awesomelistsio/awesome-linkedin> · <https://github.com/lorien/awesome-web-scraping> · <https://github.com/jivoi/awesome-osint> · <https://github.com/CIPHER387/OSINT_STUFF_TOOL_COLLECTION> · <https://github.com/sindresorhus/awesome-whisper> · <https://github.com/danielrosehill/Awesome-Whisper-Apps> · <https://github.com/ishandutta2007/Awesome-AI-Meeting-Notes> · <https://github.com/Meeting-Mistro/awesome-meetings> · <https://github.com/voidfiles/awesome-rss> · <https://github.com/AboutRSS/ALL-about-RSS> · <https://github.com/plenaryapp/awesome-rss-feeds> · <https://github.com/tuan3w/awesome-tech-rss> · <https://github.com/zudochkin/awesome-newsletters> · <https://github.com/marcelkooi/awesome-newsletter-tools> · <https://github.com/brandonhimpfen/awesome-content-marketing> · <https://github.com/lucky-verma/awesome-creator-tools> · <https://github.com/brandonhimpfen/awesome-social-media> · <https://github.com/DocNow/awesome-social-media-archiving> · <https://github.com/e2b-dev/awesome-ai-agents> · <https://github.com/Shubhamsaboo/awesome-llm-apps> · <https://github.com/igorbarinov/awesome-data-engineering> · <https://github.com/awesomedata/awesome-public-datasets> · <https://github.com/brettkromkamp/awesome-knowledge-management> · <https://github.com/googleworkspace/awesome-workspace> · <https://github.com/oshliaer/google-apps-script-awesome-list> · <https://github.com/grant/awesome-apps-script> · <https://github.com/spencerpauly/awesome-notion> · <https://github.com/lorey/awesome-hubspot> · <https://github.com/d2s/awesome-spreadsheet> · <https://github.com/DIYgod/RSSHub>

Transcription / diarization:
- <https://github.com/openai/whisper> + <https://github.com/ggml-org/whisper.cpp> + <https://github.com/SYSTRAN/faster-whisper> + <https://github.com/m-bain/whisperX> + <https://github.com/pyannote/pyannote-audio> + <https://github.com/collabora/WhisperLive> + <https://github.com/Zackriya-Solutions/meetily> + <https://github.com/screenpipe/screenpipe> + <https://github.com/rishikanthc/scriberr> + <https://github.com/thewh1teagle/vibe>

RSS/LLM candidates:
- <https://github.com/umputun/newscope> · <https://github.com/leozqin/precis> · <https://github.com/CartesianXR7/Meridian> · <https://github.com/jbrunclik/sift> · <https://github.com/kronprinzmagma/ki-news-aggregator> · <https://github.com/eschnou/morningdeck> · <https://github.com/claude-world/trend-pulse> · <https://github.com/DanieleGiovanardi2408/idea-radar> · <https://github.com/DIYgod/RSSHub> · <https://github.com/taielab/awesome-ai-news>

Stealth anti-pattern:
- <https://github.com/AtuboDad/playwright_stealth> + forks <https://github.com/Mattwmaster58/playwright_stealth> / <https://github.com/tinyfish-io/tf-playwright-stealth>

Cross-source building blocks (already in-repo):
- <https://github.com/apify/crawlee> (Apache-2.0) · <https://github.com/mozilla/readability> (Apache-2.0) · <https://github.com/rbren/rss-parser> (MIT) · <https://github.com/yt-dlp/yt-dlp> (Unlicense)

Repo gates & vocabulary:
- `AGENTS.md` · `CONTEXT.md` · `docs/adr/0001-local-first-single-user.md` · `docs/adr/0007-per-user-google-oauth-client.md` · `docs/adr/0011-shell-owns-connection-state.md` · `docs/adr/0016-youtube-rides-the-google-connection.md` · `docs/adr/0030-model-boundary-failures-are-classified-facts.md` · `docs/adr/0036-the-owner-identity-is-read-once-and-held-until-the-connection-changes.md` · `docs/adr/0037-generated-fields-are-regenerated-never-edited.md` · `docs/adr/0038-a-meeting-debrief-waits-for-a-person-and-expires-rather-than-sending.md` · `docs/agents/verification.md` · `docs/research/content-scout-source-adapters.md` · `docs/research/dev-tooling.md`

Litigation (read, not relied for holdings beyond quoted lines):
- `hiQ Labs, Inc. v. LinkedIn Corp.`, No. 17-16783 (9th Cir. Apr. 18, 2022), <https://cdn.ca9.uscourts.gov/datastore/opinions/2022/04/18/17-16783.pdf> · Dkt. 404 (N.D. Cal. Oct 27, 2022) <https://storage.courtlistener.com/recap/gov.uscourts.cand.312704/gov.uscourts.cand.312704.404.0_1.pdf> · Dkt. 406 Consent Judgment (Dec 8, 2022) <https://storage.courtlistener.com/recap/gov.uscourts.cand.312704/gov.uscourts.cand.312704.406.0.pdf>

_Point-in-time values (stars, last-push) are signals, not selectors, per `content-scout-source-adapters.md`. Where this report says "Unverified", the star/license/last-commit was read from the search index, not from `gh api repos/<nwo>` in this session — re-fetch that repo's `https://api.github.com/repos/<nwo>` before quoting it contractually._
