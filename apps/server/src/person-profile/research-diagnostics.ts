import { randomUUID } from "node:crypto";
import { load } from "cheerio";
import type {
  PersonResearchAttempt,
  PersonResearchFailureCode,
  PersonResearchObservation,
  PersonResearchStage,
} from "@chief-of-staff-demo/shared";
import { sanitizeDiagnosticContentType } from "../source-adapters/diagnostics.js";
import { sanitizeModelBoundaryDiagnostic } from "../llm/failure.js";

/**
 * The version stamped onto every attempt this build records. Bump it when a
 * collector's observable behavior changes, so a stored failure can be read
 * against the implementation that produced it rather than against today's.
 */
const COLLECTOR_VERSIONS = {
  "public-search": "2026-09-06",
  "html-reader": "2026-09-06.1",
  "text-reader": "2026-09-06",
  "document-reader": "2026-09-06",
  "feed-reader": "2026-09-06",
  "caption-reader": "2026-09-06",
  "social-reader": "2026-09-06",
  "record-reader": "2026-09-06",
  "archive-reader": "2026-09-06",
  "browser-renderer": "2026-09-06",
  "workspace-transcript": "2026-09-06",
  extraction: "2026-09-06",
  planner: "2026-09-06",
  selection: "2026-09-06",
  publication: "2026-09-06",
} as const;
export type CollectorName = keyof typeof COLLECTOR_VERSIONS;

export interface RecordAttemptInput {
  stage: PersonResearchStage;
  code: PersonResearchFailureCode;
  outcome: PersonResearchAttempt["outcome"];
  recovery: PersonResearchAttempt["recovery"];
  cause: PersonResearchAttempt["cause"];
  target: string;
  targetKind: PersonResearchAttempt["targetKind"];
  collector: CollectorName;
  reason: string;
  /** Correlation id of the first attempt at this target; omitted starts one. */
  attemptOf?: string;
  attempt?: number;
  observed?: PersonResearchObservation;
  configuration?: Record<string, string>;
  impact?: string;
  remediation?: string;
  /** A suspected cause. Recorded as a hypothesis, never as an observation. */
  hypothesis?: string;
  recoveryStopped?: string;
  profileRevision?: number;
}

/**
 * The operation's attempt history.
 *
 * Everything the pipeline learns about a failure lands here once, in full.
 * Displays derive a slice from it (`summarizeResearchAttempts`); nothing
 * derives *instead* of it, so a display limit or a later error cannot erase
 * how a source actually failed.
 *
 * The recorder deliberately offers no way to state a cause the caller did not
 * observe: `hypothesis` is a separate field from `reason`, and `cause` records
 * which of the two the record rests on.
 */
export class ResearchAttemptRecorder {
  private readonly entries: PersonResearchAttempt[] = [];
  private readonly correlation = new Map<string, string>();

