import { createHash } from "node:crypto";
import {
  isSuccessfulSourceDiagnostic,
  type AdapterDiagnostic,
  type PersonProfile,
  type ResearchIdentifierClass,
  type ResearchIdentifierPurpose,
  type ResearchIdentifierUse,
  type ResearchProviderBundle,
  type ResearchProviderOutcome,
  type ResearchRequest,
  type ResearchRequestLimits,
  type ResearchRequestScope,
  type SourceItem,
} from "@chief-of-staff-demo/shared";
import { COLLECTION_GLOBAL_CONCURRENCY, mapLimit } from "../source-adapters/collection.js";
import { sanitizeAdapterDiagnostic } from "../source-adapters/diagnostics.js";
import { PUBLIC_SEARCH_ROUTE, type PublicSearch } from "../source-adapters/search.js";

/** One bounded, finite lookup: a fixed query list and a ceiling on what may come back. */
export interface ResearchProviderRequest {
  queries: string[];
  maxItems: number;
}

export interface ResearchProviderResult {
  items: SourceItem[];
  diagnostic: AdapterDiagnostic;
}

/**
 * One public-research provider in a Research Request bundle. It answers a fixed
 * list of questions once and returns normalized Source Items — the same shared
 * evidence contract the recurring Source Adapters use. Deliberately unlike
 * `SourceAdapter`: it takes no Source Target, so it can neither read nor write a
 * checkpoint, a conditional validator or any other recurring collection state.
 */
export interface ResearchProvider {
  readonly id: string;
  readonly version: string;
  lookup(request: ResearchProviderRequest): Promise<ResearchProviderResult>;
}

export const PUBLIC_WEB_RESEARCH_PROVIDER_ID = "public-web";

type AttributedQuery = {
  query: string;
  identifierClass: ResearchIdentifierClass | null;
  purpose: ResearchIdentifierPurpose;
};

function quoted(value: string): string {
  return `"${value.trim()}"`;
}

/**
 * Keep the first entry for every distinct key: a finite plan never carries a
 * duplicate forward.
 */
export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const entry = key(item);
    if (seen.has(entry)) return false;
    seen.add(entry);
    return true;
  });
}

/** The per-identifier-type cap that keeps the query plan bounded and proportionate. */
const MAX_QUERIES_PER_IDENTIFIER_TYPE = 2;

/**
 * Every identifier the Workspace holds for the researched person is fair game
 * for an anonymous public query — email included (spec #117). Only the class of
 * each identifier leaves this function; the values go to the providers and are
 * never written into the Research Request.
 */
function personQueries(profile: PersonProfile, question: string): AttributedQuery[] {
  const queries: AttributedQuery[] = [];
  const emails = [profile.primaryEmail, ...profile.emails].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  for (const email of [...new Set(emails)].slice(0, MAX_QUERIES_PER_IDENTIFIER_TYPE)) {
    queries.push({
      query: quoted(email),
      identifierClass: "email",
      purpose: "person-identification",
    });
  }
  if (profile.fullName) {
    queries.push({
      query: quoted(profile.fullName),
      identifierClass: "full-name",
      purpose: "person-identification",
    });
  }
  for (const handle of Object.values(profile.handles)
    .flat()
    .slice(0, MAX_QUERIES_PER_IDENTIFIER_TYPE)) {
    queries.push({
      query: quoted(handle.replace(/^@/, "")),
      identifierClass: "handle",
      purpose: "person-identification",
    });
  }
  for (const url of profile.profileUrls.slice(0, MAX_QUERIES_PER_IDENTIFIER_TYPE)) {
    queries.push({
      query: quoted(url),
      identifierClass: "profile-url",
      purpose: "person-identification",
    });
  }
  for (const employer of profile.employerHints.slice(0, MAX_QUERIES_PER_IDENTIFIER_TYPE)) {
    queries.push({
      query: profile.fullName
        ? `${quoted(profile.fullName)} ${quoted(employer)}`
        : quoted(employer),
      identifierClass: "employer-hint",
      purpose: "person-identification",
    });
  }
  if (profile.fullName) {
    queries.push({
      query: `${quoted(profile.fullName)} ${question}`,
      identifierClass: "full-name",
      purpose: "topic-evidence",
    });
  }
  return queries;
}

/** The finite query plan: the owner's stated scope first, then the person's identifiers. */
function plannedQueries(
  scope: ResearchRequestScope,
  subjectProfile: PersonProfile | null,
  limits: ResearchRequestLimits,
): AttributedQuery[] {
  const planned: AttributedQuery[] = [
    { query: scope.question, identifierClass: null, purpose: "topic-evidence" },
    ...scope.terms.map((term): AttributedQuery => ({
      query: term,
      identifierClass: null,
      purpose: "topic-evidence",
    })),
    ...(subjectProfile ? personQueries(subjectProfile, scope.question) : []),
  ];
  return uniqueBy(planned, (entry) => entry.query).slice(0, limits.maxQueriesPerProvider);
}
function identifierUses(
  queries: AttributedQuery[],
  providerId: string,
  usedAt: string,
): ResearchIdentifierUse[] {
  return uniqueBy(
    queries.filter(
      (entry): entry is AttributedQuery & { identifierClass: ResearchIdentifierClass } =>
        entry.identifierClass !== null,
    ),
    (entry) => `${entry.identifierClass}\n${entry.purpose}`,
  ).map((entry) => ({
    identifierClass: entry.identifierClass,
    providerId,
    usedAt,
    purpose: entry.purpose,
  }));
}
function internalFailureDiagnostic(input: {
  startedAt: string;
  finishedAt: string;
  cause: string;
}): AdapterDiagnostic {
  return {
    classification: "internal_failure",
    route: "/",
    status: null,
    contentType: null,
    parserStage: "adapter_boundary",
    responseHash: "",
    adapterVersion: "unknown",
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    retries: 0,
    affectedCapabilities: [],
    causeChain: [input.cause],
  };
}

