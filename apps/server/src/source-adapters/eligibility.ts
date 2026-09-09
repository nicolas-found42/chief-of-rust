import { createHttpFetch, publicHttpFetch, type PublicHttpFetch } from "./http.js";

/**
 * What every research source route costs to use, and how that was established.
 *
 * Issue #228 forbids data acquisition that needs an API key, a payment, a
 * source sign-in, an imported session or a paid proxy — including free tiers
 * that require a key. A catalogue entry saying "free" does not establish any
 * of that, so each route here carries two independent things: the access terms
 * read from the source's own current documentation, and a probe that a
 * developer can run to see what the route actually answers today.
 *
 * A route that fails its probe stays in this table as an explicit gap. Deleting
 * it would turn "we cannot read this" into "there was nothing to read", which
 * is the confusion the whole benchmark exists to remove.
 */
/**
 * What acquiring data from a route costs.
 *
 * Anything but `anonymous` is excluded from production by #228, free key tiers
 * included. This is deliberately a closed set rather than prose: the check that
 * walks the collection has to be able to fail, and a sentence saying "free"
 * cannot fail.
 */
export type SourceAccessCost =
  "anonymous" | "api-key" | "payment" | "sign-in" | "imported-session" | "paid-proxy";

export interface SourceEligibility {
  /** The route's name, matching the search provider or reader that uses it. */
  route: string;
  family: string;
  /** What the source's own documentation says anonymous access requires. */
  terms: string;
  /** Where that was read. */
  documentation: string;
  /** What that documentation costs the operator, as a value a check can test. */
  cost: SourceAccessCost;
  /** Whether the route is used in production today, and why not when it is not. */
  status: "in-production" | "excluded" | "unavailable";
  /** Why an excluded or unavailable route is not used. */
  exclusion?: string;
  /**
   * What a request to this route was actually seen to do, when no probe runs
   * for it. Documentation and observation are separate fields on purpose: a
   * catalogue label saying "free, no key" is a claim about the source, and
   * only a probe or a recorded live observation is evidence about the route.
   */
  observed?: string;
  /**
   * Upstream indexes this route covers, when a reader can escalate a page
   * straight to them rather than reaching them through a search provider.
   */
  indexes?: string[];
  /** A probe URL that needs no key and returns a small anonymous response. */
  probe?: string;
  /**
   * Some routes serve JSON only to an explicit accept header and answer 406 or
   * 500 to the shared transport's HTML-first list. The probe has to ask the
   * same way production does or it measures the wrong thing.
   */
  probeAccept?: "json";
  /** What a healthy probe answer looks like, beyond a 200. */
  expect?: (body: string) => boolean;
}

/** The transport the JSON-only routes are actually reached with. */
const jsonFetch = createHttpFetch({ headers: { accept: "application/json" } });

/**
 * The observation standing behind an incumbent route that this command does
 * not probe. The bundle was live-verified when it was built; saying so is not
 * the same as saying it was rechecked today, and the two must not blur.
 */
const LIVE =
  "Live-verified during the ADR-0049 provider research (docs/research/public-search-providers.md); not re-probed by this command.";

const json = (body: string) => {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
};

/**
 * The incumbent provider bundle (ADR-0049) and the expansion families #228
 * added, in one table.
 *
 * The bundle predates this record and was audited into it rather than assumed
 * eligible: #228 requires existing routes to be checked, not only additions.
 * Entries without a `probe` carry the observation that stands in for one, so
 * that no route is marked eligible on its own catalogue label.
 */
