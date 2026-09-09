import { createHttpFetch, retryAfterMilliseconds, type PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";

/**
 * The keyless person-record providers added for issue #228.
 *
 * They share one file rather than taking a file each because they share one
 * shape: a public JSON endpoint that needs no key, no account and no sign-in,
 * queried with the same person string the rest of the bundle receives, and
 * normalized to the same three fields. The differences between them are the
 * endpoint, the JSON path to a record, and how a record names itself — small
 * enough that twelve near-identical files would hide rather than reveal them.
 *
 * Every route below was verified against its own current documentation and by
 * an anonymous live probe recorded in `docs/research/person-source-eligibility.md`.
 * A route that stops answering anonymously belongs in that record as a gap,
 * not behind a key.
 */

const MAX_RESULTS = 6;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** The named array on a parsed body, or none. Never widens a non-array. */
function arrayAt(value: unknown, key: string): unknown[] {
  const found = asRecord(value)?.[key];
  return Array.isArray(found) ? found : [];
}

function text(value: unknown, limit = 300): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function usableUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

async function json(
  name: string,
  url: string,
  fetch: PublicHttpFetch,
  io: SearchProviderIo,
): Promise<unknown> {
  const response = await fetch(url, { timeoutMs: io.timeoutMs });
  if (response.status !== 200) {
    const rateLimited = response.status === 429 || response.status === 503;
    throw new ProviderRefusedError(
      rateLimited ? "rate-limited" : "error",
      `${name} answered ${String(response.status)}.`,
      rateLimited ? retryAfterMilliseconds(response.retryAfter, new Date()) : undefined,
    );
  }
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new ProviderRefusedError("error", `${name} returned a malformed body.`);
  }
}

/**
 * These endpoints answer JSON and nothing else.
 *
 * The shared transport's accept list is HTML-and-feeds first, which Crossref
 * answers with a 406 and DataCite with a 500 — the same reason ORCID and SEC
 * EDGAR already carry their own transports. One JSON transport serves all of
 * them; it is otherwise the ordinary guarded anonymous fetch.
 */
const jsonFetch = createHttpFetch({ headers: { accept: "application/json" } });

/** A provider over one JSON endpoint, described by how it names its records. */
function jsonProvider(config: {
  name: string;
  endpoint: (query: string) => string;
  /** Pull the record array out of the parsed body. */
  records: (body: unknown) => unknown[];
  /** Turn one record into a result, or null when it has no usable URL. */
  result: (record: Record<string, unknown>) => PublicSearchResult | null;
  /** Queries this provider cannot answer at all. Declining is not refusing. */
  declines?: (query: string) => boolean;
  options?: { fetch?: PublicHttpFetch };
}): SearchProvider {
  return {
    name: config.name,
    async search(query, io) {
      if (config.declines?.(query)) return [];
      const body = await json(
        config.name,
        config.endpoint(query),
        config.options?.fetch ?? jsonFetch,
        io,
      );
      const results: PublicSearchResult[] = [];
      for (const entry of config.records(body).slice(0, MAX_RESULTS)) {
        const record = asRecord(entry);
        if (!record) continue;
        const result = config.result(record);
        if (result) results.push(result);
      }
      return results;
    },
  };
}

/** Crossref: DOI metadata for published work, with a polite-pool contact. */
export function createCrossrefProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  return jsonProvider({
    name: "crossref",
    options,
    endpoint: (query) =>
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${String(MAX_RESULTS)}&mailto=owner@found42.local`,
    records: (body) => arrayAt(asRecord(body)?.message, "items"),
    result: (record) => {
      const doi = text(record.DOI, 200);
      if (!doi) return null;
      const title = Array.isArray(record.title) ? text(record.title[0]) : "";
      const authors = Array.isArray(record.author)
        ? record.author
            .slice(0, 8)
            .map((entry) => {
              const author = asRecord(entry);
              return author ? `${text(author.given, 80)} ${text(author.family, 80)}`.trim() : "";
            })
            .filter(Boolean)
            .join(", ")
        : "";
      return { url: `https://doi.org/${doi}`, title: title || doi, snippet: authors };
    },
  });
}

