import type {
  AdapterDiagnostic,
  SourceAdapterCanaryTarget,
  SourceDiagnosticClassification,
  SourceFieldState,
  SourceItem,
} from "@chief-of-staff-demo/shared";
import { SOURCE_BACKFILL_WINDOWS_DAYS } from "@chief-of-staff-demo/shared";
import type {
  SourceAdapter,
  SourceCollectionResult,
} from "../../../source-adapters/source-adapter.js";
import {
  publicHttpFetch,
  responseHash,
  retryAfterMilliseconds,
  type PublicHttpFetch,
} from "../../../source-adapters/http.js";

interface AlgoliaHit {
  objectID?: string;
  title?: string;
  story_title?: string;
  comment_text?: string;
  story_text?: string;
  url?: string;
  author?: string;
  points?: number;
  created_at?: string;
}

type FailedOutcome = Exclude<
  SourceDiagnosticClassification,
  "items_found" | "legitimate_empty" | "no_new_material"
>;

function fieldState(present: boolean): SourceFieldState {
  return present ? "available" : "unavailable";
}

function failed(
  version: string,
  route: string,
  classification: FailedOutcome,
  status: number | null,
  cause: string,
  startedAt: string,
  finishedAt: string,
  retryAfterMs?: number,
): SourceCollectionResult {
  const diagnostic: AdapterDiagnostic = {
    classification,
    route,
    status,
    contentType: null,
    parserStage: "fetch",
    responseHash: "",
    adapterVersion: version,
    startedAt,
    finishedAt,
    retries: 0,
    affectedCapabilities: [],
    causeChain: [cause],
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
  return { kind: "failed", outcome: classification, items: [], checkpoint: null, diagnostic };
}

/**
 * Hacker News via the keyless Algolia search API (https://hn.algolia.com/api).
 * `search_by_date` honors a genuine historical `since` (`numericFilters` on
 * `created_at`), so every backfill window is declared and honored honestly.
 */
export class HnAlgoliaSourceAdapter implements SourceAdapter {
  readonly id = "hn" as const;
  readonly state = "available" as const;
  readonly version = "hn-algolia-v1";
  readonly backfillWindowsDays = SOURCE_BACKFILL_WINDOWS_DAYS;
  readonly canaryTargets: readonly SourceAdapterCanaryTarget[] = [
    {
      adapterId: "hn",
      label: "Hacker News search_by_date",
      url: "https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=5",
    },
  ];

  constructor(
    private readonly fetchJson: PublicHttpFetch = publicHttpFetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  supports(target: { adapterId: string }): boolean {
    return target.adapterId === this.id;
  }

  async collect(request: {
    target: { id: string; url: string };
    since: string;
    until: string;
  }): Promise<SourceCollectionResult> {
    const startedAt = this.now().toISOString();
    const route = request.target.url;
    const url = new URL(route);
    url.searchParams.set("hitsPerPage", "30");
    const sinceMs = Date.parse(request.since);
    if (Number.isFinite(sinceMs)) {
      const existing = url.searchParams.get("numericFilters");
      const filter = `created_at_i>${Math.floor(sinceMs / 1000)}`;
      url.searchParams.set("numericFilters", existing ? `${existing},${filter}` : filter);
    }

    let response;
    try {
      response = await this.fetchJson(url.toString());
    } catch (error) {
      return failed(
        this.version,
        route,
        "internal_failure",
        null,
        error instanceof Error ? error.message : String(error),
        startedAt,
        this.now().toISOString(),
      );
    }
    const finishedAt = this.now().toISOString();
    if (response.status !== 200) {
      const classification: FailedOutcome =
        response.status === 429
          ? "rate_limit"
          : response.status === 401 || response.status === 403
            ? "blocked_access"
            : "internal_failure";
      return failed(
        this.version,
        route,
        classification,
        response.status,
        `Hacker News (Algolia) answered ${response.status}`,
        startedAt,
        finishedAt,
        response.status === 429
          ? retryAfterMilliseconds(response.retryAfter, this.now())
          : undefined,
      );
    }

    let parsed: { hits?: AlgoliaHit[] };
    try {
      parsed = JSON.parse(response.body) as { hits?: AlgoliaHit[] };
    } catch (error) {
      return failed(
        this.version,
        route,
        "parser_failure",
        response.status,
        error instanceof Error ? error.message : String(error),
        startedAt,
        finishedAt,
      );
    }
    const hits = (Array.isArray(parsed.hits) ? parsed.hits : []).filter((hit) => {
      const publishedMs = hit.created_at ? Date.parse(hit.created_at) : Number.NaN;
      return (
        typeof hit.objectID === "string" &&
        hit.objectID !== "" &&
        (!Number.isFinite(sinceMs) || !Number.isFinite(publishedMs) || publishedMs >= sinceMs)
      );
    });
    const retrievedAt = this.now().toISOString();
    const items: SourceItem[] = hits.map((hit) => {
      const objectID = hit.objectID as string;
      const title = hit.title ?? hit.story_title ?? null;
      const body = hit.story_text ?? hit.comment_text ?? null;
      return {
        id: `hn_${objectID}`,
        externalId: `hn:${objectID}`,
        targetId: request.target.id,
        adapterId: this.id,
        canonicalUrl: `https://news.ycombinator.com/item?id=${objectID}`,
        author: hit.author ?? null,
        title,
        body,
        description: null,
        publishedAt: hit.created_at ?? null,
        discoveredAt: retrievedAt,
        media: [],
        transcript: null,
        comments: [],
        evidence: [{ route, retrievedAt }],
        /* Algolia reports a story's points; that is HN's engagement surface and
           the only count this adapter observes. */
        ...(typeof hit.points === "number" ? { engagement: { hnPoints: hit.points } } : {}),
        completeness: {
          title: fieldState(title !== null),
          body: fieldState(body !== null),
          description: "unavailable",
          transcript: "unsupported",
          comments: "unsupported",
          media: "unsupported",
        },
      } satisfies SourceItem;
    });

    return {
      kind: "completed",
      outcome: items.length > 0 ? "items_found" : "legitimate_empty",
      items,
      checkpoint: request.until,
      diagnostic: {
        classification: items.length > 0 ? "items_found" : "legitimate_empty",
        route,
        status: response.status,
        contentType: response.contentType,
        parserStage: "adapter_boundary",
        responseHash: responseHash(response.body),
        adapterVersion: this.version,
        startedAt,
        finishedAt,
        retries: 0,
        affectedCapabilities: [],
        causeChain: [],
      },
    };
  }
}
