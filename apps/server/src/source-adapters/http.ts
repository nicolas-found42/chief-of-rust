import { createHash } from "node:crypto";
import { isIP } from "node:net";

export interface PublicHttpResponse {
  url: string;
  status: number;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  retryAfter: string | null;
  body: string;
}

export type PublicHttpFetch = (
  url: string,
  options?: {
    etag?: string | null;
    lastModified?: string | null;
    timeoutMs?: number;
    method?: "POST";
    body?: string;
    /**
     * Override the accept header for one request. Several public record APIs
     * serve JSON only when asked for it and answer XML, 406 or 500 to the
     * default HTML-first list.
     */
    accept?: string;
  },
) => Promise<PublicHttpResponse>;
/** A stable browser-like UA for the documented HTML-scrape exceptions
 * (duckduckgo, mojeek — see docs/research/anti-bot-keyless-search.md). API
 * surfaces keep the descriptive default UA below. */
export const browserUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function privateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

export function assertPublicHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Source Targets must use public HTTP or HTTPS URLs.");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    privateIpv4(hostname) ||
    (isIP(hostname) === 6 &&
      (hostname === "::1" ||
        hostname.startsWith("fc") ||
        hostname.startsWith("fd") ||
        hostname.startsWith("fe80")))
  ) {
    throw new Error("Source Targets must resolve to a public host.");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

/**
 * The transports public collection and search fetch through. The default is
 * the guarded, 20-second, shared-UA fetch everything used while there was one
 * route; the options exist because the provider bundle (ADR-0049) needs
 * variants the guard cannot express — a declared contact UA (SEC EDGAR 403s
 * generic agents), an unguarded fetch for a fixed self-hosted SearXNG URL,
 * and longer deadlines for sources that answer slowly. A single request may
 * still override the deadline through `timeoutMs`.
 */
export function createHttpFetch(
  options: { timeoutMs?: number; headers?: Record<string, string>; guarded?: boolean } = {},
): PublicHttpFetch {
  const defaultTimeoutMs = options.timeoutMs ?? 20_000;
  const guarded = options.guarded ?? true;
  return async (value, perCall = {}) => {
    const url = guarded ? assertPublicHttpUrl(value) : new URL(value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perCall.timeoutMs ?? defaultTimeoutMs);
    try {
      const headers: Record<string, string> = {
        accept:
          "text/html, application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9",
        "user-agent": "Found42-Content-Scout/1.0 (+public-source-monitor)",
        ...options.headers,
      };
      if (perCall.accept) headers.accept = perCall.accept;
      if (perCall.etag) headers["if-none-match"] = perCall.etag;
      if (perCall.lastModified) headers["if-modified-since"] = perCall.lastModified;
      const response = await fetch(url, {
        ...(perCall.method !== undefined ? { method: perCall.method } : {}),
        ...(perCall.body !== undefined ? { body: perCall.body } : {}),
        headers: perCall.body
          ? { ...headers, "content-type": "application/x-www-form-urlencoded" }
          : headers,
        redirect: "follow",
        signal: controller.signal,
        credentials: "omit",
      });
      const body = await response.text();
      if (body.length > 5_000_000) {
        throw new Error("Source response exceeded the 5 MB collection limit.");
      }
      return {
        url: response.url || url.toString(),
        status: response.status,
        contentType: response.headers.get("content-type"),
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        retryAfter: response.headers.get("retry-after"),
        body,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export const publicHttpFetch: PublicHttpFetch = createHttpFetch();

export interface PublicHttpBytesResponse {
  url: string;
  status: number;
  contentType: string | null;
  retryAfter: string | null;
  bytes: Buffer;
}

export type PublicHttpBytesFetch = (
  url: string,
  options?: { timeoutMs?: number; accept?: string },
) => Promise<PublicHttpBytesResponse>;

/**
 * The same guarded anonymous transport, kept as bytes.
 *
 * Person research reads PDFs, scans and slide decks, and `PublicHttpFetch`
 * decodes every body as UTF-8 — which silently destroys exactly those. This is
 * the byte-preserving twin rather than a second transport policy: same public
 * URL guard, same anonymous credentials-omitted request, same 5 MB ceiling.
 */
function createHttpBytesFetch(
  options: { timeoutMs?: number; headers?: Record<string, string> } = {},
): PublicHttpBytesFetch {
  const defaultTimeoutMs = options.timeoutMs ?? 20_000;
  return async (value, perCall = {}) => {
    const url = assertPublicHttpUrl(value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perCall.timeoutMs ?? defaultTimeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          accept: perCall.accept ?? "application/pdf, application/octet-stream, */*;q=0.8",
          "user-agent": "Found42-Content-Scout/1.0 (+public-source-monitor)",
          ...options.headers,
        },
        redirect: "follow",
        signal: controller.signal,
        credentials: "omit",
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > 5_000_000)
        throw new Error("Source response exceeded the 5 MB collection limit.");
      return {
        url: response.url || url.toString(),
        status: response.status,
        contentType: response.headers.get("content-type"),
        retryAfter: response.headers.get("retry-after"),
        bytes,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export const publicHttpFetchBytes: PublicHttpBytesFetch = createHttpBytesFetch();

export function retryAfterMilliseconds(value: string | null, now: Date): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now.getTime()) : undefined;
}

export function responseHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}
