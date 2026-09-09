import Parser from "rss-parser";
import { JSDOM } from "jsdom";
import {
  SOURCE_BACKFILL_WINDOWS_DAYS,
  type AdapterDiagnostic,
  type SourceAdapterCanaryTarget,
  type SourceDiagnosticClassification,
  type SourceItem,
} from "@chief-of-staff-demo/shared";
import type { SourceAdapter, SourceCollectionResult } from "./source-adapter.js";
import {
  canonicalUrl,
  publicHttpFetch,
  responseHash,
  retryAfterMilliseconds,
  type PublicHttpResponse,
  type PublicHttpFetch,
} from "./http.js";

type FeedEntry = {
  link?: string;
  id?: string;
  title?: string;
  author?: string;
  pubDate?: string;
  isoDate?: string;
  content?: string;
  contentSnippet?: string;
  summary?: string;
};

type FailedOutcome = Exclude<
  SourceDiagnosticClassification,
  "items_found" | "legitimate_empty" | "no_new_material"
>;

type RoutePlan = { rssUrl: string; jsonUrl: string; pageUrl: string };

/** One failed route attempt, carried forward so the terminal diagnostic explains the whole chain. */
interface RouteFailure {
  outcome: FailedOutcome;
  route: string;
  startedAt: string;
  status: number | null;
  contentType: string | null;
  parserStage: AdapterDiagnostic["parserStage"];
  hash: string;
  cause: string;
  retryAfterMs?: number;
  body?: string;
}

/** A route that can still be parsed: the shared gate already handled statuses and the checkpoint. */
interface ReadyRoute {
  response: PublicHttpResponse;
  hash: string;
}

/** What the shared fetch gate returned: a ready route, a completed result, or a recorded failure. */
type RouteGateResult =
  | { kind: "ready"; route: ReadyRoute }
  | { kind: "completed"; result: SourceCollectionResult }
  | { kind: "failed" };

function failedOutcome(
  status: number,
): Extract<FailedOutcome, "blocked_access" | "rate_limit" | "internal_failure"> {
  if (status === 401 || status === 403) return "blocked_access";
  if (status === 429) return "rate_limit";
  return "internal_failure";
}

function redditRoutes(value: string): RoutePlan | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host !== "reddit.com" && !host.endsWith(".reddit.com")) return null;
  const base = url.pathname.replace(/\/$/, "");
  const rssUrl = new URL(url.toString());
  rssUrl.pathname = base.endsWith(".rss") ? base : `${base}.rss`;
  const jsonUrl = new URL(url.toString());
  jsonUrl.pathname = base.endsWith(".json") ? base : `${base}.json`;
  jsonUrl.searchParams.set("limit", "25");
  return { rssUrl: rssUrl.toString(), jsonUrl: jsonUrl.toString(), pageUrl: value };
}

