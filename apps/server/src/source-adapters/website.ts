import { createHash } from "node:crypto";
import { load } from "cheerio";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type {
  AdapterDiagnostic,
  SourceAdapterCanaryTarget,
  SourceItem,
} from "@chief-of-staff-demo/shared";
import type { SourceAdapter, SourceCollectionResult } from "./source-adapter.js";
import type { BrowserRenderer, BrowserRenderResult } from "./browser.js";
import {
  canonicalUrl,
  publicHttpFetch,
  responseHash,
  retryAfterMilliseconds,
  type PublicHttpResponse,
  type PublicHttpFetch,
} from "./http.js";

export class WebsiteSourceAdapter implements SourceAdapter {
  readonly id = "website";
  readonly state = "available" as const;
  readonly version = "readability@0.6-browser-render@1";
  readonly canaryTargets: readonly SourceAdapterCanaryTarget[] = [
    { adapterId: "website", label: "Example", url: "https://example.com" },
    { adapterId: "website", label: "Mozilla", url: "https://www.mozilla.org/en-US/" },
    { adapterId: "website", label: "Wikipedia", url: "https://en.wikipedia.org/wiki/Main_Page" },
  ];

  constructor(
    private readonly fetchText: PublicHttpFetch = publicHttpFetch,
    private readonly now: () => Date = () => new Date(),
    private readonly renderBrowser: BrowserRenderer | null = null,
  ) {}

  supports(target: { adapterId: string }): boolean {
    return target.adapterId === this.id;
  }

