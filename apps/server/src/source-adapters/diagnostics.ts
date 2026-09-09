import { createHash } from "node:crypto";
import {
  SOURCE_CAPABILITIES,
  SOURCE_DIAGNOSTIC_CLASSIFICATIONS,
  SOURCE_PARSER_STAGES,
  type AdapterDiagnostic,
  type SourceCapability,
  type SourceDiagnosticClassification,
  type SourceParserStage,
} from "@chief-of-staff-demo/shared";

const SAFE_ROUTE_SEGMENTS = new Set([
  "api",
  "channel",
  "channels",
  "feed",
  "feeds",
  "json",
  "playlist",
  "playlists",
  "posts",
  "rss",
  "search",
  "v1",
  "v2",
  "v3",
  "videos",
  "xml",
]);
const SAFE_QUERY_KEYS = new Set([
  "channel",
  "feed",
  "format",
  "language",
  "limit",
  "order",
  "page",
  "q",
  "query",
  "search",
  "since",
  "sort",
  "topic",
  "type",
  "until",
]);
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeAdapterVersion(value: string): string {
  return value.replace(/[^A-Za-z0-9.@_-]/g, "_").slice(0, 80) || "unknown";
}

function safeTimestamp(value: unknown): string {
  if (typeof value !== "string") return "invalid";
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : "invalid";
}

function safeClassification(value: unknown): SourceDiagnosticClassification {
  return typeof value === "string" &&
    SOURCE_DIAGNOSTIC_CLASSIFICATIONS.includes(value as SourceDiagnosticClassification)
    ? (value as SourceDiagnosticClassification)
    : "internal_failure";
}

export function sanitizeDiagnosticContentType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType) ? mediaType : null;
}

/** Keep a public origin and an allowlisted route template without retaining route values. */
export function sanitizeDiagnosticRoute(value: unknown): string {
  if (typeof value !== "string") return "[invalid-route]";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return `[redacted-route;sha256:${sha256(value)}]`;
    }
    const routePath = url.pathname
      .split("/")
      .map((segment) => {
        if (!segment) return "";
        const normalized = segment.toLowerCase();
        if (SAFE_ROUTE_SEGMENTS.has(normalized)) return normalized;
        return `[segment;sha256:${sha256(segment).slice(0, 12)}]`;
      })
      .join("/");
    const queryKeys = [...url.searchParams.keys()].map((key) =>
      SAFE_QUERY_KEYS.has(key.toLowerCase()) ? key.toLowerCase() : "redacted",
    );
    const query = queryKeys.length > 0 ? `?${queryKeys.map((key) => `${key}=`).join("&")}` : "";
    return `${url.origin}${routePath || "/"}${query}`;
  } catch {
    return `[redacted-route;sha256:${sha256(value)}]`;
  }
}

function causeCode(
  cause: unknown,
  classification: SourceDiagnosticClassification,
  parserStage: SourceParserStage,
  status: number | null,
): string {
  const text = typeof cause === "string" ? cause : String(cause);
  if (/authorization|bearer|cookie|password|api[-_ ]?key|token|secret/i.test(text)) {
    return "credential_material_redacted";
  }
  if (/private response|response (?:body|excerpt)|account-specific excerpt/i.test(text)) {
    return "private_response_redacted";
  }
  if (/\b(?:enotfound|eai_again|dns|getaddrinfo)\b/i.test(text)) return "dns_lookup_failed";
  if (/\b(?:econnrefused|connection refused)\b/i.test(text)) return "connection_refused";
  if (/\b(?:certificate|ssl|tls)\b/i.test(text)) return "tls_verification_failed";
  if (/\b(?:abort|timed? out|timeout)\b/i.test(text)) return "request_timed_out";
  if (status !== null && /\bhttp\s+\d{3}\b/i.test(text)) return `http_status_${status}`;
  if (/json-ld|opengraph|public .* (?:data|evidence)/i.test(text)) {
    return "expected_public_evidence_missing";
  }
  if (/uploads playlist|platform resource/i.test(text)) {
    return "expected_platform_resource_missing";
  }
  if (/no meaningful|nothing .* extracted|empty .* extracted/i.test(text)) {
    return "parsed_content_empty";
  }
  if (/\b(?:parse|parser|syntax|schema|shape|json|xml)\b/i.test(text)) {
    return "response_parse_failed";
  }
  return `${classification}_at_${parserStage}`;
}

/** Persist an allowlisted receipt object; undeclared runtime fields cannot cross this boundary. */
export function sanitizeAdapterDiagnostic(
  diagnostic: AdapterDiagnostic,
  trustedAdapterVersion: string,
): AdapterDiagnostic {
  const classification = safeClassification(diagnostic.classification);
  const parserStage: SourceParserStage = SOURCE_PARSER_STAGES.includes(diagnostic.parserStage)
    ? diagnostic.parserStage
    : "unknown_stage";
  const status =
    Number.isInteger(diagnostic.status) && diagnostic.status! >= 100 && diagnostic.status! <= 599
      ? diagnostic.status
      : null;
  const sanitized: AdapterDiagnostic = {
    classification,
    route: sanitizeDiagnosticRoute(diagnostic.route),
    status,
    contentType: sanitizeDiagnosticContentType(diagnostic.contentType),
    parserStage,
    responseHash: diagnostic.responseHash ? sha256(diagnostic.responseHash) : "",
    adapterVersion: safeAdapterVersion(trustedAdapterVersion),
    startedAt: safeTimestamp(diagnostic.startedAt),
    finishedAt: safeTimestamp(diagnostic.finishedAt),
    retries:
      Number.isInteger(diagnostic.retries) && diagnostic.retries >= 0 ? diagnostic.retries : 0,
    affectedCapabilities: [
      ...new Set(
        (Array.isArray(diagnostic.affectedCapabilities) ? diagnostic.affectedCapabilities : []).map(
          (capability): SourceCapability =>
            SOURCE_CAPABILITIES.includes(capability) ? capability : "unknown_capability",
        ),
      ),
    ],
    causeChain: (Array.isArray(diagnostic.causeChain) ? diagnostic.causeChain : []).map(
      (cause, index) =>
        `${causeCode(cause, classification, parserStage, status)} (cause ${index + 1}, sha256:${sha256(String(cause))})`,
    ),
  };
  if (
    typeof diagnostic.retryAfterMs === "number" &&
    Number.isFinite(diagnostic.retryAfterMs) &&
    diagnostic.retryAfterMs >= 0
  ) {
    sanitized.retryAfterMs = diagnostic.retryAfterMs;
  }
  return sanitized;
}

/** Raw public responses are represented by non-reversible metadata, never retained verbatim. */
export function sanitizeDiagnosticBody(body: string): string {
  return `[response body omitted; bytes:${Buffer.byteLength(body, "utf8")}; sha256:${sha256(body)}]`;
}