/** DataCite: deposited datasets, software and preprints by creator name. */
export function createDataCiteProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  return jsonProvider({
    name: "datacite",
    options,
    endpoint: (query) =>
      `https://api.datacite.org/dois?query=${encodeURIComponent(query)}&page%5Bsize%5D=${String(MAX_RESULTS)}`,
    records: (body) => arrayAt(body, "data"),
    result: (record) => {
      const attributes = asRecord(record.attributes);
      const doi = text(attributes?.doi, 200);
      if (!doi) return null;
      const titles = Array.isArray(attributes?.titles) ? attributes.titles : [];
      const title = text(asRecord(titles[0])?.title);
      const creators = Array.isArray(attributes?.creators)
        ? attributes.creators
            .slice(0, 8)
            .map((entry) => text(asRecord(entry)?.name, 120))
            .filter(Boolean)
            .join(", ")
        : "";
      return { url: `https://doi.org/${doi}`, title: title || doi, snippet: creators };
    },
  });
}

/**
 * NPPES: the United States registry of health-care providers.
 *
 * A person query only makes sense here as a name, so the provider splits it and
 * declines anything that does not look like one rather than refusing — the
 * composite treats a decline as "not my question", which is what it is.
 */
export function createNppesProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  const nameOf = (query: string) => {
    const words = query.replace(/["']/g, " ").trim().split(/\s+/).filter(Boolean);
    return words.length >= 2 ? { first: words[0]!, last: words[words.length - 1]! } : null;
  };
  return jsonProvider({
    name: "nppes",
    options,
    declines: (query) => nameOf(query) === null,
    endpoint: (query) => {
      const name = nameOf(query)!;
      return `https://npiregistry.cms.hhs.gov/api/?version=2.1&first_name=${encodeURIComponent(name.first)}&last_name=${encodeURIComponent(name.last)}&limit=${String(MAX_RESULTS)}`;
    },
    records: (body) => arrayAt(body, "results"),
    result: (record) => {
      const number =
        typeof record.number === "number" ? String(record.number) : text(record.number, 20);
      if (!/^\d{10}$/.test(number)) return null;
      const basic = asRecord(record.basic);
      const taxonomies = Array.isArray(record.taxonomies) ? record.taxonomies : [];
      return {
        url: `https://npiregistry.cms.hhs.gov/provider-view/${number}`,
        title: `${text(basic?.first_name, 80)} ${text(basic?.last_name, 80)}`.trim() || number,
        snippet: [
          text(basic?.credential, 60),
          text(asRecord(taxonomies[0])?.desc, 120),
          text(basic?.status, 20) === "A" ? "active registration" : "",
        ]
          .filter(Boolean)
          .join(" · "),
      };
    },
  });
}

/** ClinicalTrials.gov: trials naming a person as an investigator or contact. */
export function createClinicalTrialsProvider(
  options: { fetch?: PublicHttpFetch } = {},
): SearchProvider {
  return jsonProvider({
    name: "clinicaltrials",
    options,
    endpoint: (query) =>
      `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(query)}&pageSize=${String(MAX_RESULTS)}`,
    records: (body) => arrayAt(body, "studies"),
    result: (record) => {
      const section = asRecord(asRecord(record.protocolSection)?.identificationModule);
      const id = text(section?.nctId, 20);
      if (!id) return null;
      return {
        url: `https://clinicaltrials.gov/study/${id}`,
        title: text(section?.briefTitle) || id,
        snippet: text(section?.officialTitle, 300),
      };
    },
  });
}

/** ProPublica Nonprofit Explorer: US nonprofit filings, officers and pay. */
export function createNonprofitExplorerProvider(
  options: { fetch?: PublicHttpFetch } = {},
): SearchProvider {
  return jsonProvider({
    name: "nonprofit-explorer",
    options,
    endpoint: (query) =>
      `https://projects.propublica.org/nonprofits/api/v2/search.json?q=${encodeURIComponent(query)}`,
    records: (body) => arrayAt(body, "organizations"),
    result: (record) => {
      const ein = record.ein;
      if (typeof ein !== "number" && typeof ein !== "string") return null;
      return {
        url: `https://projects.propublica.org/nonprofits/organizations/${String(ein)}`,
        title: text(record.name) || String(ein),
        snippet: [
          text(record.city, 80),
          text(record.state, 10),
          text(record.ntee_classification, 120),
        ]
          .filter(Boolean)
          .join(", "),
      };
    },
  });
}

/** TVMaze: screen credits for people who work in television. */
export function createTvMazeProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  return jsonProvider({
    name: "tvmaze",
    options,
    endpoint: (query) =>
      `https://api.tvmaze.com/search/people?q=${encodeURIComponent(query.replace(/["']/g, ""))}`,
    records: (body) => (Array.isArray(body) ? (body as unknown[]) : []),
    result: (record) => {
      const person = asRecord(record.person);
      const url = usableUrl(person?.url);
      if (!url) return null;
      return {
        url,
        title: text(person?.name) || url,
        snippet: [text(asRecord(person?.country)?.name, 80), text(person?.birthday, 20)]
          .filter(Boolean)
          .join(" · "),
      };
    },
  });
}

