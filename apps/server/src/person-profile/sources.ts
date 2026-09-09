import type {
  PersonEvidenceCandidate,
  PersonEvidenceKind,
  PersonIdentitySignals,
} from "@chief-of-staff-demo/shared";
import type { HubSpotApi } from "../modules/meeting-brief-generator/hubspot/client.js";
import { matchPersonEvidence, type PersonProfileSource } from "./resolver.js";
import type { PublicSearch, PublicSearchResult } from "../source-adapters/search.js";
import type { FeedDiscoverer } from "../source-adapters/feeds.js";
import { MAX_CLAIM_EXTRACTIONS, type PersonClaimExtractor } from "./claims.js";

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function emptySignals(): PersonIdentitySignals {
  return { emails: [], fullNames: [], handles: {}, profileUrls: [], employerHints: [] };
}

function socialPlatform(value: string): string | null {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    const platforms: Record<string, string> = {
      "bsky.app": "bluesky",
      "facebook.com": "facebook",
      "github.com": "github",
      "instagram.com": "instagram",
      "linkedin.com": "linkedin",
      "medium.com": "medium",
      "substack.com": "substack",
      "threads.net": "threads",
      "tiktok.com": "tiktok",
      "x.com": "x",
      "youtube.com": "youtube",
    };
    return platforms[host] ?? (host.endsWith(".substack.com") ? "substack" : null);
  } catch {
    return null;
  }
}

export function socialUrl(value: string): {
  platform: string;
  kind: "profile" | "publication";
  handle: string | null;
} | null {
  try {
    const url = new URL(value);
    const platform = socialPlatform(value);
    if (!platform) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (platform === "linkedin") {
      if (parts[0] === "in" && parts[1]) return { platform, kind: "profile", handle: parts[1] };
      return { platform, kind: "publication", handle: null };
    }
    if (platform === "x") {
      const handle = parts[0]?.replace(/^@/, "") ?? null;
      return { platform, kind: parts.includes("status") ? "publication" : "profile", handle };
    }
    if (platform === "github") {
      return {
        platform,
        kind: parts.length === 1 ? "profile" : "publication",
        handle: parts[0] ?? null,
      };
    }
    if (platform === "bluesky") {
      const profileAt = parts.indexOf("profile");
      const handle = profileAt >= 0 ? (parts[profileAt + 1] ?? null) : null;
      return { platform, kind: parts.includes("post") ? "publication" : "profile", handle };
    }
    if (platform === "youtube") {
      const publication = parts[0] === "watch" || parts[0] === "shorts" || parts[0] === "live";
      const handle = parts.find((part) => part.startsWith("@"))?.slice(1) ?? null;
      return { platform, kind: publication ? "publication" : "profile", handle };
    }
    if (platform === "instagram" || platform === "facebook" || platform === "tiktok") {
      const publication = parts.some((part) => part === "p" || part === "reel" || part === "video");
      return { platform, kind: publication ? "publication" : "profile", handle: parts[0] ?? null };
    }
    if (platform === "substack" || platform === "medium") {
      const publication = parts.includes("p") || parts.length > 1;
      return { platform, kind: publication ? "publication" : "profile", handle: null };
    }
    return { platform, kind: "profile", handle: parts.at(-1)?.replace(/^@/, "") ?? null };
  } catch {
    return null;
  }
}

export function createHubSpotPersonProfileSource(
  getApi: () => HubSpotApi | null,
): PersonProfileSource {
  return {
    id: "hubspot",
    async collect(signals) {
      const api = getApi();
      if (!api) {
        return {
          candidates: [],
          diagnostic: { status: "unconfigured", detail: "HubSpot is not connected" },
        };
      }
      const candidates: PersonEvidenceCandidate[] = [];
      for (const email of unique(signals.emails.map((value) => value.trim().toLowerCase())).slice(
        0,
        3,
      )) {
        const contact = await api.searchContactByEmail(email);
        if (!contact) continue;
        const companyIds = (await api.getAssociatedCompanyIds(contact.id)).slice(0, 3);
        const companies = (
          await Promise.all(companyIds.map(async (id) => await api.getCompany(id)))
        ).filter((company) => company !== null);
        const firstName = clean(contact.properties.firstname);
        const lastName = clean(contact.properties.lastname);
        const fullName = clean([firstName, lastName].filter(Boolean).join(" "));
        const role = clean(contact.properties.jobtitle);
        const twitter = clean(contact.properties.twitterhandle)?.replace(/^@/, "") ?? null;
        const linkedin = clean(contact.properties.hs_linkedin_url);
        const observed = emptySignals();
        observed.emails = [contact.email.trim().toLowerCase()];
        if (fullName) observed.fullNames = [fullName];
        if (twitter) observed.handles.x = [twitter];
        if (linkedin) observed.profileUrls = [linkedin];
        observed.employerHints = unique(
          companies.flatMap((company) => [company.name, company.domain ?? ""]),
        );
        const employer = companies.length === 1 ? (companies[0]?.name ?? null) : null;
        candidates.push({
          source: "hubspot",
          kind: companies.length > 0 ? "employment" : "identity",
          title: "HubSpot contact and company",
          summary: [fullName, role, employer].filter(Boolean).join(" · "),
          url: `https://app.hubspot.com/contacts/${encodeURIComponent(contact.id)}`,
          identitySignals: observed,
          claims: {
            ...(fullName ? { fullName } : {}),
            ...(role ? { role } : {}),
            ...(employer ? { currentEmployer: employer } : {}),
          },
        });
      }
      return {
        candidates,
        diagnostic: {
          status: candidates.length > 0 ? "completed" : "empty",
          detail: `${candidates.length} contact${candidates.length === 1 ? "" : "s"} matched`,
        },
      };
    },
  };
}

