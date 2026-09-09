import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import type { AdapterDiagnostic, SourceItem } from "@chief-of-staff-demo/shared";
import type {
  SourceAdapter,
  SourceCollectionResult,
} from "../../../source-adapters/source-adapter.js";
import {
  canonicalUrl,
  publicHttpFetch,
  responseHash,
  retryAfterMilliseconds,
  type PublicHttpResponse,
  type PublicHttpFetch,
} from "../../../source-adapters/http.js";

type Platform = "instagram";

/**
 * A deliberately Experimental anonymous public-page route. It extracts only
 * explicit JSON-LD/OpenGraph post evidence and never imports cookies or opens
 * an authenticated browser. Missing embedded items is a shape failure, not an
 * empty success, because these platforms do not promise this page contract.
 */
export class ExperimentalPublicPageAdapter implements SourceAdapter {
  readonly state = "experimental" as const;
  readonly version = "public-page-jsonld-v1";

  constructor(
    readonly id: Platform,
    private readonly fetchText: PublicHttpFetch = publicHttpFetch,
    private readonly now: () => Date = () => new Date(),
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
    if (response.status === 401 || response.status === 403)
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
    if (response.status === 429)
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
    if (response.status < 200 || response.status >= 300)
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

    const hash = responseHash(response.body);
    if (request.checkpoint === hash) {
      return this.completed("no_new_material", [], hash, response, startedAt);
    }
    const document = new JSDOM(response.body, { url: response.url }).window.document;
    const records = [
      ...document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'),
    ].flatMap((script) => parseJsonLd(script.textContent));
    const metaDescription =
      document.querySelector<HTMLMetaElement>(
        'meta[property="og:description"], meta[name="description"]',
      )?.content ?? null;
    const metaTitle =
      document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ||
      document.title ||
      null;
    const metaUrl =
      document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content ?? response.url;
    const candidates =
      records.length > 0
        ? records
        : metaDescription
          ? [{ url: metaUrl, headline: metaTitle, description: metaDescription }]
          : [];
    if (candidates.length === 0) {
      return this.failure(
        "response_shape_change",
        response.url,
        startedAt,
        response.status,
        response.contentType,
        "public_embedded_data",
        hash,
        ["No public JSON-LD or OpenGraph post evidence was present."],
        undefined,
        response.body,
      );
    }
    const since = Date.parse(request.since);
    const items = candidates.flatMap((record): SourceItem[] => {
      const valueUrl = typeof record.url === "string" ? record.url : response.url;
      const url = canonicalUrl(new URL(valueUrl, response.url).toString());
      const publishedRaw = typeof record.datePublished === "string" ? record.datePublished : null;
      const publishedAt =
        publishedRaw && !Number.isNaN(Date.parse(publishedRaw))
          ? new Date(publishedRaw).toISOString()
          : null;
      if (publishedAt && Date.parse(publishedAt) < since) return [];
      const body =
        stringValue(record.articleBody) ??
        stringValue(record.caption) ??
        stringValue(record.description);
      const title = stringValue(record.headline) ?? stringValue(record.name);
      const externalId =
        stringValue(record.identifier) ??
        createHash("sha256").update(url).digest("hex").slice(0, 24);
      return [
        {
          id: `${request.target.id}:${externalId}`,
          externalId,
          targetId: request.target.id,
          adapterId: this.id,
          canonicalUrl: url,
          author: authorName(record.author),
          title,
          body,
          description: stringValue(record.description),
          publishedAt,
          discoveredAt: this.now().toISOString(),
          media: [],
          transcript: null,
          comments: [],
          evidence: [{ route: response.url, retrievedAt: this.now().toISOString() }],
          completeness: {
            title: title ? "available" : "unavailable",
            body: body ? "available" : "unavailable",
            description: stringValue(record.description) ? "available" : "unavailable",
            transcript: "unavailable",
            comments: "unavailable",
            media: "unavailable",
          },
        },
      ];
    });
    return this.completed(
      items.length > 0 ? "items_found" : "legitimate_empty",
      items,
      hash,
      response,
      startedAt,
    );
  }

  private completed(
    outcome: "items_found" | "legitimate_empty" | "no_new_material",
    items: SourceItem[],
    checkpoint: string,
    response: PublicHttpResponse,
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
        parserStage: "public_embedded_data",
        responseHash: responseHash(response.body),
        adapterVersion: this.version,
        startedAt,
        finishedAt: this.now().toISOString(),
        retries: 0,
        affectedCapabilities: ["transcript", "comments"],
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
        affectedCapabilities: ["items", "transcript", "comments"],
        causeChain,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    };
  }
}

function parseJsonLd(raw: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const record = value as Record<string, unknown>;
      const graph = Array.isArray(record["@graph"]) ? record["@graph"] : null;
      return graph
        ? graph.filter(
            (item): item is Record<string, unknown> => !!item && typeof item === "object",
          )
        : [record];
    });
  } catch {
    return [];
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function authorName(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object")
    return stringValue((value as Record<string, unknown>).name);
  return null;
}