function isListing(value: unknown): value is { data: { children: unknown[] } } {
  if (!value || typeof value !== "object") return false;
  const data = (value as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return false;
  return Array.isArray((data as Record<string, unknown>).children);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function epochSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = typeof value === "string" ? value.trim() : "";
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  return null;
}

function redditTimestamp(value: string | null): string | null {
  if (!value) return null;
  const seconds = epochSeconds(value);
  if (seconds !== null) return new Date(seconds * 1000).toISOString();
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

/** Canonical Reddit identity: keep `t3_…` names, otherwise prefix the bare id with the kind. */
function canonicalRedditId(value: unknown, kind: "t3"): string | null {
  const text = stringValue(value);
  if (!text) return null;
  return /^t\d+_/.test(text) ? text : `${kind}_${text}`;
}

/** Public authors arrive as `/u/PublicAuthor` on RSS and plain `PublicAuthor` on JSON/HTML. */
function canonicalRedditAuthor(value: unknown): string | null {
  const text = stringValue(value);
  return text ? text.replace(/^\/?u\//i, "") : null;
}

/**
 * Complete Experimental Reddit adapter: public RSS first, then bounded anonymous
 * public JSON, then the server-rendered public page. Every route is anonymous
 * (no cookies, no account, no CAPTCHA bypass) and bounded (a fresh RSS/JSON
 * listing of at most 25 entries or one current page). Failures accumulate so
 * the terminal diagnostic carries the whole route chain, and malformed or
 * inaccessible responses are never collapsed into an empty success.
 */
export class RedditSourceAdapter implements SourceAdapter {
  readonly id = "reddit" as const;
  readonly state = "experimental" as const;
  readonly version = "reddit-public-rss-json-html-v1";
  /** The first route is a fresh feed filtered by `since`, so any requested window is honored honestly — bounded by whatever history the feed itself still carries. */
  readonly backfillWindowsDays = SOURCE_BACKFILL_WINDOWS_DAYS;
  readonly canaryTargets: readonly SourceAdapterCanaryTarget[] = [
    {
      adapterId: "reddit",
      label: "r/programming",
      url: "https://www.reddit.com/r/programming/.rss",
    },
    { adapterId: "reddit", label: "r/technology", url: "https://www.reddit.com/r/technology/.rss" },
    { adapterId: "reddit", label: "r/science", url: "https://www.reddit.com/r/science/.rss" },
  ];
  private readonly parser = new Parser<Record<string, unknown>, FeedEntry>();

  constructor(
    private readonly fetchText: PublicHttpFetch = publicHttpFetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  supports(target: { adapterId: string }): boolean {
    return target.adapterId === this.id;
  }

  async collect(request: Parameters<SourceAdapter["collect"]>[0]): Promise<SourceCollectionResult> {
    const startedAt = this.now().toISOString();
    const plan = redditRoutes(request.target.url);
    if (!plan) {
      return this.failure(
        "unsupported_capability",
        request.target.url,
        startedAt,
        null,
        null,
        "adapter_boundary",
        "",
        [`${request.target.url} is not a public reddit.com listing URL.`],
      );
    }
    const causes: RouteFailure[] = [];
    const rss = await this.attemptRss(request, plan, startedAt, causes);
    if (rss) return rss;
    const json = await this.attemptJson(request, plan, startedAt, causes);
    if (json) return json;
    const html = await this.attemptHtml(request, plan, startedAt, causes);
    if (html) return html;
    const terminal = causes.at(-1)!;
    return this.failure(
      terminal.outcome,
      terminal.route,
      startedAt,
      terminal.status,
      terminal.contentType,
      terminal.parserStage,
      terminal.hash,
      causes.map((cause) => cause.cause),
      terminal.retryAfterMs,
      terminal.body,
    );
  }

  /**
   * Shared gate for every route: fetch (with persisted validators on RSS),
   * then turn 304/429/checkpoint matches into terminal results and every other
   * non-2xx status into a recorded cause that moves on to the next route.
   * Returns null when the route failed and collection should fall back.
   */
  private async fetchRoute(
    request: Parameters<SourceAdapter["collect"]>[0],
    url: string,
    startedAt: string,
    causes: RouteFailure[],
    conditional: { etag: string | null; lastModified: string | null } | null,
    parseStage: AdapterDiagnostic["parserStage"],
  ): Promise<RouteGateResult> {
    let response: PublicHttpResponse;
    try {
      response = await this.fetchText(url, {
        etag: conditional?.etag ?? null,
        lastModified: conditional?.lastModified ?? null,
      });
    } catch (error) {
      const timeout = error instanceof Error && error.name === "AbortError";
      causes.push(
        this.routeFailure(
          timeout ? "timeout" : "internal_failure",
          url,
          startedAt,
          null,
          null,
          "fetch",
          "",
          error instanceof Error ? error.message : String(error),
        ),
      );
      return { kind: "failed" };
    }
    if (response.status === 304) {
      return {
        kind: "completed",
        result: this.completed(
          "no_new_material",
          [],
          request.checkpoint,
          request.conditional ?? null,
          "conditional_request",
          response,
          startedAt,
          causes,
        ),
      };
    }
    if (response.status === 429) {
      return { kind: "completed", result: this.rateLimited(response, startedAt, causes) };
    }
    if (response.status < 200 || response.status >= 300) {
      causes.push(
        this.routeFailure(
          failedOutcome(response.status),
          response.url,
          startedAt,
          response.status,
          response.contentType,
          "fetch",
          responseHash(response.body),
          `HTTP ${response.status}`,
          undefined,
          response.body,
        ),
      );
      return { kind: "failed" };
    }
    const hash = responseHash(response.body);
    if (request.checkpoint === hash) {
      return {
        kind: "completed",
        result: this.completed(
          "no_new_material",
          [],
          request.checkpoint,
          { etag: response.etag, lastModified: response.lastModified },
          parseStage,
          response,
          startedAt,
          causes,
        ),
      };
    }
    return { kind: "ready", route: { response, hash } };
  }

  private async attemptRss(
    request: Parameters<SourceAdapter["collect"]>[0],
    plan: RoutePlan,
    startedAt: string,
    causes: RouteFailure[],
  ): Promise<SourceCollectionResult | null> {
    const gate = await this.fetchRoute(
      request,
      plan.rssUrl,
      startedAt,
      causes,
      {
        etag: request.conditional?.etag ?? null,
        lastModified: request.conditional?.lastModified ?? null,
      },
      "rss_parse",
    );
    if (gate.kind !== "ready") return gate.kind === "completed" ? gate.result : null;
    const { response, hash } = gate.route;
    let parsed;
    try {
      parsed = await this.parser.parseString(response.body);
    } catch (error) {
      causes.push(
        this.routeFailure(
          "response_shape_change",
          response.url,
          startedAt,
          response.status,
          response.contentType,
          "rss_parse",
          hash,
          error instanceof Error ? error.message : String(error),
          undefined,
          response.body,
        ),
      );
      return null;
    }
    const entries = parsed.items as FeedEntry[];
    if (entries.some((entry) => !entry.link)) {
      causes.push(
        this.routeFailure(
          "response_shape_change",
          response.url,
          startedAt,
          response.status,
          response.contentType,
          "rss_parse",
          hash,
          "Reddit's RSS feed carried entries without canonical links; the JSON route can recover them.",
          undefined,
          response.body,
        ),
      );
      return null;
    }
    const items = this.itemsFromRss(request, entries, response);
    return this.completed(
      this.outcome(items.length, request.checkpoint),
      items,
      hash,
      { etag: response.etag, lastModified: response.lastModified },
      "rss_parse",
      response,
      startedAt,
      causes,
    );
  }

  private async attemptJson(
    request: Parameters<SourceAdapter["collect"]>[0],
    plan: RoutePlan,
    startedAt: string,
    causes: RouteFailure[],
  ): Promise<SourceCollectionResult | null> {
    const gate = await this.fetchRoute(
      request,
      plan.jsonUrl,
      startedAt,
      causes,
      null,
      "reddit_json_parse",
    );
    if (gate.kind !== "ready") return gate.kind === "completed" ? gate.result : null;
    const { response, hash } = gate.route;
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body) as unknown;
    } catch (error) {
      causes.push(
        this.routeFailure(
          "response_shape_change",
          response.url,
          startedAt,
          response.status,
          response.contentType,
          "reddit_json_parse",
          hash,
          error instanceof Error ? error.message : String(error),
          undefined,
          response.body,
        ),
      );
      return null;
    }
    if (!isListing(parsed)) {
      causes.push(
        this.routeFailure(
          "response_shape_change",
          response.url,
          startedAt,
          response.status,
          response.contentType,
          "reddit_json_parse",
          hash,
          "Reddit's public JSON response no longer matches the Listing shape.",
          undefined,
          response.body,
        ),
      );
      return null;
    }
    const items = this.itemsFromJson(request, parsed.data.children, response);
    return this.completed(
      this.outcome(items.length, request.checkpoint),
      items,
      hash,
      { etag: response.etag, lastModified: response.lastModified },
      "reddit_json_parse",
      response,
      startedAt,
      causes,
    );
  }

  private async attemptHtml(
    request: Parameters<SourceAdapter["collect"]>[0],
    plan: RoutePlan,
    startedAt: string,
    causes: RouteFailure[],
  ): Promise<SourceCollectionResult | null> {
    const gate = await this.fetchRoute(
      request,
      plan.pageUrl,
      startedAt,
      causes,
      null,
      "reddit_html_parse",
    );
    if (gate.kind !== "ready") return gate.kind === "completed" ? gate.result : null;
    const { response, hash } = gate.route;
    const document = new JSDOM(response.body, { url: response.url }).window.document;
    const posts = [...document.querySelectorAll<Element>("shreddit-post")];
    if (!document.querySelector("shreddit-title") && posts.length === 0) {
      causes.push(
        this.routeFailure(
          "response_shape_change",
          response.url,
          startedAt,
          response.status,
          response.contentType,
          "reddit_html_parse",
          hash,
          "Reddit's public page no longer renders the shreddit post framework.",
          undefined,
          response.body,
        ),
      );
      return null;
    }
    if (posts.some((post) => !post.getAttribute("id"))) {
      causes.push(
        this.routeFailure(
          "response_shape_change",
          response.url,
          startedAt,
          response.status,
          response.contentType,
          "reddit_html_parse",
          hash,
          "A public post lacked a canonical Reddit identity.",
          undefined,
          response.body,
        ),
      );
      return null;
    }
    const items = this.itemsFromHtml(request, posts, response);
    return this.completed(
      this.outcome(items.length, request.checkpoint),
      items,
      hash,
      { etag: response.etag, lastModified: response.lastModified },
      "reddit_html_parse",
      response,
      startedAt,
      causes,
    );
  }

  private outcome(
    itemCount: number,
    checkpoint: string | null,
  ): "items_found" | "legitimate_empty" | "no_new_material" {
    return itemCount > 0 ? "items_found" : checkpoint ? "no_new_material" : "legitimate_empty";
  }

  private itemsFromRss(
    request: Parameters<SourceAdapter["collect"]>[0],
    entries: FeedEntry[],
    response: PublicHttpResponse,
  ): SourceItem[] {
    const since = Date.parse(request.since);
    const items: SourceItem[] = [];
    for (const entry of entries) {
      if (!entry.link) continue;
      const publishedAt = entry.isoDate ?? entry.pubDate ?? null;
      if (publishedAt && Date.parse(publishedAt) < since) continue;
      const url = canonicalUrl(new URL(entry.link, response.url).toString());
      const externalId = entry.id ?? url;
      const body = entry.contentSnippet ?? entry.content ?? entry.summary ?? null;
      items.push(
        this.sourceItem(request.target.id, response.url, {
          externalId,
          canonicalUrl: url,
          author: canonicalRedditAuthor(entry.author),
          title: entry.title ?? null,
          body,
          description: entry.contentSnippet ?? entry.summary ?? null,
          publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
        }),
      );
    }
    return items;
  }

  private itemsFromJson(
    request: Parameters<SourceAdapter["collect"]>[0],
    children: unknown[],
    response: PublicHttpResponse,
  ): SourceItem[] {
    const since = Date.parse(request.since);
    const items: SourceItem[] = [];
    for (const child of children) {
      if (!child || typeof child !== "object") continue;
      const record = (child as Record<string, unknown>).data;
      if (!record || typeof record !== "object") continue;
      const data = record as Record<string, unknown>;
      const externalId = canonicalRedditId(data.name ?? data.id, "t3");
      if (!externalId) continue;
      const permalink = stringValue(data.permalink);
      const rawUrl =
        stringValue(data.url) ?? (permalink ? `https://www.reddit.com${permalink}` : null);
      if (!rawUrl) continue;
      const url = canonicalUrl(new URL(rawUrl, response.url).toString());
      const seconds = epochSeconds(data.created_utc);
      const publishedAt = seconds !== null ? new Date(seconds * 1000).toISOString() : null;
      if (publishedAt && Date.parse(publishedAt) < since) continue;
      const title = stringValue(data.title) ?? null;
      const body = stringValue(data.selftext) ?? null;
      /* Reddit publishes a post's score and comment count on the JSON route.
         They are observed counts, so they are carried; the RSS and HTML routes
         expose neither and report no engagement rather than a zero. */
      const score = numberValue(data.score) ?? numberValue(data.ups);
      const commentCount = numberValue(data.num_comments);
      const engagement =
        score !== null || commentCount !== null
          ? {
              ...(score !== null ? { redditScore: score } : {}),
              ...(commentCount !== null ? { commentCount } : {}),
            }
          : undefined;
      items.push(
        this.sourceItem(request.target.id, response.url, {
          externalId,
          canonicalUrl: url,
          author: canonicalRedditAuthor(data.author),
          title,
          body,
          description: null,
          publishedAt,
          ...(engagement ? { engagement } : {}),
        }),
      );
    }
    return items;
  }

  private itemsFromHtml(
    request: Parameters<SourceAdapter["collect"]>[0],
    posts: Element[],
    response: PublicHttpResponse,
  ): SourceItem[] {
    const since = Date.parse(request.since);
    const items: SourceItem[] = [];
    for (const post of posts) {
      const externalId = stringValue(post.getAttribute("id"));
      if (!externalId) continue;
      const permalink =
        stringValue(post.getAttribute("permalink")) ??
        stringValue(post.getAttribute("content-href"));
      const rawUrl = permalink
        ? /^https?:/.test(permalink)
          ? permalink
          : `https://www.reddit.com${permalink.startsWith("/") ? "" : "/"}${permalink}`
        : null;
      if (!rawUrl) continue;
      const url = canonicalUrl(new URL(rawUrl, response.url).toString());
      const publishedAt = redditTimestamp(stringValue(post.getAttribute("created-timestamp")));
      if (publishedAt && Date.parse(publishedAt) < since) continue;
      const title = stringValue(post.getAttribute("post-title")) ?? null;
      const body = stringValue(post.textContent) ?? null;
      items.push(
        this.sourceItem(request.target.id, response.url, {
          externalId,
          canonicalUrl: url,
          author: canonicalRedditAuthor(stringValue(post.getAttribute("author"))),
          title,
          body,
          description: null,
          publishedAt,
        }),
      );
    }
    return items;
  }

  private sourceItem(
    targetId: string,
    evidenceRoute: string,
    fields: Pick<
      SourceItem,
      | "externalId"
      | "canonicalUrl"
      | "author"
      | "title"
      | "body"
      | "description"
      | "publishedAt"
      | "engagement"
    >,
  ): SourceItem {
    const retrievedAt = this.now().toISOString();
    return {
      id: `${targetId}:${fields.externalId}`,
      targetId,
      adapterId: this.id,
      ...fields,
      discoveredAt: retrievedAt,
      media: [],
      transcript: null,
      comments: [],
      evidence: [{ route: evidenceRoute, retrievedAt }],
      completeness: {
        title: fields.title ? "available" : "unavailable",
        body: fields.body ? "available" : "unavailable",
        description: fields.description ? "available" : "unavailable",
        transcript: "unsupported",
        comments: "unsupported",
        media: "unavailable",
      },
    };
  }

  private rateLimited(
    response: PublicHttpResponse,
    startedAt: string,
    causes: RouteFailure[],
  ): SourceCollectionResult {
    causes.push(
      this.routeFailure(
        "rate_limit",
        response.url,
        startedAt,
        response.status,
        response.contentType,
        "fetch",
        responseHash(response.body),
        `HTTP ${response.status}`,
        retryAfterMilliseconds(response.retryAfter, this.now()),
        response.body,
      ),
    );
    const terminal = causes.at(-1)!;
    return this.failure(
      terminal.outcome,
      terminal.route,
      startedAt,
      terminal.status,
      terminal.contentType,
      terminal.parserStage,
      terminal.hash,
      causes.map((cause) => cause.cause),
      terminal.retryAfterMs,
      terminal.body,
    );
  }

  private routeFailure(
    outcome: FailedOutcome,
    route: string,
    startedAt: string,
    status: number | null,
    contentType: string | null,
    parserStage: AdapterDiagnostic["parserStage"],
    hash: string,
    cause: string,
    retryAfterMs?: number,
    body?: string,
  ): RouteFailure {
    return {
      outcome,
      route,
      startedAt,
      status,
      contentType,
      parserStage,
      hash,
      cause,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(body === undefined ? {} : { body }),
    };
  }

  private completed(
    outcome: "items_found" | "legitimate_empty" | "no_new_material",
    items: SourceItem[],
    checkpoint: string | null,
    conditional: { etag: string | null; lastModified: string | null } | null,
    parserStage: AdapterDiagnostic["parserStage"],
    response: PublicHttpResponse,
    startedAt: string,
    causes: RouteFailure[],
  ): SourceCollectionResult {
    return {
      kind: "completed",
      outcome,
      items,
      checkpoint,
      conditional,
      diagnostic: {
        classification: outcome,
        route: response.url,
        status: response.status,
        contentType: response.contentType,
        parserStage,
        responseHash: responseHash(response.body),
        adapterVersion: this.version,
        startedAt,
        finishedAt: this.now().toISOString(),
        retries: 0,
        affectedCapabilities: [],
        causeChain: causes.map((cause) => cause.cause),
      },
    };
  }

  private failure(
    outcome: FailedOutcome,
    route: string,
    startedAt: string,
    status: number | null,
    contentType: string | null,
    parserStage: AdapterDiagnostic["parserStage"],
    hash: string,
    causeChain: string[],
    retryAfterMs?: number,
    body?: string,
  ): SourceCollectionResult {
    return {
      kind: "failed",
      outcome,
      items: [],
      checkpoint: null,
      ...(body
        ? { diagnosticBody: { contentType: contentType ?? "application/octet-stream", body } }
        : {}),
      diagnostic: {
        classification: outcome,
        route,
        status,
        contentType,
        parserStage,
        responseHash: hash,
        adapterVersion: this.version,
        startedAt,
        finishedAt: this.now().toISOString(),
        retries: 0,
        affectedCapabilities: ["items"],
        causeChain,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    };
  }
}