export const SOURCE_ELIGIBILITY: SourceEligibility[] = [
  {
    route: "searxng",
    family: "general-discovery",
    terms:
      "A self-hosted SearXNG instance the operator runs; the configured base URL is infrastructure, not a source credential.",
    documentation: "https://docs.searxng.org/admin/settings/settings_search.html",
    cost: "anonymous",
    status: "in-production",
    observed:
      "Optional: absent SEARXNG_URL the provider is never registered. The instance must enable the json format or it answers 403, which the provider classifies as an error rather than a wall.",
  },
  {
    route: "duckduckgo",
    family: "general-discovery",
    terms: "The anonymous HTML endpoint; no key, no account, no cookie import.",
    documentation: "https://html.duckduckgo.com/html/",
    cost: "anonymous",
    status: "in-production",
    observed:
      "A documented single-user scrape exception (docs/research/anti-bot-keyless-search.md). The 202 challenge is classified as a captcha refusal and rested for a day; no UA rotation and no retry.",
  },
  {
    route: "mojeek",
    family: "general-discovery",
    terms: "An independent index answered by a plain keyless GET; no tokens.",
    documentation: "https://www.mojeek.com/search",
    cost: "anonymous",
    status: "in-production",
    observed:
      "Live 2026-09-02: the anti-bot gate is volume-based rather than UA-fingerprinted; a challenge page becomes a captcha cooldown.",
  },
  {
    route: "marginalia",
    family: "general-discovery",
    terms:
      "The documented anonymous path sends the literal shared header `API-Key: public`. That constant is published as the keyless route; it is not issued to an operator, and no account, payment or sign-in obtains it.",
    documentation: "https://about.marginalia-search.com/article/api/",
    cost: "anonymous",
    status: "in-production",
    observed:
      "The shared constant is contended across every caller, so an HTTP 503 'QPM Limit Exceeded' is normal operation and refuses as rate-limited. No keyed tier is requested when it does.",
  },
  {
    route: "wiby",
    family: "general-discovery",
    terms: "wiby.me/json/ answers a plain keyless GET.",
    documentation: "https://wiby.me/",
    cost: "anonymous",
    status: "in-production",
    observed: LIVE,
  },
  {
    route: "wikipedia",
    family: "identity-affiliation",
    terms: "The MediaWiki opensearch API is public and unauthenticated.",
    documentation: "https://www.mediawiki.org/wiki/API:Opensearch",
    cost: "anonymous",
    status: "in-production",
    observed: LIVE,
  },
  {
    route: "wikidata",
    family: "identity-affiliation",
    terms: "The Wikidata action API's entity search is public and unauthenticated.",
    documentation: "https://www.wikidata.org/w/api.php",
    cost: "anonymous",
    indexes: ["wikidata.org"],
    status: "in-production",
    observed: LIVE,
  },
  {
    route: "bing-news",
    family: "general-discovery",
    terms:
      "The undocumented `format=RSS` route on Bing News; no key. The feed carries a personal, non-commercial rendering restriction, which the research record flags rather than hides.",
    documentation: "https://www.bing.com/news/search",
    cost: "anonymous",
    status: "in-production",
    observed: LIVE,
  },
  {
    route: "google-news",
    family: "general-discovery",
    terms:
      "The undocumented Atom route on news.google.com; no key. The same personal, non-commercial rendering restriction applies.",
    documentation: "https://news.google.com/rss",
    cost: "anonymous",
    status: "in-production",
    observed: LIVE,
  },
  {
    route: "gdelt",
    family: "general-discovery",
    terms: "GDELT DOC 2.0 artlist is public and unauthenticated.",
    documentation: "https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/",
    cost: "anonymous",
    status: "in-production",
    observed:
      "Probes answered in 15-75 s, so the provider overrides the composite deadline; the observed pace is about one request per five seconds and is honoured by refusing fast.",
  },
  {
    route: "stackexchange",
    family: "general-discovery",
    terms: "Keyless full-text search, throttled to 300 requests/day/IP anonymously.",
    documentation: "https://api.stackexchange.com/docs",
    cost: "anonymous",
    status: "in-production",
    observed:
      "The throttle answers either HTTP 429 or a 200 body carrying a `backoff` value; both refuse as rate-limited. Quota exhaustion is explicit and no keyed tier is requested.",
  },
  {
    route: "arctic-shift",
    family: "public-social",
    terms: "A keyless public Reddit archive API.",
    documentation: "https://arctic-shift.photon-reddit.com/api",
    cost: "anonymous",
    status: "in-production",
    observed:
      "Keyword search needs an r/ or u/ scope; an unscoped question is declined without a request rather than asked badly.",
  },
  {
    route: "reddit-rss",
    family: "public-social",
    terms: "Reddit's public search RSS; no key and no login.",
    documentation: "https://www.reddit.com/search.rss",
    cost: "anonymous",
    status: "in-production",
    observed:
      "About 2-3 requests/minute per IP; the wall answers 403 as often as 429 and both carry Retry-After. No session is imported when it does.",
  },
  {
    route: "openverse",
    family: "documents-publisher",
    terms: "Keyless CC-media search; anonymous access is bounded at roughly 200 requests/day.",
    documentation: "https://api.openverse.org/v1/",
    cost: "anonymous",
    status: "in-production",
    observed: "A 429 refuses as rate-limited; the keyed tier is never requested as a fallback.",
  },
  {
    route: "europepmc",
    family: "published-work",
    terms: "The Europe PMC REST search is public and needs no key.",
    documentation: "https://europepmc.org/RestfulWebService",
    cost: "anonymous",
    status: "in-production",
    observed: LIVE,
  },
  {
    route: "openalex",
    family: "published-work",
    /* Re-read 2026-09-07 for #249: the documented model changed under this
       entry. The polite pool is gone, the old docs host redirects, and access
       is now budgeted — basic use stays keyless, while the free key needs an
       account and a bigger budget is paid. Both of those are excluded, so the
       route stays eligible only for as long as the keyless tier answers. */
    terms:
      "Basic API use is free with no key and no account; a free API key raises the daily budget tenfold and heavier use is pay-as-you-go. The data are CC0.",
    documentation: "https://help.openalex.org/api/authentication/",
    cost: "anonymous",
    indexes: ["openalex.org"],
    status: "in-production",
    observed:
      "An anonymous work request on 2026-09-07 answered HTTP 200 and reported the keyless daily budget in its own headers (x-ratelimit-limit 1000, x-ratelimit-limit-usd 0.1), shared per IP. A 429 is budget exhaustion, and no key is sent to lift it.",
  },
  {
    route: "orcid",
    family: "published-work",
    terms: "pub.orcid.org serves the public record without a token.",
    documentation: "https://info.orcid.org/documentation/api-tutorials/",
    cost: "anonymous",
    indexes: ["orcid.org"],
    status: "in-production",
    observed:
      "Served only to an explicit JSON accept header; the curated transport asks the way the documentation does.",
  },
  {
    /* Reading one iD's record is a different endpoint from expanded-search,
       and it is what a discovered ORCID URL actually reaches, so it carries
       its own terms and its own probe rather than inheriting the search
       route's (#252, mirroring crossref-record's split from crossref #249). */
    route: "orcid-record",
    family: "identity-affiliation",
    terms:
      "The same keyless public record endpoint, addressed by ORCID iD. Establishes that the iD belongs to the named person; a linked work or employment is the record's own claim, not independently verified attribution.",
    documentation: "https://info.orcid.org/documentation/api-tutorials/",
    cost: "anonymous",
    indexes: ["orcid.org"],
    status: "in-production",
    probe: "https://pub.orcid.org/v3.0/0000-0002-1825-0097/record",
    probeAccept: "json",
    expect: json,
  },
  {
    route: "dblp",
    family: "published-work",
    terms: "The dblp publication search API is public and keyless.",
    documentation: "https://dblp.org/faq/How+to+use+the+dblp+search+API.html",
    cost: "anonymous",
    status: "in-production",
    observed: LIVE,
  },
  {
    route: "github-users",
    family: "professional-records",
    terms:
      "The GitHub user search API answers unauthenticated requests at a lower rate limit; no token is sent.",
    documentation: "https://docs.github.com/en/rest/search/search",
    cost: "anonymous",
    status: "in-production",
    observed:
      "Anonymous requests are limited to about 10 searches/minute per IP. Exhaustion is an explicit rate-limit refusal, not a prompt for a token.",
  },
  {
    route: "ror",
    family: "identity-affiliation",
    terms: "The Research Organization Registry API is public and keyless.",
    documentation: "https://ror.readme.io/docs/rest-api",
    cost: "anonymous",
    indexes: ["ror.org"],
    status: "in-production",
    observed: LIVE,
  },
  {
    route: "gleif",
    family: "identity-affiliation",
    terms: "The GLEIF LEI record API is public and keyless.",
    documentation: "https://www.gleif.org/en/lei-data/gleif-api",
    cost: "anonymous",
    status: "in-production",
    observed: LIVE,
  },
  {
    route: "edgar",
    family: "professional-records",
    terms:
      "SEC full-text search is public and keyless; the SEC requires a declared contact in the User-Agent, which identifies the caller rather than authenticating it.",
    documentation: "https://www.sec.gov/os/webmaster-faq#developers",
    cost: "anonymous",
    status: "in-production",
    observed:
      "The curated transport sends the declared-contact UA. That string is not a credential and grants no access another caller cannot obtain by declaring its own.",
  },
  {
    route: "internet-archive",
    family: "historical-evidence",
    terms: "archive.org's advancedsearch.php is public and keyless.",
    documentation: "https://archive.org/advancedsearch.php",
    cost: "anonymous",
    status: "in-production",
    observed: LIVE,
  },
  {
    route: "ia-tvnews",
    family: "spoken-evidence",
    terms: "The same keyless advancedsearch.php endpoint, scoped to the tvarchive collection.",
    documentation: "https://archive.org/details/tv",
    cost: "anonymous",
    status: "in-production",
    observed:
      "About one request per second on caption files; the pace is honoured by refusing fast rather than by any paid escalation.",
  },
  {
    route: "wayback",
    family: "historical-evidence",
    terms: "The Wayback availability API is public and keyless.",
    documentation: "https://archive.org/help/wayback_api.php",
    cost: "anonymous",
    status: "in-production",
    observed:
      "Probes took 25-75 s, so the provider overrides the composite deadline rather than timing out on a healthy answer.",
  },
  {
    route: "wayback-capture",
    family: "historical-evidence",
    terms:
      "Retrieving a capture's own bytes from web.archive.org is public and keyless, the same as browsing the Wayback Machine; the `id_` modifier the reader uses is the documented way to ask for the capture without the archive's navigation wrapper.",
    documentation: "https://help.archive.org/help/using-the-wayback-machine/",
    cost: "anonymous",
    status: "in-production",
    probe: "https://web.archive.org/web/20200101000000id_/https://example.com/",
    expect: (body) => body.includes("Example Domain"),
    observed:
      "Live 2026-09-07: a lookup timestamp answered 302 to the closest capture and then 200 with the publisher's own 1,256-byte document, so the answered address is what dates the evidence. The same request against a URL the archive does not hold answered 404, and a dated capture of a real past-people biography returned 79,935 bytes carrying the retained reference quote.",
  },
  {
    route: "document-reader-ocr",
    family: "documents-publishers",
    terms:
      "A local system toolchain (pdftoppm and tesseract) reads the retrieved PDF bytes locally; no account, key, payment, or network call is involved.",
    documentation: "https://tesseract-ocr.github.io/tessdoc/",
    cost: "anonymous",
    status: "in-production",
    observed:
      "No binary is installed in CI or added by this change: detectSystemTesseract resolves null there and scanned PDFs take the unsupported-format gap path, which the new tests pin. Where the binary exists it is used only when detected at runtime.",
  },
  {
    route: "mwmbl",
    family: "general-discovery",
    terms: "Open, non-commercial web index; public API needs no account or key.",
    documentation: "https://api.mwmbl.org/",
    cost: "anonymous",
    status: "in-production",
    probe: "https://api.mwmbl.org/api/v1/search/?s=climate",
    expect: json,
  },
  {
    route: "peertube",
    family: "spoken-evidence",
    terms: "Sepia Search indexes public PeerTube instances; the REST API is unauthenticated.",
    documentation: "https://docs.joinpeertube.org/api-rest-reference.html",
    cost: "anonymous",
    status: "in-production",
    probe: "https://sepiasearch.org/api/v1/search/videos?search=climate&count=2",
    expect: json,
  },
  {
    route: "podcast-directory",
    family: "spoken-evidence",
    terms: "Apple's public search endpoint; no key, rate limited by IP.",
    documentation: "https://performance-partners.apple.com/search-api",
    cost: "anonymous",
    status: "in-production",
    probe: "https://itunes.apple.com/search?media=podcast&term=agriculture&limit=2",
    expect: json,
  },
  {
    route: "youtube-captions",
    family: "spoken-evidence",
    terms:
      "The watch page lists caption tracks anonymously, but the timed-text endpoint now answers an empty body without a proof-of-origin token.",
    documentation: "https://www.youtube.com/watch",
    cost: "anonymous",
    status: "unavailable",
    exclusion:
      "Observed 2026-09-06: every listed track returned HTTP 200 with a zero-byte body in every format (srv1, srv3, json3, vtt, ttml). Research falls back to the publisher's video description and records the gap. Local transcription would be the next route and is not installed on this host.",
  },
  {
    route: "podcastindex",
    family: "spoken-evidence",
    terms: "Requires an API key and a signed request.",
    documentation: "https://podcastindex-org.github.io/docs-api/",
    cost: "api-key",
    status: "excluded",
    exclusion: "A key is required, which #228 excludes even where the tier is free.",
  },
  {
    route: "bluesky",
    family: "public-social",
    terms: "public.api.bsky.app serves the app view for public data with no authentication.",
    documentation: "https://docs.bsky.app/docs/advanced-guides/atproto",
    cost: "anonymous",
    status: "in-production",
    probe: "https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors?q=climate&limit=2",
    expect: json,
  },
  {
    route: "mastodon",
    family: "public-social",
    terms:
      "Public account lookup and public statuses are readable without a token on instances that have not disabled anonymous reads.",
    documentation: "https://docs.joinmastodon.org/methods/accounts/",
    cost: "anonymous",
    status: "in-production",
    probe: "https://mastodon.social/api/v1/accounts/lookup?acct=Gargron",
    expect: json,
  },
  {
    route: "linkedin",
    family: "public-social",
    terms: "Anonymous requests are met with an authentication wall.",
    documentation: "https://www.linkedin.com/robots.txt",
    cost: "sign-in",
    status: "excluded",
    exclusion:
      "No keyless anonymous read exists. Research records a login-required failure for a LinkedIn URL rather than importing a session or using a paid proxy.",
  },
  {
    route: "crossref",
    family: "published-work",
    terms:
      "No sign-up is required, and almost none of the metadata is subject to copyright; abstracts inside it may be. A mailto contact joins the polite pool and is not a key.",
    documentation: "https://www.crossref.org/documentation/retrieve-metadata/rest-api/",
    cost: "anonymous",
    indexes: ["crossref.org"],
    status: "in-production",
    probe:
      "https://api.crossref.org/works?query.bibliographic=Doudna&rows=2&mailto=owner@found42.local",
    probeAccept: "json",
    expect: json,
  },
  {
    /* Reading one work by DOI is a different endpoint from searching, and it
       is what a discovered DOI actually reaches, so it carries its own terms
       and its own probe rather than inheriting the search route's (#249). */
    route: "crossref-record",
    family: "published-work",
    terms:
      "The same keyless REST API, addressed by DOI. The metadata permission does not extend to an abstract carried inside the record.",
    documentation: "https://www.crossref.org/documentation/retrieve-metadata/rest-api/",
    cost: "anonymous",
    indexes: ["crossref.org"],
    status: "in-production",
    probe: "https://api.crossref.org/works/10.1126%2Fscience.1225829",
    probeAccept: "json",
    expect: json,
  },
  {
    route: "datacite-record",
    family: "published-work",
    terms:
      "The Public API retrieves metadata without authentication; the Data File waiver covers DataCite's own rights in DOIs and deposited metadata, not the linked resources.",
    documentation: "https://support.datacite.org/docs/datacite-data-file-use-policy",
    cost: "anonymous",
    indexes: ["datacite.org"],
    status: "in-production",
    probe: "https://api.datacite.org/dois/10.5281%2Fzenodo.31780",
    probeAccept: "json",
    expect: json,
  },
  {
    route: "openalex-record",
    family: "published-work",
    terms:
      "Basic keyless use of the same API, addressed by work id; the abstract ships as an inverted index rather than as text.",
    documentation: "https://help.openalex.org/api/authentication/",
    cost: "anonymous",
    indexes: ["openalex.org"],
    status: "in-production",
    probe: "https://api.openalex.org/works/W2045435533",
    probeAccept: "json",
    expect: json,
  },
  {
    route: "datacite",
    family: "published-work",
    terms: "Public REST API over DOI metadata; no key for search.",
    documentation: "https://support.datacite.org/docs/api",
    cost: "anonymous",
    indexes: ["datacite.org"],
    status: "in-production",
    probe: "https://api.datacite.org/dois?query=Doudna&page%5Bsize%5D=2",
    probeAccept: "json",
    expect: json,
  },
  {
    route: "open-library",
    family: "published-work",
    terms: "Open API over the Internet Archive's book catalogue; no key.",
    documentation: "https://openlibrary.org/developers/api",
    cost: "anonymous",
    status: "in-production",
    probe: "https://openlibrary.org/search/authors.json?q=chimamanda",
    expect: json,
  },
  {
    route: "nppes",
    family: "professional-records",
    terms:
      "US federal provider registry; the API is public and needs no key. CMS's public-dissemination guidance (issue #250, read 2026-09-07) names this API and the NPI Files bulk download as the public routes to the same registry; an NPI record does not validate the licensure, credentials or clinical competence of the person or organization it names.",
    documentation: "https://npiregistry.cms.hhs.gov/api-page",
    cost: "anonymous",
    indexes: ["npiregistry.cms.hhs.gov"],
    status: "in-production",
    probe: "https://npiregistry.cms.hhs.gov/api/?version=2.1&last_name=Smith&state=CA&limit=2",
    expect: json,
    observed:
      "Reconfirmed 2026-09-07 (#250): the number= lookup this route reads a record by answers 200 with parseable JSON, individual and organizational alike. The documentation route above (api-page) itself serves only a client-side app shell (an Angular app-root with no server-rendered content) to an anonymous GET, which is the same finding the 2026-09-06 primary-document review recorded; this run reproduced it rather than assuming it still held.",
  },
  {
    route: "clinicaltrials",
    family: "professional-records",
    terms:
      "ClinicalTrials.gov API v2 is public and unauthenticated. The registry's site-wide terms (issue #250, read 2026-09-07) describe free public access; current served terms verification remains incomplete because the terms page itself is client-rendered (below).",
    documentation: "https://clinicaltrials.gov/data-api/api",
    cost: "anonymous",
    indexes: ["clinicaltrials.gov"],
    status: "in-production",
    probe: "https://clinicaltrials.gov/api/v2/studies?query.term=oncology&pageSize=2",
    expect: json,
    observed:
      "Reconfirmed 2026-09-07 (#250): the studies/{NCT ID} lookup this route reads a record by answers 200 with parseable JSON. Every clinicaltrials.gov informational page this run tried — /about-site/terms-conditions and /data-api/about-api included — served the identical 94,295-byte Angular application shell (156 characters of glossary boilerplate once scripts and styles are stripped) to a direct anonymous GET, reproducing the 2026-09-06 primary-document review's finding rather than assuming it still held. No non-JS route to the terms text was found.",
  },
  {
    route: "nonprofit-explorer",
    family: "professional-records",
    terms: "ProPublica's Nonprofit Explorer API is free and needs no key.",
    documentation: "https://projects.propublica.org/nonprofits/api",
    cost: "anonymous",
    status: "in-production",
    probe: "https://projects.propublica.org/nonprofits/api/v2/search.json?q=food+bank",
    expect: json,
  },
  {
    route: "tvmaze",
    family: "creative-records",
    terms: "Public API; commercial use of the free tier is rate limited, not keyed.",
    documentation: "https://www.tvmaze.com/api",
    cost: "anonymous",
    indexes: ["tvmaze.com"],
    status: "in-production",
    probe: "https://api.tvmaze.com/search/people?q=lena",
    expect: json,
    observed:
      'Live 2026-09-07 (#251): people search answered 200; an unknown person id answered 404 {"name": "Not Found", "status": 404}. API data is CC BY-SA 4.0 (attribution plus sharealike); portraits are hotlinkable per the docs but under no stated licence in the response. Rate limit at least 20 calls / 10 s per IP, 429 on excess.',
  },
  {
    route: "library-of-congress",
    family: "creative-records",
    terms: "loc.gov serves JSON for any search with `fo=json`; no key.",
    documentation: "https://www.loc.gov/apis/json-and-yaml/",
    cost: "anonymous",
    indexes: ["loc.gov"],
    status: "in-production",
    probe: "https://www.loc.gov/search/?q=Ansel+Adams&fo=json&c=2",
    expect: json,
    observed:
      "Live 2026-09-07 (#251): search ?fo=json answered 200 with catalogue entries carrying access_restricted, image_url and item-page links; a full-item fetch timed out once and was not retried, so item-level rights advisories stay unread. API docs confirm no key with rate limits; page metadata notes site text is U.S. Government Work.",
  },
  {
    route: "openlibrary-record",
    family: "creative-records",
    terms:
      "Open Library's public REST API serves catalogue metadata to anonymous callers with no key; identified callers (User-Agent plus contact) get triple the 1 req/s default, and bulk harvest is out. Bibliographic fields are retained under that API permission; publisher flap copy and cover art carried in a response are withheld / not retrieved.",
    documentation: "https://openlibrary.org/developers/api",
    cost: "anonymous",
    indexes: ["openlibrary.org"],
    status: "in-production",
    probe: "https://openlibrary.org/books/OL25428864M.json",
    probeAccept: "json",
    expect: json,
    observed:
      'Live 2026-09-07 (#251): the Americanah edition record answered 200 with bibliographic fields, an author-key reference, flap-copy description and a cover id; an unknown key answered 404 {"error": "notfound"}.',
  },
  {
    route: "europeana",
    family: "creative-records",
    terms: "Europeana's REST API requires a personal API key (wskey) on every call.",
    documentation: "https://pro.europeana.eu/pages/get-api",
    cost: "api-key",
    status: "excluded",
    exclusion:
      'Observed 2026-09-07 (#251): an anonymous search answered HTTP 401 {"success": false, "error": "Unauthorized"}. A key is required, which #228 excludes even where the tier is free. Not counted as expansion.',
  },
  {
    route: "artic",
    family: "creative-records",
    terms: "Art Institute of Chicago public API; no key for search.",
    documentation: "https://api.artic.edu/docs/",
    cost: "anonymous",
    indexes: ["artic.edu"],
    status: "in-production",
    probe: "https://api.artic.edu/api/v1/artworks/search?q=Hopper&limit=2",
    expect: json,
  },
  {
    route: "commoncrawl",
    family: "historical-evidence",
    terms: "The CDX index is public and unauthenticated.",
    documentation: "https://index.commoncrawl.org/",
    cost: "anonymous",
    status: "in-production",
    probe: "https://index.commoncrawl.org/collinfo.json",
    expect: json,
  },
  {
    route: "commoncrawl-capture",
    family: "historical-evidence",
    terms:
      "Common Crawl Terms of Use §2(l) prohibits collecting or harvesting personally identifiable information for use separately from the Crawled Content; Section 3 requires respecting third-party copyrights and provides no citation exception. A pipeline that retains source documents and extracts personal claims operates separately from the crawl and has no rights basis under these terms (ADR-0072).",
    documentation: "https://commoncrawl.org/terms-of-use",
    cost: "anonymous",
    status: "excluded",
    exclusion:
      "Excluded by ADR-0072: Terms of Use §2(l) forbids collecting personal information for use separately from the crawl. Research retains full documents and publishes structured personal-data claims, which collapses the distinction between retaining and building a separate store.",
  },
];