/**
 * Run one finite Research Request across its configured provider bundle. Every
 * provider is asked exactly once, within the request's own limits, and the
 * request ends: there is no retry schedule, no checkpoint to advance and no
 * state that outlives the returned record.
 */
export async function runFiniteResearch(input: {
  providers: ResearchProvider[];
  bundle: ResearchProviderBundle;
  limits: ResearchRequestLimits;
  scope: ResearchRequestScope;
  subjectProfile: PersonProfile | null;
  now: () => Date;
}): Promise<
  Pick<
    ResearchRequest,
    | "startedAt"
    | "finishedAt"
    | "completeness"
    | "providerOutcomes"
    | "identifierUses"
    | "sourceItems"
  >
> {
  const startedAt = input.now().toISOString();
  const queries = plannedQueries(input.scope, input.subjectProfile, input.limits);
  const collected = new Array<{ outcome: ResearchProviderOutcome; items: SourceItem[] }>(
    input.providers.length,
  );
  await mapLimit(
    input.providers.map((provider, index) => ({ provider, index })),
    COLLECTION_GLOBAL_CONCURRENCY,
    async ({ provider, index }) => {
      const providerStartedAt = input.now().toISOString();
      let result: ResearchProviderResult;
      try {
        result = await provider.lookup({
          queries: queries.map((entry) => entry.query),
          maxItems: input.limits.maxSourceItems,
        });
      } catch (error) {
        result = {
          items: [],
          diagnostic: internalFailureDiagnostic({
            startedAt: providerStartedAt,
            finishedAt: input.now().toISOString(),
            cause: error instanceof Error ? error.message : String(error),
          }),
        };
      }
      const diagnostic = sanitizeAdapterDiagnostic(result.diagnostic, provider.version);
      /* A failed provider contributes diagnostics, never evidence: a failure
         must not reach the Content Engine dressed as a Source Item. */
      const items = isSuccessfulSourceDiagnostic(diagnostic.classification) ? result.items : [];
      collected[index] = {
        outcome: {
          providerId: provider.id,
          queries: queries.length,
          itemsFound: items.length,
          diagnostic,
        },
        items,
      };
    },
  );

  const providerOutcomes = collected.map((entry) => entry.outcome);
  const sourceItems = uniqueBy(
    collected.flatMap((entry) => entry.items),
    (item) => item.id,
  ).slice(0, input.limits.maxSourceItems);
  const everyProviderSucceeded = providerOutcomes.every((outcome) =>
    isSuccessfulSourceDiagnostic(outcome.diagnostic.classification),
  );
  return {
    startedAt,
    finishedAt: input.now().toISOString(),
    completeness:
      input.bundle.completeness === "all-providers" && !everyProviderSucceeded
        ? "incomplete"
        : "complete",
    providerOutcomes,
    identifierUses: input.providers.flatMap((provider) =>
      identifierUses(queries, provider.id, startedAt),
    ),
    sourceItems,
  };
}

function itemIdFor(url: string): string {
  return `research_${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
}

/**
 * The Workspace's anonymous public search seam, presented as a finite research
 * provider. It reuses the shared `PublicSearch` route rather than opening a
 * second one, and turns each result into the shared normalized Source Item.
 */
export function createPublicSearchResearchProvider(
  search: PublicSearch,
  now: () => Date,
): ResearchProvider {
  return {
    id: PUBLIC_WEB_RESEARCH_PROVIDER_ID,
    version: "1",
    async lookup(request) {
      const startedAt = now().toISOString();
      const settled = await Promise.allSettled(
        request.queries.map(async (query) => await search(query)),
      );
      const failures = settled.filter((result) => result.status === "rejected").length;
      const results = uniqueBy(
        settled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
        (result) => result.url,
      ).slice(0, request.maxItems);
      const discoveredAt = now().toISOString();
      const items: SourceItem[] = results.map((result) => ({
        id: itemIdFor(result.url),
        externalId: result.url,
        targetId: "",
        adapterId: PUBLIC_WEB_RESEARCH_PROVIDER_ID,
        canonicalUrl: result.url,
        author: null,
        title: result.title || null,
        body: null,
        description: result.snippet || null,
        publishedAt: null,
        discoveredAt,
        media: [],
        transcript: null,
        comments: [],
        evidence: [{ route: result.url, retrievedAt: discoveredAt }],
        completeness: {
          title: result.title ? "available" : "unavailable",
          body: "unsupported",
          description: result.snippet ? "available" : "unavailable",
          transcript: "unsupported",
          comments: "unsupported",
          media: "unsupported",
        },
      }));
      return {
        items,
        diagnostic: {
          classification:
            failures === settled.length && settled.length > 0
              ? "internal_failure"
              : items.length > 0
                ? "items_found"
                : "legitimate_empty",
          route: PUBLIC_SEARCH_ROUTE,
          status: null,
          contentType: null,
          parserStage: "fetch",
          responseHash: "",
          adapterVersion: "1",
          startedAt,
          finishedAt: now().toISOString(),
          retries: 0,
          affectedCapabilities: ["items"],
          causeChain: failures > 0 ? [`${failures} public queries failed`] : [],
        },
      };
    },
  };
}
