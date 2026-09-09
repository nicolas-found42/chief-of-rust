# GitHub patterns for general person research

Investigated 2026-09-06. This is source-code and documentation research, not a live provider
availability test or an adopted implementation decision. Source acquisition must be free and
require no API key; research and evaluation models remain configurable. The effort includes both
the 30-person evaluator and production sourcing expansion.

## Orchestration examples

| Project | Verified pattern | Applicability and limits |
| --- | --- | --- |
| [Vane, formerly Perplexica](https://github.com/ItzCrazyKns/Vane) | An LLM research loop selects tools, receives their results and repeats until done or an iteration ceiling. Search batches run concurrently against SearXNG. | Closest reviewed example to the desired combination of configurable models and self-hosted metasearch. Its question-answering workflow is not a person-identity or persistent-dossier system. |
| [LangChain Open Deep Research](https://github.com/langchain-ai/open_deep_research) | A supervisor dispatches bounded concurrent research units; researchers execute tools, receive observations, and iterate. | Useful example of decomposing research by unanswered questions. Default Tavily and native provider search do not meet the source constraint; only orchestration patterns with compliant replacement tools are candidates. |
| [dzhng/deep-research](https://github.com/dzhng/deep-research) | Generate queries with research goals, search concurrently, extract learnings and follow-up questions, then recurse with decreasing depth and breadth. | A compact example of adaptive searching. Its Firecrawl search dependency is not evidence of a compliant deployed acquisition path. Shrinking breadth could miss sparse or unexpected person evidence. |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | Best-first traversal maintains scored URLs, visited state, depth/page limits and cancellation/resume hooks. | Useful for following discovered pages and preserving a pending-link queue. It does not supply general identity discovery. Its successful-page ceiling is not a complete attempted-request budget. |
| [GPT Researcher](https://github.com/assafelovic/gpt-researcher/blob/main/docs/docs/gpt-researcher/search-engines/search-engines.md) | Configurable retrievers, including Searx and DuckDuckGo; its documentation describes multiple retrievers in sequence. | A retriever abstraction is useful; the default Tavily service and other keyed providers cannot be adopted as the baseline. |

Code evidence inspected:

- Vane [research loop](https://github.com/ItzCrazyKns/Vane/blob/348feca3e378fb4157b217724ed508dc707f853f/src/lib/agents/search/researcher/index.ts)
  and [search implementation](https://github.com/ItzCrazyKns/Vane/blob/348feca3e378fb4157b217724ed508dc707f853f/src/lib/agents/search/researcher/actions/search/baseSearch.ts).
  The quality path selects a few pages to scrape; that is not enough by itself to establish dossier
  completeness. Its [social action](https://github.com/ItzCrazyKns/Vane/blob/348feca3e378fb4157b217724ed508dc707f853f/src/lib/agents/search/researcher/actions/search/socialSearch.ts)
  explicitly selects Reddit, so its label must not be read as comprehensive social-platform support.
- LangChain [supervisor and researcher loops](https://github.com/langchain-ai/open_deep_research/blob/1b7d2e80db9faa586165c60e09096dbbfd483a64/src/open_deep_research/deep_researcher.py)
  and [configuration](https://github.com/langchain-ai/open_deep_research/blob/1b7d2e80db9faa586165c60e09096dbbfd483a64/src/open_deep_research/configuration.py).
- dzhng [query generation and recursive research](https://github.com/dzhng/deep-research/blob/1f8f3e285bbc23e80b98a66a64effab9069f3ad4/src/deep-research.ts).
- Crawl4AI [best-first strategy](https://github.com/unclecode/crawl4ai/blob/862f6bccb9c063f49b9d42701baa0eea17a4993f/crawl4ai/deep_crawling/bff_strategy.py).

## Free collection and reading candidates

| Candidate | Evidence it can contribute | Boundary |
| --- | --- | --- |
| [youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api) | Manual/generated captions with timing and language metadata, without a source API key. | Maintainer documents IP blocking and dependence on undocumented interfaces. Paid proxy suggestions do not satisfy this project. Timestamps do not establish speaker identity. |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp#subtitle-options) | Publicly accessible video metadata and subtitles across supported extractors. | Listed extractor support does not establish anonymous access or transcript availability; [FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ) describes access/session constraints. |
| [Docling](https://github.com/docling-project/docling) | Local conversion of PDFs, scanned documents, presentations and other formats into structured material. | A reader after acquisition, not a search service; local models/runtime must be packaged and their licenses checked. |
| [Bluesky author feeds](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/getAuthorFeed.json) | Structured public posts from an identified account. | [Official documentation](https://docs.bsky.app/docs/api/app-bsky-feed-get-author-feed) supports public AppView reads without authentication. This applies to verified endpoints, not every operation. |
| [Mastodon account statuses](https://github.com/mastodon/mastodon/blob/main/app/controllers/api/v1/accounts/statuses_controller.rb) | Public posts from discovered accounts across instances. | [Account documentation](https://docs.joinmastodon.org/methods/accounts/) permits public reads subject to server configuration; [search](https://docs.joinmastodon.org/methods/search/) is not universal anonymous full-text discovery. |
| [Instaloader](https://github.com/instaloader/instaloader) | Instagram captions/media/metadata when anonymously accessible. | [CLI documentation](https://github.com/instaloader/instaloader/blob/master/docs/cli-options.rst) includes login/session requirements. Anonymous paths are conditional, not guaranteed social coverage. |

## Existing application evidence

- [Search](../../apps/server/src/source-adapters/search.ts) already fans out concurrently, merges by
  registration order and retains at most 24 results per query. Adding providers alone can leave
  useful results outside that cap.
- [Person research](../../apps/server/src/person-profile/research.ts) reads ordinary HTML/plain text;
  unsupported formats fall back to snippets. It does not automatically acquire every capability
  implemented by other product areas.
- [YouTube collection](../../apps/server/src/source-adapters/youtube.ts) already contains public
  transcript, yt-dlp and local Whisper fallbacks. The [Dockerfile](../../Dockerfile) packages those
  runtimes and Instaloader. Prefer adapting existing readers and retaining citation detail over
  creating a second unrelated collector stack.
- [Marginalia](../../apps/server/src/source-adapters/providers/marginalia.ts) currently sends a shared
  `api-key: public` header despite being described as keyless. Audit existing routes against the
  user's literal no-API-key constraint; do not assume the label proves compliance.

## Strategy accepted after the initial comparison

Update after the operating-model discussion: broad discovery and adaptive batches are accepted,
but the user rejected dividing enrichment into resumable budget-limited passes. The description
below records the earlier recommendation; ADR-0063 now requires one continuous operation with
progressive publication. Completion criteria and persistent-failure diagnostics were subsequently
accepted and are recorded in ADR-0063 and below.

Use broad parallel identity and evidence discovery, then repeated LLM-planned batches against the
entire supported source collection. Maintain discovered URLs and unanswered research questions in
a persistent queue, choose promising independent evidence while reserving breadth for unexplored
source families, and follow links with explicit provenance. The user's industry never determines
eligibility. Initial person hypotheses may guide ordering but cannot establish identity or exclude
unanticipated work.

This combines patterns above; it is an inference, not a claim that one project implements the full
desired system. Keep per-host pacing, finite attempted-request/model/time budgets, checkpoints and
lifecycle cancellation. Preserve pending work on budget exhaustion and distinguish it from no
evidence found. Compare the new strategy with the existing fan-out under recorded comparable
allowances on the same reference version and judge configuration.

Evaluation should trace each expected fact through discovery, result selection, retrieval, reading,
identity attribution, extraction and dossier representation. An inaccessible source, unattempted
lead, unread document and incorrectly interpreted passage are different improvement targets.
Source count is diagnostic; added supported reference coverage is the outcome.

## Expanded discovery through Context Awesome and Firecrawl

The user supplied eight starting repositories. Context Awesome was used to discover search-engine
sections and retrieve curated items; Firecrawl Search and Scrape were used to investigate the
catalogues and find primary documentation. The shared Firecrawl request-per-minute allowance was
reached, so verification continued through direct GitHub, official web documentation, and a few
anonymous HTTP probes. No paid upgrade, login or source key was added. Availability of the MCP in
this research session is not a production service contract for the application.

| Starting repository | What it contributes | What must not be inferred |
| --- | --- | --- |
| [public-apis/public-apis](https://github.com/public-apis/public-apis) | Leads to public institutional, publishing, cultural and professional datasets. | Its authentication column can be stale or classify writes and reads together; verify the exact endpoint. |
| [frutik/awesome-search](https://github.com/frutik/awesome-search) | Search/retrieval and evaluation concepts. | A catalogue of search engineering is not a set of ready-to-use public data providers. |
| [prirai/awesome-search-engines](https://github.com/prirai/awesome-search-engines) | Additional engines and information about index dependencies. | Different frontends do not necessarily add independent indexes or corroborating evidence. |
| [brandonhimpfen/awesome-linkedin](https://github.com/brandonhimpfen/awesome-linkedin) | Public-profile discovery ideas and a catalogue of tools. | Unofficial clients can still require account login; [linkedin-private-api](https://github.com/eilonmore/linkedin-private-api) does. No universal anonymous LinkedIn API was established. |
| [edoardottt/awesome-hacker-search-engines](https://github.com/edoardottt/awesome-hacker-search-engines) | General search, archives and public-document leads. | Infrastructure/vulnerability/leaked-data search is not relevant professional-person evidence. Catalogue inclusion does not prove free anonymous access. |
| [dotnetpower/infomesh](https://github.com/dotnetpower/infomesh) | Self-hosted local/P2P index, crawler and RSS monitoring. | [Query code](https://github.com/dotnetpower/infomesh/blob/main/infomesh/search/query.py) depends on local content and available peers; it is not an already comprehensive web index. Contribution credits and crawl limits also qualify unlimited-use claims. |
| [steel-dev/awesome-web-agents](https://github.com/steel-dev/awesome-web-agents) | Local browser/rendering and research-agent implementation candidates. | Hosted services, keyed search providers and logged-in browser sessions do not meet the source constraint. |
| [qiran87/web-search-free](https://github.com/qiran87/web-search-free) | Small direct-fetch/parser/browser fallback implementation with attempt logging. | [Search code](https://github.com/qiran87/web-search-free/blob/main/scripts/runtime/src/free_web_research/search.py) chooses configured SearXNG or DDGS; it does not query both concurrently. [Fetch code](https://github.com/qiran87/web-search-free/blob/main/scripts/runtime/src/free_web_research/fetch.py) has optional Jina key support and paid escalation suggestions; those paths are not part of a compliant baseline. |

### Additional discovery and retrieval routes

These are candidates for production integration, not a claim that adapters have been implemented
or that any provider supplies complete person profiles. Some deepen existing integrations.

| Source or route | Additional evidence | Anonymous-access evidence and limitation |
| --- | --- | --- |
| [MWMBL](https://github.com/mwmbl/mwmbl) | Another general search index. | [Search code](https://github.com/mwmbl/mwmbl/blob/main/mwmbl/tinysearchengine/search.py) explicitly accepts anonymous v2 queries; live query returned results. It has a smaller index and optional keyed features which are unnecessary for this route. |
| [Apple iTunes Search](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html) | Podcast/show discovery across professions, languages and regions. | Public query returned podcast results without credentials. Catalogue results lead to feeds; they do not supply every episode transcript or guest appearance. |
| [Podcast RSS transcript links](https://podcasting2.org/docs/podcast-namespace/tags/transcript) | Publisher-supplied transcript text, language and caption timing. | Follow public `podcast:transcript` URLs in feeds. Presence and anonymous availability vary by publisher; the namespace itself does not require a Podcast Index API account. |
| [PeerTube](https://github.com/Chocobozzz/PeerTube/blob/develop/support/doc/api/openapi.yaml) | Public videos, appearances and available captions outside YouTube. | Public search/read operations are distinct from OAuth write operations. Coverage is instance-dependent; endpoint documentation inspected, no live video/caption canary run here. |
| [Common Crawl](https://commoncrawl.org/get-started) | Older captured pages and URL discovery under known domains. | Official HTTPS downloads need no AWS account; index listing returned JSON. The CDX index searches URLs, not arbitrary person-name full text across the entire web; captured material remains dated historical evidence. |
| [Internet Archive metadata/files](https://archive.org/developers/index-apis.html) | Publicly accessible archived recordings, documents and item metadata. | Deepen the existing archive discovery route into eligible public files. Restricted or borrowing-only items cannot be treated as anonymously readable. |
| [OpenAlex anonymous basic queries](https://help.openalex.org/api/authentication/) | Work and affiliation discovery across research fields. | Current documentation permits a small anonymous allocation, and a basic query succeeded. This corrects overbroad exclusion based on older key-requirement announcements; keyed higher quotas remain excluded. |
| [Bluesky](https://docs.bsky.app/docs/api/app-bsky-feed-get-author-feed) | Public authored posts and work announcements. | Read verified public AppView endpoints after matching the account. Publicly attributed statements remain self-report. |
| [Mastodon](https://docs.joinmastodon.org/methods/accounts/) | Public professional commentary and linked work. | Target discovered accounts; instance settings and restricted unauthenticated search limit coverage. |

The local reader stack can serve many sources that do not have a dedicated API: public employer
and association pages, event programmes, institutional directories, newsletters, linked PDFs,
slides and publicly available interviews. Direct fetching followed by local parsing/OCR, and
bounded anonymous browser rendering when required, broadens the material the app can use. This
is a proposed implementation path, not a verified claim about every publisher.

### Specialist sources across industries

| Source | Evidence and use | Eligibility and verification |
| --- | --- | --- |
| [Crossref](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) | Credited authors, books, papers, reports, DOI links, funding and corrections. | Public metadata needs no signup; anonymous JSON response verified. Full-text links are leads, not a promise of open full text. |
| [DataCite](https://support.datacite.org/docs/rest-api) | Deposited reports, presentations, datasets, creators and affiliations. | Public read API needs no authentication; anonymous JSON verified. Only publicly Findable records belong in the route. |
| [Europe PMC](https://europepmc.org/RestfulWebService) | Healthcare, agriculture and life-science work, references and available full-text XML. | Anonymous JSON verified; deepen existing search into available full text, preserving access/rights limits. |
| [Wikidata](https://www.wikidata.org/wiki/Wikidata:Data_access) | Multilingual identity anchors, external identifiers and referenced affiliations or awards. | Anonymous JSON verified; retain qualifiers and references. A catalogue's OAuth label does not describe anonymous reads. |
| [SEC EDGAR](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) | Dated appointments, business roles and organizational context from filings. | Official API needs no key/authentication. Deepen the existing provider into relevant filings; company scale does not establish personal contribution. |
| [NPPES](https://npiregistry.cms.hhs.gov/api-page) | US healthcare-provider identity, taxonomy and identifiers. | One anonymous query returned a provider result; no personal record copied into these notes. NPI assignment does not establish licensure or quality. |
| [ClinicalTrials.gov](https://clinicaltrials.gov/data-api/how-download-study-records) | Investigators, study participation, sponsors and dates. | Anonymous study JSON verified. Distinguish named investigator, contact and sponsor rather than inferring equivalent roles. |
| [ProPublica Nonprofit Explorer](https://projects.propublica.org/nonprofits/api/) | Nonprofit organization discovery leading to available Form 990 filings with named roles. | Anonymous JSON verified. Person claims require the actual filing; API/data terms and changing endpoints need tracking. |
| [TVMaze](https://www.tvmaze.com/api) | Person search, cast/crew and guest credits. | Anonymous JSON verified; free public API is distinct from paid user API. Preserve attribution and applicable CC BY-SA obligations. |
| [Library of Congress](https://www.loc.gov/apis/json-and-yaml/working-within-limits/) | Authors, oral histories, exhibitions, cultural records and appearances. | Official JSON API needs no key/authentication; no live content probe here. Preserve dates and item-specific access boundaries. |
| [Art Institute of Chicago](https://api.artic.edu/docs/) | Artists, artworks, exhibitions and catalogue evidence. | Documentation allows anonymous access with rate limits; no live probe here. Metadata access and image rights are distinct. |
| [ROR](https://ror.org/api-client-id) | Institutional identity matching and affiliation disambiguation. | Keyless route exists with optional client identification; current quota/registration policy needs tracking. Already integrated; organization matching does not establish a person's role. |

Anonymous JSON probes in this table were performed by the delegated catalogue research during this
same session. They establish one accessible response, not correctness of extracted claims, a
production canary, or comprehensive geographic coverage.

Do not count [MusicBrainz's hosted API](https://musicbrainz.org/doc/MusicBrainz_API) as universally
free for this app: its free-use statement is noncommercial. Its
[open core dataset](https://musicbrainz.org/doc/About/Data_License) is a different local-index
possibility. [Open Library](https://openlibrary.org/developers/api) permits bounded anonymous use,
but its guidance rejects high-traffic third-party backend use and HTML scraping; a cached,
low-volume route or appropriately operated data-dump index requires a separate fit check.
Keyed offerings such as OpenCorporates and Trove are not admitted by an awesome-list endorsement.

[OpenAlex's current budget documentation](https://help.openalex.org/access/example-costs/) permits
a small keyless daily allocation. A probe by the catalogue researcher confirmed anonymous quota
headers. Free quota expressed in dollar-denominated accounting is not a payment requirement;
the application must stop at that free allowance and never escalate to a key or paid tier.

[Steel browser](https://github.com/steel-dev/steel-browser) offers a self-hosted browser service;
the existing [Playwright renderer](../../apps/server/src/source-adapters/browser.ts) is already a
local option. [Atlas](https://github.com/steel-dev/atlas) contributes replay/citation/orchestration
ideas, but its default keyed search and cloud-browser paths fail the source constraint.
[LinkedIn's visibility documentation](https://www.linkedin.com/help/recruiter/answer/a545600)
allows a member-controlled public profile version, not guaranteed anonymous access to every
section. Read what is public and record missing or login-required material; do not silently import
sessions. Infomesh stays experimental until it demonstrates useful additional coverage.

### Direct probes from this host

Recorded 2026-09-06; requests sent no cookies, Authorization header, API key or account login.
The queries were generic topics. Only response structure/counts were inspected, not a curated
person dossier. These observations establish one successful anonymous response, not sustained
availability, content quality, or a finished integration.

| Route and input | Observation | Seconds |
| --- | --- | --- |
| `https://mwmbl.org/api/v2/search/?q=restaurant` | HTTP 200, JSON results array with 119 entries | 0.53 |
| `https://itunes.apple.com/search?term=agriculture&media=podcast&limit=2` | HTTP 200, two podcast results | 0.26 |
| `https://index.commoncrawl.org/collinfo.json` | HTTP 200, 127 crawl-index entries; no archive page was retrieved | 0.12 |
| `https://api.openalex.org/works?search=agriculture&per-page=1` | HTTP 200, one work result | 0.40 |

### Consequences for the evaluator

Measure unique useful evidence, source-family independence and supported reference coverage,
not the number of registered providers. Log discovery, selection, acquisition, reading,
attribution and synthesis separately. A provider's refusal is not evidence that the person has
no public footprint. Distinguish anonymous success, empty search, access refusal, parser failure,
unattempted work and budget exhaustion. Keep higher quotas, optional keys, paid proxies and
authenticated sessions out of the production acquisition path.

## Agreed scope of the first implementation

Deliver the complete 30-person evaluator, adaptive production search, production sourcing
expansion across the researched families, and a measured before/after report. Supported routes
must demonstrate real retrieval; blocked or unsupported cases stay visible. Require improved
reference coverage without newly introduced critical identity or source-integrity failures, while
retaining unresolved reference misses as specific follow-up work rather than weakening the
reference dossiers. This records agreed scope, not completed implementation or passed acceptance.

## Failure diagnostics required by the design

The existing Person Research Job stores at most 100 `{url, stage, reason}` diagnostic entries;
the reader often reduces errors to `failed; snippet content`. This does not satisfy the agreed
debugging requirement. The model boundary already exposes classified structured diagnostics in
`apps/server/src/llm/failure.ts`; preserve those rather than reducing them to error prose.

Each failed attempt should retain:

- Correlation with the research operation, source/query or document, exact attempt and profile
  revision; collector/parser versions and relevant nonsecret configuration.
- The failed stage: discovery, selection, transport, access, rendering, parsing/OCR,
  caption/media acquisition, transcription, identity attribution, extraction, validation or
  publication.
- A stable reason code with observed evidence: HTTP/upstream status, final URL where safe,
  content type and size, timing/timeout phase, response or retained-document hash, provider
  error code, parser error location, subprocess exit status or existing model-boundary detail
  as applicable. Unavailable observations remain unavailable.
- Failure modes distinguishing DNS/TLS/connectivity, timeout, rate limit/quota, login requirement,
  challenge page, unavailable/deleted resource, unsupported format, JavaScript-only content,
  missing captions, media failure, unavailable local runtime/model, ambiguous or wrong-person
  attribution, invalid model result shape, unsupported citation and stale publication.
- Every retry and alternative method attempted, timestamps and delays, outcomes, and the exact
  reason further recovery stopped. A 403 alone must not be labeled rate limiting or login-required.
- References to retained permitted source material and bounded sanitized diagnostic artifacts
  sufficient to investigate; never credentials, imported sessions, hidden model reasoning or
  private evidence leaked into public diagnostics.
- A specific developer explanation and remediation candidate linked to the observed failure,
  with uncertain hypotheses labeled as hypotheses. Preserve attempt history beyond any compact
  UI summary so a later error or a 100-item display cap cannot erase the original cause.

These records support filtering failures across the benchmark by source, method, stage, reason and
collector version. The same diagnostics must originate in production research, rather than an
evaluation-only copy that cannot explain actual failures. Finishing with inaccessible-source gaps
is distinct from model/operation interruption and from successfully finding no matching evidence.