export interface EligibilityProbeResult {
  route: string;
  family: string;
  status: SourceEligibility["status"];
  probed: boolean;
  httpStatus: number | null;
  bytes: number | null;
  shapeOk: boolean | null;
  detail: string;
}

/**
 * Run every probe anonymously and report what each route actually answered.
 *
 * A probe is a smoke test of access, not evidence that the route produces
 * usable person evidence. The benchmark is what establishes the second, and
 * the two are reported separately on purpose.
 */
export async function probeSourceEligibility(
  fetch: PublicHttpFetch = publicHttpFetch,
): Promise<EligibilityProbeResult[]> {
  const results: EligibilityProbeResult[] = [];
  for (const entry of SOURCE_ELIGIBILITY) {
    if (!entry.probe) {
      results.push({
        route: entry.route,
        family: entry.family,
        status: entry.status,
        probed: false,
        httpStatus: null,
        bytes: null,
        shapeOk: null,
        detail: entry.exclusion ?? "No probe defined for this route.",
      });
      continue;
    }
    try {
      const transport =
        entry.probeAccept === "json" && fetch === publicHttpFetch ? jsonFetch : fetch;
      const response = await transport(entry.probe, { timeoutMs: 25_000 });
      const shapeOk = entry.expect ? entry.expect(response.body) : response.body.length > 0;
      results.push({
        route: entry.route,
        family: entry.family,
        status: entry.status,
        probed: true,
        httpStatus: response.status,
        bytes: response.body.length,
        shapeOk,
        detail:
          response.status === 200 && shapeOk
            ? "Answered anonymously with the expected shape."
            : `Answered ${String(response.status)}${shapeOk ? "" : " with an unexpected shape"}.`,
      });
    } catch (error) {
      results.push({
        route: entry.route,
        family: entry.family,
        status: entry.status,
        probed: true,
        httpStatus: null,
        bytes: null,
        shapeOk: false,
        detail: `Probe failed: ${error instanceof Error ? error.message : "unknown error"}.`,
      });
    }
  }
  return results;
}
