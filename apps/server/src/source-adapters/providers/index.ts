import type { PublicHttpFetch } from "../http.js";
import type { SearchProvider } from "./types.js";
import { createArcticShiftProvider } from "./arctic-shift.js";
import {
  createArticProvider,
  createClinicalTrialsProvider,
  createCrossrefProvider,
  createDataCiteProvider,
  createLibraryOfCongressProvider,
  createNonprofitExplorerProvider,
  createNppesProvider,
  createOpenLibraryProvider,
  createTvMazeProvider,
} from "./person-records.js";
import {
  createBlueskyProvider,
  createMwmblProvider,
  createPeerTubeProvider,
  createPodcastDirectoryProvider,
} from "./person-media.js";
import { createBingNewsProvider } from "./bing-news-rss.js";
import { createDblpProvider } from "./dblp.js";
import { createDuckDuckGoProvider } from "./duckduckgo.js";
import { createEdgarProvider } from "./edgar.js";
import { createEuropePmcProvider } from "./europepmc.js";
import { createGdeltProvider } from "./gdelt.js";
import { createGitHubUsersProvider } from "./github-users.js";
import { createGleifProvider } from "./gleif.js";
import { createGoogleNewsProvider } from "./google-news-rss.js";
import { createInternetArchiveProvider } from "./ia-advancedsearch.js";
import { createIaTvNewsProvider } from "./ia-tvnews.js";
import { createMarginaliaProvider } from "./marginalia.js";
import { createMojeekProvider } from "./mojeek.js";
import { createOpenAlexProvider } from "./openalex.js";
import { createOpenverseProvider } from "./openverse.js";
import { createOrcidProvider } from "./orcid.js";
import { createRedditRssProvider } from "./reddit-rss.js";
import { createRorProvider } from "./ror.js";
import { createSearxngProvider } from "./searxng.js";
import { createStackExchangeProvider } from "./stackexchange.js";
import { createWaybackProvider } from "./wayback.js";
import { createWibyProvider } from "./wiby.js";
import { createWikidataProvider } from "./wikidata.js";
import { createWikipediaProvider } from "./wikipedia.js";

/**
 * The bundle registration order is pinned (ADR-0049): it is the merge order of
 * the composite, so it doubles as the editorial ranking — general web first,
 * news, community, then the identity and archive layers. Changing it changes
 * which provider's duplicate survives dedupe, so it is not cosmetic.
 */
export function defaultProviders(
  options: {
    fetch?: PublicHttpFetch;
    searxngUrl?: string;
    endpoint?: (query: string) => string;
  } = {},
): SearchProvider[] {
  /* Hermetic injection: when a fetch is injected, every factory that accepts
     one gets it so tests never touch the network. When none is injected the
     override is absent and curated transports (SEC EDGAR's declared-contact
     UA, ORCID's accept header, Marginalia's api-key, SearXNG's unguarded
     fetch) engage; the zero-parameter factories ride io.fetch either way. */
  const injected = options.fetch ? { fetch: options.fetch } : {};
  const providers: SearchProvider[] = [];
  if (options.searxngUrl) {
    providers.push(createSearxngProvider({ baseUrl: options.searxngUrl, ...injected }));
  }
  providers.push(
    createDuckDuckGoProvider({
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...injected,
    }),
    createMojeekProvider(),
    createMarginaliaProvider(injected),
    createWikipediaProvider(injected),
    createWikidataProvider(injected),
    createBingNewsProvider(),
    createGoogleNewsProvider(),
    createGdeltProvider(),
    createStackExchangeProvider(injected),
    createArcticShiftProvider(injected),
    createRedditRssProvider(injected),
    createOpenverseProvider(injected),
    createEuropePmcProvider(injected),
    createInternetArchiveProvider(),
    createIaTvNewsProvider(),
    createWibyProvider(),
    createWaybackProvider(),
    createOpenAlexProvider(injected),
    createOrcidProvider(injected),
    createGitHubUsersProvider(injected),
    createDblpProvider(injected),
    createRorProvider(injected),
    createGleifProvider(injected),
    createEdgarProvider(injected),
    /* Issue #228's source-family expansion, appended rather than interleaved:
       registration order is still the dedupe survivor rule, and the families
       below are additional coverage rather than a re-ranking of the web layer.
       Person research selects what to read by relevance and coverage gap, so
       being last in this list no longer means being read last. */
    createMwmblProvider(injected),
    createPeerTubeProvider(injected),
    createPodcastDirectoryProvider(injected),
    createBlueskyProvider(injected),
    createCrossrefProvider(injected),
    createDataCiteProvider(injected),
    createOpenLibraryProvider(injected),
    createNppesProvider(injected),
    createClinicalTrialsProvider(injected),
    createNonprofitExplorerProvider(injected),
    createTvMazeProvider(injected),
    createLibraryOfCongressProvider(injected),
    createArticProvider(injected),
  );
  return providers;
}