/** Library of Congress: catalogue and collection records naming a person. */
export function createLibraryOfCongressProvider(
  options: { fetch?: PublicHttpFetch } = {},
): SearchProvider {
  return jsonProvider({
    name: "library-of-congress",
    options,
    endpoint: (query) =>
      `https://www.loc.gov/search/?q=${encodeURIComponent(query)}&fo=json&c=${String(MAX_RESULTS)}`,
    records: (body) => arrayAt(body, "results"),
    result: (record) => {
      const url = usableUrl(record.id) ?? usableUrl(record.url);
      if (!url) return null;
      const title = Array.isArray(record.title) ? text(record.title[0]) : text(record.title);
      const description = Array.isArray(record.description)
        ? text(record.description[0])
        : text(record.description);
      return { url, title: title || url, snippet: description };
    },
  });
}

/** Art Institute of Chicago: public catalogue records and artist credits. */
export function createArticProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  return jsonProvider({
    name: "artic",
    options,
    endpoint: (query) =>
      `https://api.artic.edu/api/v1/artworks/search?q=${encodeURIComponent(query)}&limit=${String(MAX_RESULTS)}&fields=id,title,artist_display,date_display`,
    records: (body) => arrayAt(body, "data"),
    result: (record) => {
      const id = record.id;
      if (typeof id !== "number") return null;
      return {
        url: `https://www.artic.edu/artworks/${String(id)}`,
        title: text(record.title) || String(id),
        snippet: [text(record.artist_display, 200), text(record.date_display, 60)]
          .filter(Boolean)
          .join(" · "),
      };
    },
  });
}

/** Open Library: authorship records for people who have published books. */
export function createOpenLibraryProvider(
  options: { fetch?: PublicHttpFetch } = {},
): SearchProvider {
  return jsonProvider({
    name: "open-library",
    options,
    endpoint: (query) =>
      `https://openlibrary.org/search/authors.json?q=${encodeURIComponent(query.replace(/["']/g, ""))}`,
    records: (body) => arrayAt(body, "docs"),
    result: (record) => {
      const key = text(record.key, 60);
      if (!key) return null;
      return {
        url: `https://openlibrary.org/authors/${key}`,
        title: text(record.name) || key,
        snippet: [
          text(record.top_work, 200),
          typeof record.work_count === "number" ? `${String(record.work_count)} works` : "",
          text(record.birth_date, 40),
        ]
          .filter(Boolean)
          .join(" · "),
      };
    },
  });
}