  async collect(request: Parameters<SourceAdapter["collect"]>[0]): Promise<SourceCollectionResult> {
    const startedAt = this.now().toISOString();
    let response;
    try {
      response = await this.fetchText(request.target.url, {
        etag: request.conditional?.etag ?? null,
        lastModified: request.conditional?.lastModified ?? null,
      });
    } catch (error) {
      return this.failure(
        error instanceof Error && error.name === "AbortError" ? "timeout" : "internal_failure",
        request.target.url,
        startedAt,
        null,
        null,
        "fetch",
        "",
        [error instanceof Error ? error.message : String(error)],
      );
    }
    if (
      response.status === 304 ||
      (request.checkpoint && request.checkpoint === responseHash(response.body))
    ) {
      return this.completed(
        "no_new_material",
        [],
        request.checkpoint,
        response,
        "readability",
        startedAt,
      );
    }
    if (response.status === 401 || response.status === 403) {
      return this.failure(
        "blocked_access",
        response.url,
        startedAt,
        response.status,
        response.contentType,
        "fetch",
        responseHash(response.body),
        [`HTTP ${response.status}`],
        undefined,
        response.body,
      );
    }
    if (response.status === 429) {
      return this.failure(
        "rate_limit",
        response.url,
        startedAt,
        response.status,
        response.contentType,
        "fetch",
        responseHash(response.body),
        ["HTTP 429"],
        retryAfterMilliseconds(response.retryAfter, this.now()),
        response.body,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return this.failure(
        "internal_failure",
        response.url,
        startedAt,
        response.status,
        response.contentType,
        "fetch",
        responseHash(response.body),
        [`HTTP ${response.status}`],
        undefined,
        response.body,
      );
    }

    const parsed = this.parseArticle(request, response);
    if (parsed.article) {
      return this.completed(
        "items_found",
        [parsed.item],
        responseHash(response.body),
        response,
        "readability",
        startedAt,
      );
    }

    // Plain HTTP + Readability did not yield a meaningful public article. A
    // page with no visible static text is the classified JavaScript-rendering
    // need; only then is the bounded public browser fallback invoked. A static
    // page that simply fails to parse stays a readability parser failure.
    const staticText = new JSDOM(response.body).window.document.body.textContent.trim();
    if (staticText.length > 0 || !this.renderBrowser) {
      return this.failure(
        "parser_failure",
        response.url,
        startedAt,
        response.status,
        response.contentType,
        "readability",
        responseHash(response.body),
        ["No meaningful public article body was extracted."],
        undefined,
        response.body,
      );
    }

    let rendered: BrowserRenderResult;
    try {
      rendered = await this.renderBrowser(request.target.url);
    } catch (error) {
      return this.failure(
        error instanceof Error && error.name === "AbortError" ? "timeout" : "internal_failure",
        request.target.url,
        startedAt,
        null,
        "text/html",
        "browser_render",
        "",
        [error instanceof Error ? error.message : String(error)],
      );
    }
    const renderedResponse: PublicHttpResponse = {
      url: rendered.url,
      status: rendered.status,
      contentType: rendered.contentType,
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: rendered.body,
    };
    const renderedHash = responseHash(rendered.body);
    if (request.checkpoint && request.checkpoint === renderedHash) {
      return this.completed(
        "no_new_material",
        [],
        renderedHash,
        renderedResponse,
        "browser_render",
        startedAt,
      );
    }
    if (rendered.status === 401 || rendered.status === 403) {
      return this.failure(
        "blocked_access",
        rendered.url,
        startedAt,
        rendered.status,
        rendered.contentType,
        "browser_render",
        renderedHash,
        [`HTTP ${rendered.status}`],
        undefined,
        rendered.body,
      );
    }
    if (rendered.status === 429) {
      return this.failure(
        "rate_limit",
        rendered.url,
        startedAt,
        rendered.status,
        rendered.contentType,
        "browser_render",
        renderedHash,
        ["HTTP 429"],
        undefined,
        rendered.body,
      );
    }
    if (rendered.status < 200 || rendered.status >= 300) {
      return this.failure(
        "internal_failure",
        rendered.url,
        startedAt,
        rendered.status,
        rendered.contentType,
        "browser_render",
        renderedHash,
        [`HTTP ${rendered.status}`],
        undefined,
        rendered.body,
      );
    }
    const renderedParsed = this.parseArticle(request, renderedResponse);
    if (renderedParsed.article) {
      return this.completed(
        "items_found",
        [renderedParsed.item],
        renderedHash,
        renderedResponse,
        "browser_render",
        startedAt,
      );
    }
    const renderedText = new JSDOM(rendered.body).window.document.body.textContent.trim();
    if (renderedText.length === 0) {
      return this.completed(
        "legitimate_empty",
        [],
        renderedHash,
        renderedResponse,
        "browser_render",
        startedAt,
      );
    }
    return this.failure(
      "parser_failure",
      rendered.url,
      startedAt,
      renderedResponse.status,
      renderedResponse.contentType,
      "browser_render",
      renderedHash,
      ["No meaningful public article body was extracted."],
      undefined,
      rendered.body,
    );
  }

  private parseArticle(
    request: Parameters<SourceAdapter["collect"]>[0],
    response: PublicHttpResponse,
  ): { article: true; item: SourceItem } | { article: false } {
    const dom = new JSDOM(response.body, { url: response.url });
    const document = dom.window.document;
    const metadata = load(response.body);
    const canonical = new URL(
      metadata('link[rel="canonical"]').attr("href") ?? response.url,
      response.url,
    ).toString();
    const published =
      metadata('meta[property="article:published_time"], meta[name="date"]').attr("content") ??
      metadata("time[datetime]").attr("datetime") ??
      null;
    const article = new Readability(document.cloneNode(true) as Document).parse();
    const text = article?.textContent?.trim() ?? "";
    if (!article || text.length < 40) {
      return { article: false };
    }
    const url = canonicalUrl(canonical);
    const externalId = createHash("sha256").update(url).digest("hex").slice(0, 24);
    return {
      article: true,
      item: {
        id: `${request.target.id}:${externalId}`,
        externalId,
        targetId: request.target.id,
        adapterId: this.id,
        canonicalUrl: url,
        author: article.byline ?? null,
        title: article.title || document.title || null,
        body: text,
        description:
          article.excerpt ??
          document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ??
          null,
        publishedAt:
          published && !Number.isNaN(Date.parse(published))
            ? new Date(published).toISOString()
            : null,
        discoveredAt: this.now().toISOString(),
        media: [],
        transcript: null,
        comments: [],
        evidence: [{ route: response.url, retrievedAt: this.now().toISOString() }],
        completeness: {
          title: article.title || document.title ? "available" : "unavailable",
          body: "available",
          description: article.excerpt ? "available" : "unavailable",
          transcript: "unsupported",
          comments: "unsupported",
          media: "unavailable",
        },
      },
    };
  }

  private completed(
    outcome: "items_found" | "legitimate_empty" | "no_new_material",
    items: SourceItem[],
    checkpoint: string | null,
    response: PublicHttpResponse,
    parserStage: AdapterDiagnostic["parserStage"],
    startedAt: string,
  ): SourceCollectionResult {
    return {
      kind: "completed",
      outcome,
      items,
      checkpoint,
      conditional: { etag: response.etag, lastModified: response.lastModified },
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
        causeChain: [],
      },
    };
  }

  private failure(
    outcome: Extract<SourceCollectionResult, { kind: "failed" }>["outcome"],
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
        affectedCapabilities: ["body"],
        causeChain,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    };
  }
}