  constructor(
    private readonly operationId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The correlation id for a target, created on first sight. */
  correlate(target: string): string {
    const existing = this.correlation.get(target);
    if (existing) return existing;
    const id = randomUUID();
    this.correlation.set(target, id);
    return id;
  }

  /** How many attempts this operation has already made at one target. */
  attemptsAt(target: string): number {
    const id = this.correlation.get(target);
    return id ? this.entries.filter((entry) => entry.attemptOf === id).length : 0;
  }

  record(input: RecordAttemptInput): PersonResearchAttempt {
    const attemptOf = input.attemptOf ?? this.correlate(input.target);
    const entry: PersonResearchAttempt = {
      id: randomUUID(),
      operationId: this.operationId,
      attemptOf,
      attempt: input.attempt ?? this.entries.filter((e) => e.attemptOf === attemptOf).length + 1,
      stage: input.stage,
      code: input.code,
      outcome: input.outcome,
      recovery: input.recovery,
      cause: input.cause,
      target: sanitizeTarget(input.target, input.targetKind),
      targetKind: input.targetKind,
      collector: input.collector,
      collectorVersion: COLLECTOR_VERSIONS[input.collector],
      reason: sanitizeDiagnosticText(input.reason),
      occurredAt: this.now().toISOString(),
      ...(input.configuration ? { configuration: input.configuration } : {}),
      ...(input.observed ? { observed: sanitizeObservation(input.observed) } : {}),
      ...(input.impact ? { impact: sanitizeDiagnosticText(input.impact) } : {}),
      ...(input.remediation ? { remediation: sanitizeDiagnosticText(input.remediation) } : {}),
      ...(input.hypothesis ? { hypothesis: sanitizeDiagnosticText(input.hypothesis) } : {}),
      ...(input.recoveryStopped
        ? { recoveryStopped: sanitizeDiagnosticText(input.recoveryStopped) }
        : {}),
      ...(input.profileRevision !== undefined ? { profileRevision: input.profileRevision } : {}),
    };
    this.entries.push(entry);
    return entry;
  }

  all(): PersonResearchAttempt[] {
    return [...this.entries];
  }

  /** Attempts that ended without the work succeeding, in order. */
  failures(): PersonResearchAttempt[] {
    return this.entries.filter((entry) => entry.outcome === "failed");
  }

  countsByCode(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this.entries) counts[entry.code] = (counts[entry.code] ?? 0) + 1;
    return counts;
  }
}

/**
 * A public source URL a developer can paste into a browser to reproduce the
 * failure, with nothing that could carry a secret.
 *
 * Deliberately *not* the Source Adapter route sanitizer: that one hashes every
 * unrecognized path segment, which is right for an adapter's own account-shaped
 * routes and useless as a reproduction pointer for a public article. These
 * targets are public pages already retained as dossier sources, so the origin
 * and path survive; credentials, fragments and unrecognized query values do not.
 */
function sanitizeDiagnosticText(value: string, limit = 1000): string {
  return value.replace(/https?:\/\/[^\s<>"']+/gi, sanitizeResearchTarget).slice(0, limit);
}

function sanitizeResearchTarget(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return value.slice(0, 4000);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      const lowered = key.toLowerCase();
      if (/(key|token|secret|auth|session|password|signature|sig)$/.test(lowered))
        url.searchParams.set(key, "[redacted]");
    }
    return url.toString().slice(0, 4000);
  } catch {
    return value.slice(0, 4000);
  }
}

function sanitizeTarget(value: string, kind: PersonResearchAttempt["targetKind"]): string {
  if (kind === "query" || kind === "model" || kind === "profile")
    return sanitizeDiagnosticText(value, 4000);
  return sanitizeResearchTarget(value);
}

function sanitizeObservation(observed: PersonResearchObservation): PersonResearchObservation {
  return {
    ...observed,
    ...(observed.finalUrl ? { finalUrl: sanitizeResearchTarget(observed.finalUrl) } : {}),
    ...(observed.contentType !== undefined
      ? { contentType: sanitizeDiagnosticContentType(observed.contentType) }
      : {}),
    ...(observed.excerpt ? { excerpt: sanitizeDiagnosticText(observed.excerpt, 2000) } : {}),
    ...(observed.modelDiagnostic
      ? { modelDiagnostic: sanitizeDiagnosticText(observed.modelDiagnostic, 2000) }
      : {}),
    ...(observed.modelBoundary
      ? { modelBoundary: sanitizeModelBoundaryDiagnostic(observed.modelBoundary) }
      : {}),
  };
}

/**
 * Classify a thrown transport error into an observed code.
 *
 * Deliberately conservative: `fetch` rejections carry a cause chain that names
 * DNS and TLS explicitly, and everything else stays `transport-failed` with
 * `cause: "observed"` for the failure and no invented explanation of why.
 */