function publicQueries(signals: PersonIdentitySignals): string[] {
  const queries: string[] = [];
  for (const email of signals.emails.slice(0, 2)) queries.push(`"${email}"`);
  /* A typed profile address is often the only signal there is; the address
     itself is the query, and the page it names is reached through the search
     index rather than fetched. */
  for (const url of signals.profileUrls.slice(0, 2)) queries.push(`"${url}"`);
  for (const name of signals.fullNames.slice(0, 2)) {
    queries.push(`"${name}" site:linkedin.com`);
    queries.push(`"${name}" blog OR newsletter OR podcast`);
    queries.push(`"${name}" interview OR article OR profile OR mention`);
    queries.push(
      `"${name}" site:github.com OR site:x.com OR site:bsky.app OR site:youtube.com OR site:substack.com`,
    );
  }
  for (const values of Object.values(signals.handles)) {
    for (const handle of values.slice(0, 2)) queries.push(`"${handle.replace(/^@/, "")}"`);
  }
  for (const name of signals.fullNames.slice(0, 1)) {
    for (const employer of signals.employerHints.slice(0, 2))
      queries.push(`"${name}" "${employer}"`);
  }
  return unique(queries).slice(0, 12);
}

function signalsObservedIn(
  result: PublicSearchResult,
  requested: PersonIdentitySignals,
): PersonIdentitySignals {
  const haystack = `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
  const observed = emptySignals();
  observed.emails = requested.emails.filter((value) => haystack.includes(value.toLowerCase()));
  observed.fullNames = requested.fullNames.filter((value) =>
    haystack.includes(value.toLowerCase()),
  );
  observed.employerHints = requested.employerHints.filter((value) =>
    haystack.includes(value.toLowerCase()),
  );
  for (const [platform, handles] of Object.entries(requested.handles)) {
    const resultPlatform = socialPlatform(result.url);
    if (resultPlatform && resultPlatform !== platform.toLowerCase()) continue;
    const matched = handles.filter((value) =>
      haystack.includes(value.toLowerCase().replace(/^@/, "")),
    );
    if (matched.length > 0) observed.handles[platform] = matched;
  }
  const social = socialUrl(result.url);
  if (social) {
    const { platform } = social;
    if (social.kind === "profile") observed.profileUrls.push(result.url);
    if (social.handle && !observed.handles[platform]) observed.handles[platform] = [social.handle];
  }
  return observed;
}

function kindOfPublicResult(result: PublicSearchResult): PersonEvidenceKind {
  const social = socialUrl(result.url);
  if (social) return social.kind === "profile" ? "social-profile" : "publication";
  try {
    const path = new URL(result.url).pathname.toLowerCase();
    if (/\/(about|bio|profile|author)\/?$/.test(path) || path === "/") return "website";
  } catch {
    // the result remains a mention; its invalid URL will not be feed-discovered
  }
  return "mention";
}

export function createPublicWebPersonProfileSource(input: {
  search: PublicSearch;
  discoverFeeds: FeedDiscoverer;
  /** What each result claims about the person. Absent, results carry no
   *  claims and the Profile holds evidence without summary fields. */
  extractClaims?: PersonClaimExtractor;
}): PersonProfileSource {
  return {
    id: "public-web",
    async collect(signals) {
      const settled = await Promise.allSettled(
        publicQueries(signals).map(async (query) => await input.search(query)),
      );
      const results = [
        ...new Map(
          settled
            .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
            .map((result) => [`${result.url}\n${result.title}`, result]),
        ).values(),
      ];
      const extractor = input.extractClaims;
      /* Claims are proposed per result and only for the first few: a model
         call each is worth it for the results a person will actually read,
         and a failed extraction costs the result its claims, never the
         evidence itself. */
      const claimed = await Promise.all(
        results.map(async (result, index) => {
          if (!extractor || index >= MAX_CLAIM_EXTRACTIONS) return {};
          try {
            return await extractor(
              { title: result.title, summary: result.snippet, url: result.url },
              signals,
            );
          } catch {
            return {};
          }
        }),
      );
      const candidates: PersonEvidenceCandidate[] = results.map((result, index) => ({
        source: "public-web",
        kind: kindOfPublicResult(result),
        title: result.title.slice(0, 200),
        summary: result.snippet.slice(0, 500),
        url: result.url,
        identitySignals: signalsObservedIn(result, signals),
        claims: claimed[index] ?? {},
      }));
      const ownedSiteCandidates = candidates
        .filter((candidate) => candidate.kind !== "social-profile")
        .filter(
          (candidate) =>
            matchPersonEvidence(signals, candidate.identitySignals)?.confidence === "high",
        )
        .slice(0, 5);
      const discovered = await Promise.allSettled(
        ownedSiteCandidates.map(async (candidate) => ({
          candidate,
          feeds: await input.discoverFeeds(candidate.url),
        })),
      );
      for (const result of discovered) {
        if (result.status !== "fulfilled") continue;
        for (const feed of result.value.feeds.slice(0, 3)) {
          candidates.push({
            source: "public-web",
            kind: "feed",
            title: feed.title ?? `${result.value.candidate.title} feed`,
            summary: `Feed declared by ${result.value.candidate.url}`,
            url: feed.url,
            identitySignals: result.value.candidate.identitySignals,
            claims: {},
          });
        }
      }
      const failures = settled.filter((result) => result.status === "rejected").length;
      return {
        candidates,
        diagnostic: {
          status:
            candidates.length > 0 ? "completed" : failures === settled.length ? "failed" : "empty",
          detail: `${candidates.length} evidence candidate${candidates.length === 1 ? "" : "s"} from ${results.length} public result${results.length === 1 ? "" : "s"}${failures ? `; ${failures} queries failed` : ""}`,
        },
      };
    },
  };
}
