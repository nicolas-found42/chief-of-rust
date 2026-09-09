import type { NamedPerson, SourceTarget } from "@chief-of-staff-demo/shared";
import type { SourceAdapter } from "../../source-adapters/source-adapter.js";

/**
 * The Source Targets one Named Person is collected on for one adapter.
 *
 * Explicit `discoveredSourceTargets` (a verified seed surface, an owner-added
 * URL) always win. Where nothing explicit exists, the person's name and handle
 * hints resolve public search surfaces — Reddit search, HN query, Google News —
 * so a person is watched wherever they publish without anyone pasting URLs by
 * hand (spec story 2). An adapter with nothing resolvable produces no target at
 * all: an invented placeholder URL would only manufacture failures.
 */
/**
 * The Source Targets a Person presents to one adapter. `storedState` supplies
 * the checkpoint and validators a previous Run recorded for that URL, so a
 * re-derived Target still makes a conditional request (spec #116 story 8).
 */
export function personSourceTargets(
  person: NamedPerson,
  adapter: SourceAdapter,
  storedState?: (url: string) => {
    checkpoint: string | null;
    conditional: { etag: string | null; lastModified: string | null } | null;
  } | null,
): SourceTarget[] {
  const explicit = person.discoveredSourceTargets.filter((t) => t.adapterId === adapter.id);
  const derived = deriveTargets(person, adapter.id);
  const seen = new Set<string>();
  const targets: SourceTarget[] = [];
  const push = (label: string, url: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    const stored = storedState?.(url) ?? null;
    targets.push({
      id: `${person.id}__${adapter.id}__${targets.length}`,
      adapterId: adapter.id,
      label,
      url,
      state: "active",
      createdAt: person.createdAt,
      archivedAt: null,
      checkpoint: stored?.checkpoint ?? null,
      lastSuccessfulAt: null,
      conditional: stored?.conditional ?? null,
    });
  };
  for (const t of explicit) push(t.label, t.url);
  for (const t of derived) push(t.label, t.url);
  return targets;
}

function quoted(person: NamedPerson): string {
  return `"${person.name}"`;
}

function deriveTargets(person: NamedPerson, adapterId: string): { label: string; url: string }[] {
  const hints = person.handleHints;
  switch (adapterId) {
    case "rss":
      return hints.blogRssHints.map((url) => ({ label: `${person.name} blog RSS`, url }));
    case "website": {
      const origins = new Set<string>();
      for (const hint of hints.blogRssHints) {
        try {
          origins.add(new URL(hint).origin);
        } catch {
          // a hint that is not a URL is not a site either
        }
      }
      return [...origins].map((url) => ({ label: `${person.name} website`, url }));
    }
    case "youtube":
      return hints.youtubeChannelId
        ? [
            {
              label: `${person.name} YouTube`,
              url: `https://www.youtube.com/channel/${hints.youtubeChannelId}`,
            },
          ]
        : [];
    case "reddit":
      return [
        {
          label: `Reddit mentions of ${person.name}`,
          url: `https://www.reddit.com/search.rss?q=${encodeURIComponent(quoted(person))}&sort=new`,
        },
      ];
    case "hn": {
      const targets = [
        {
          label: `Hacker News mentions of ${person.name}`,
          url: `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(person.name)}&tags=story`,
        },
      ];
      if (hints.hnUsername) {
        targets.unshift({
          label: `${person.name} on Hacker News`,
          url: `https://hn.algolia.com/api/v1/search_by_date?tags=author_${encodeURIComponent(hints.hnUsername)}`,
        });
      }
      return targets;
    }
    case "news":
      return [
        {
          label: `Google News mentions of ${person.name}`,
          url: `https://news.google.com/rss/search?q=${encodeURIComponent(quoted(person))}`,
        },
      ];
    default:
      return [];
  }
}