export function classifyTransportError(error: unknown): {
  code: PersonResearchFailureCode;
  reason: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const chain: string[] = [message];
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor instanceof Error && cursor.cause; depth += 1) {
    cursor = cursor.cause;
    if (cursor instanceof Error) chain.push(cursor.message);
    const code = (cursor as { code?: string } | null)?.code;
    if (typeof code === "string") chain.push(code);
  }
  const joined = chain.join(" ").toLowerCase();
  if (joined.includes("enotfound") || joined.includes("eai_again") || joined.includes("dns"))
    return { code: "dns-failed", reason: "Host name did not resolve." };
  if (
    joined.includes("cert") ||
    joined.includes("tls") ||
    joined.includes("ssl") ||
    joined.includes("err_ssl")
  )
    return { code: "tls-failed", reason: "The TLS handshake failed." };
  if (
    joined.includes("econnrefused") ||
    joined.includes("econnreset") ||
    joined.includes("ehostunreach") ||
    joined.includes("enetunreach") ||
    joined.includes("epipe")
  )
    return { code: "connectivity-failed", reason: "The connection could not be established." };
  if (joined.includes("abort") || joined.includes("timed out") || joined.includes("timeout"))
    return { code: "request-timeout", reason: "The request deadline expired." };
  return {
    code: "transport-failed",
    reason: "The transport rejected the request; the underlying cause was not observed.",
  };
}

/**
 * Classify an HTTP status into an observed access code.
 *
 * A 403 becomes `http-error`, never `login-required` or `challenge-page`: the
 * status alone establishes neither, and the body check below is what upgrades
 * it. This is the exact conflation the spec names.
 */
export function classifyHttpStatus(
  status: number,
  body: string,
  contentType: string | null,
): { code: PersonResearchFailureCode; reason: string; hypothesis?: string } {
  if (status === 429)
    return { code: "rate-limited", reason: `HTTP ${status}: the source rate-limited the request.` };
  if (status === 404 || status === 410)
    return { code: "resource-unavailable", reason: `HTTP ${status}: the resource is not present.` };
  const challenge = detectChallenge(body, contentType);
  if (challenge && (status === 403 || status === 401 || status === 503))
    return {
      code: challenge,
      reason:
        challenge === "login-required"
          ? `HTTP ${status} with a sign-in page in the body.`
          : `HTTP ${status} with a bot-challenge page in the body.`,
    };
  if (status === 401)
    return { code: "login-required", reason: `HTTP ${status}: the source demanded credentials.` };
  return {
    code: "http-error",
    reason: `HTTP ${status}. The status alone does not establish why access failed.`,
  };
}

/**
 * Look for the two access explanations a status cannot supply. Both need
 * positive evidence in the body; absence leaves the failure unexplained rather
 * than guessed.
 */
export function detectChallenge(
  body: string,
  contentType: string | null,
): "login-required" | "challenge-page" | null {
  if (contentType && !contentType.includes("html") && !contentType.startsWith("text/")) return null;
  const head = body.slice(0, 20000).toLowerCase();
  const document = load(head);
  document("script, style, template").remove();
  const visible = document.root().text().replace(/\s+/g, " ");
  // Editing widgets and configuration often mention captcha on otherwise public
  // articles (including Wikipedia). A token in source markup is not an access wall.
  if (
    head.includes("cf-challenge") ||
    head.includes("cf_chl") ||
    visible.includes("just a moment") ||
    visible.includes("enable javascript and cookies to continue") ||
    visible.includes("checking your browser") ||
    visible.includes("verify you are human") ||
    /\b(?:complete|solve|enter)(?:\s+\w+){0,5}\s+captcha\b/.test(visible) ||
    /^captcha(?: verification| challenge| required)?$/.test(document("title").text().trim())
  )
    return "challenge-page";
  if (
    visible.includes("sign in to continue") ||
    visible.includes("please log in") ||
    visible.includes("login required") ||
    document('[class~="authwall"], [id="authwall"]').length > 0 ||
    visible.includes("join linkedin to see")
  )
    return "login-required";
  return null;
}
