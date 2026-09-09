import type {
  AdapterDiagnostic,
  SourceAdapterCanaryTarget,
  SourceDiagnosticClassification,
  SourceItem,
} from "@chief-of-staff-demo/shared";
import type {
  SourceAdapter,
  SourceCollectionResult,
} from "../../../source-adapters/source-adapter.js";
import { JSDOM } from "jsdom";
import type { BrowserRenderer } from "../../../source-adapters/browser.js";
import { responseHash } from "../../../source-adapters/http.js";

/**
 * LinkedIn Coming later evidence gate (issue #61).
 *
 * LinkedIn stays `coming_later` unless a clean anonymous public browser route
 * proves a useful Source Item contract through repeated canaries. The gate is
 * explicit and reviewable and never silently promotes the adapter.
 *
 * Canary route contract:
 * - Uses the shared `playwrightBrowserRenderer()` clean browser — a fresh
 *   anonymous headless Chromium context per request with no login, no imported
 *   cookies, no shared identity, no CAPTCHA bypass, and no proxy evasion.
 * - `blocked_access`, login-wall responses, empty shells, and
 *   `response_shape_change` are failed evidence, not successful empty.
 */

const LINKEDIN_ADAPTER_ID = "linkedin" as const;
const LINKEDIN_ADAPTER_VERSION = "linkedin-public-browser-v1" as const;

/** Gate requires at least three representative public targets. */
const LINKEDIN_MIN_REPRESENTATIVE_TARGETS = 3 as const;
/** Each representative target must have repeated useful results on the same version. */
const LINKEDIN_MIN_REPEATS_PER_TARGET = 2 as const;

/**
 * Representative public targets for the gate. These are the minimum diversity
 * the gate requires — company activity, second company/company, and a public
 * profile activity feed. A real canary run must exercise at least these three
 * distinct URLs (same adapter version) before promotion is reviewable.
 */
const LINKEDIN_REPRESENTATIVE_TARGETS: readonly string[] = [
  "https://www.linkedin.com/company/linkedin/posts/?feedView=all",
  "https://www.linkedin.com/company/microsoft/posts/?feedView=all",
  "https://www.linkedin.com/in/reidhoffman/recent-activity/all/",
] as const;

const LINKEDIN_CANARY_TARGETS: readonly SourceAdapterCanaryTarget[] = [
  { adapterId: LINKEDIN_ADAPTER_ID, label: "LinkedIn", url: LINKEDIN_REPRESENTATIVE_TARGETS[0]! },
  { adapterId: LINKEDIN_ADAPTER_ID, label: "Microsoft", url: LINKEDIN_REPRESENTATIVE_TARGETS[1]! },
  {
    adapterId: LINKEDIN_ADAPTER_ID,
    label: "Reid Hoffman",
    url: LINKEDIN_REPRESENTATIVE_TARGETS[2]!,
  },
];

/** One canary observation for the gate. Uses the shared diagnostic contract. */
export interface LinkedInCanaryEvidence {
  /** Representative Source Target URL that was exercised. */
  targetUrl: string;
  adapterVersion: string;
  outcome: SourceDiagnosticClassification;
  /** Number of normalized Source Items returned. */
  itemsFound: number;
  /** True when at least one item carries a useful title/body/description. */
  hasUsefulItem: boolean;
  observedAt: string;
  diagnostic: AdapterDiagnostic;
}

interface LinkedInEvidenceGatePassed {
  passed: true;
  adapterVersion: string;
  evidence: readonly LinkedInCanaryEvidence[];
  checkedAt: string;
  requiredTargets: typeof LINKEDIN_MIN_REPRESENTATIVE_TARGETS;
  repeatsPerTarget: typeof LINKEDIN_MIN_REPEATS_PER_TARGET;
  representativeTargets: readonly string[];
}

interface LinkedInEvidenceGateFailed {
  passed: false;
  reason: string;
  adapterVersion: string | null;
  evidence: readonly LinkedInCanaryEvidence[];
  checkedAt: string;
  requiredTargets: typeof LINKEDIN_MIN_REPRESENTATIVE_TARGETS;
  repeatsPerTarget: typeof LINKEDIN_MIN_REPEATS_PER_TARGET;
  representativeTargets: readonly string[];
}

export type LinkedInEvidenceGateResult = LinkedInEvidenceGatePassed | LinkedInEvidenceGateFailed;

/** Gate treats only `items_found` with a useful item as success. */
function isUsefulLinkedInEvidence(evidence: LinkedInCanaryEvidence): boolean {
  return evidence.outcome === "items_found" && evidence.hasUsefulItem && evidence.itemsFound > 0;
}

/**
 * Explicit, reviewable gate evaluation. Reuses the shared diagnostic
 * vocabulary: `blocked_access`, `response_shape_change`, empty shells, login
 * walls and timeouts are failed evidence, not successful empty.
 *
 * Requirements:
 * - at least `LINKEDIN_MIN_REPRESENTATIVE_TARGETS` distinct targetUrls
 * - at least `LINKEDIN_MIN_REPEATS_PER_TARGET` useful successes per target
 * - every record carries the same `adapterVersion` (no version drift)
 * - `legitimate_empty`, `no_new_material`, `blocked_access`,
 *   `response_shape_change`, etc. never count as useful
 *
 * A passed gate does NOT promote the adapter; promotion remains an explicit
 * human decision. A failed gate carries a human-readable `reason` so Content
 * Scout can record why LinkedIn stays Coming later.
 */
export function evaluateLinkedInEvidenceGate(
  evidences: readonly LinkedInCanaryEvidence[],
  now: () => Date = () => new Date(),
): LinkedInEvidenceGateResult {
  const checkedAt = now().toISOString();

  if (evidences.length === 0) {
    return {
      passed: false,
      reason:
        "No LinkedIn canary evidence has been recorded yet. The gate requires repeated useful results across at least three representative public targets on the same adapter version using a clean public browser with no login, imported cookies, shared identity, CAPTCHA bypass, or proxy evasion.",
      adapterVersion: null,
      evidence: [],
      checkedAt,
      requiredTargets: LINKEDIN_MIN_REPRESENTATIVE_TARGETS,
      repeatsPerTarget: LINKEDIN_MIN_REPEATS_PER_TARGET,
      representativeTargets: LINKEDIN_REPRESENTATIVE_TARGETS,
    };
  }

  const versions = new Set(evidences.map((entry) => entry.adapterVersion));
  if (versions.size !== 1) {
    return {
      passed: false,
      reason: `LinkedIn canary evidence spans ${versions.size} adapter versions (${[...versions].join(", ")}). The gate requires every canary to carry the same adapter version (${LINKEDIN_ADAPTER_VERSION}) so a single version is proven, not a mix.`,
      adapterVersion: null,
      evidence: evidences,
      checkedAt,
      requiredTargets: LINKEDIN_MIN_REPRESENTATIVE_TARGETS,
      repeatsPerTarget: LINKEDIN_MIN_REPEATS_PER_TARGET,
      representativeTargets: LINKEDIN_REPRESENTATIVE_TARGETS,
    };
  }

  const adapterVersion = [...versions][0]!;
  if (adapterVersion !== LINKEDIN_ADAPTER_VERSION) {
    return {
      passed: false,
      reason: `LinkedIn canary evidence is for stale adapter version ${adapterVersion}. The gate requires ${LINKEDIN_ADAPTER_VERSION}.`,
      adapterVersion,
      evidence: evidences,
      checkedAt,
      requiredTargets: LINKEDIN_MIN_REPRESENTATIVE_TARGETS,
      repeatsPerTarget: LINKEDIN_MIN_REPEATS_PER_TARGET,
      representativeTargets: LINKEDIN_REPRESENTATIVE_TARGETS,
    };
  }

  // Group useful successes by canonicalized target URL.
  const usefulByTarget = new Map<string, LinkedInCanaryEvidence[]>();
  for (const entry of evidences) {
    if (!isUsefulLinkedInEvidence(entry)) continue;
    const key = entry.targetUrl.trim();
    if (!LINKEDIN_REPRESENTATIVE_TARGETS.includes(key)) continue;
    const list = usefulByTarget.get(key) ?? [];
    list.push(entry);
    usefulByTarget.set(key, list);
  }

  const qualifyingTargets = [...usefulByTarget.entries()].filter(
    ([, list]) => list.length >= LINKEDIN_MIN_REPEATS_PER_TARGET,
  );

  if (qualifyingTargets.length < LINKEDIN_MIN_REPRESENTATIVE_TARGETS) {
    const failedClassifications = evidences
      .filter((entry) => !isUsefulLinkedInEvidence(entry))
      .map((entry) => `${entry.targetUrl} → ${entry.outcome}`)
      .slice(0, 8)
      .join("; ");

    const counts = [...usefulByTarget.entries()]
      .map(([url, list]) => `${url} (${list.length}/${LINKEDIN_MIN_REPEATS_PER_TARGET} repeats)`)
      .join("; ");

    const base =
      `LinkedIn evidence gate unmet: ${qualifyingTargets.length}/${LINKEDIN_MIN_REPRESENTATIVE_TARGETS} representative targets have ≥${LINKEDIN_MIN_REPEATS_PER_TARGET} useful canaries on ${adapterVersion}. ` +
      `Blocked access, login walls, empty shells, and response-shape changes are failed evidence, not successful empty.`;

    const detail = [
      counts ? `Useful per target: ${counts}.` : "No useful canary evidence yet.",
      failedClassifications ? `Failed (not useful): ${failedClassifications}.` : "",
      `Required: ${LINKEDIN_MIN_REPRESENTATIVE_TARGETS} distinct targets × ${LINKEDIN_MIN_REPEATS_PER_TARGET} repeats with the same adapter version.`,
    ]
      .filter(Boolean)
      .join(" ");

    return {
      passed: false,
      reason: `${base} ${detail}`.trim(),
      adapterVersion,
      evidence: evidences,
      checkedAt,
      requiredTargets: LINKEDIN_MIN_REPRESENTATIVE_TARGETS,
      repeatsPerTarget: LINKEDIN_MIN_REPEATS_PER_TARGET,
      representativeTargets: LINKEDIN_REPRESENTATIVE_TARGETS,
    };
  }

  return {
    passed: true,
    adapterVersion,
    evidence: evidences,
    checkedAt,
    requiredTargets: LINKEDIN_MIN_REPRESENTATIVE_TARGETS,
    repeatsPerTarget: LINKEDIN_MIN_REPEATS_PER_TARGET,
    representativeTargets: LINKEDIN_REPRESENTATIVE_TARGETS,
  };
}
/**
 * Honest Coming later adapter. Its version is the gate's version so that
 * future canaries and the gate agree, but its state never leaves
 * `coming_later` implicitly. A passed `evaluateLinkedInEvidenceGate` does
 * not mutate this adapter; promotion is a separate explicit, reviewable
 * change.
 *
 * Any future collection route for this adapter MUST use a clean public
 * browser (`playwrightBrowserRenderer`) with no login, imported cookies,
 * shared identity, CAPTCHA bypass, or proxy evasion — exactly the
 * `apps/server/src/source-adapters/browser.ts` contract.
 */
export class LinkedInComingLaterAdapter implements SourceAdapter {
  readonly id = LINKEDIN_ADAPTER_ID;
  readonly version = LINKEDIN_ADAPTER_VERSION;
  readonly state = "coming_later" as const;
  readonly canaryTargets = LINKEDIN_CANARY_TARGETS;

  constructor(
    private readonly renderBrowser: BrowserRenderer | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  supports(target: { adapterId: string }): boolean {
    return target.adapterId === this.id;
  }

  async collect(): Promise<SourceCollectionResult> {
    throw new Error(
      `${LINKEDIN_ADAPTER_ID} is Coming later and cannot collect Source Targets. ` +
        `The evidence gate requires repeated useful results across at least ${LINKEDIN_MIN_REPRESENTATIVE_TARGETS} representative public targets on ${LINKEDIN_ADAPTER_VERSION} via a clean public browser. ` +
        `Blocked access, login walls, empty shells, and response-shape changes count as failed evidence, not successful empty. ` +
        `A passed gate is explicit and reviewable and does not silently promote.`,
    );
  }

  async collectCanary(
    request: Parameters<SourceAdapter["collect"]>[0],
  ): Promise<SourceCollectionResult> {
    const startedAt = this.now().toISOString();
    if (!this.renderBrowser) {
      return this.failure(
        "internal_failure",
        request.target.url,
        startedAt,
        null,
        "adapter_boundary",
        "",
        ["The clean public browser renderer is unavailable."],
      );
    }
    let response;
    try {
      response = await this.renderBrowser(request.target.url);
    } catch (error) {
      return this.failure(
        error instanceof Error && error.name === "AbortError" ? "timeout" : "internal_failure",
        request.target.url,
        startedAt,
        null,
        "browser_render",
        "",
        [error instanceof Error ? error.message : String(error)],
      );
    }
    const hash = responseHash(response.body);
    if (response.status === 401 || response.status === 403) {
      return this.failure(
        "blocked_access",
        response.url,
        startedAt,
        response.status,
        "browser_render",
        hash,
        [`HTTP ${response.status}`],
      );
    }
    if (response.status === 429) {
      return this.failure(
        "rate_limit",
        response.url,
        startedAt,
        response.status,
        "browser_render",
        hash,
        ["HTTP 429"],
      );
    }
    if (
      /\/authwall|\/login|\/signup/i.test(new URL(response.url).pathname) ||
      /authwall|login-form|sign in to linkedin|join linkedin|log in or sign up|sign up to linkedin|linkedin login|challenge-page/i.test(
        response.body,
      )
    ) {
      return this.failure(
        "blocked_access",
        response.url,
        startedAt,
        response.status,
        "browser_render",
        hash,
        ["LinkedIn returned a login wall instead of anonymous public evidence."],
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return this.failure(
        "internal_failure",
        response.url,
        startedAt,
        response.status,
        "browser_render",
        hash,
        [`HTTP ${response.status}`],
      );
    }
    const document = new JSDOM(response.body, { url: response.url }).window.document;
    const meta = (selector: string) =>
      document.querySelector<HTMLMetaElement>(selector)?.content.trim() || null;
    const title = meta('meta[property="og:title"]') ?? (document.title.trim() || null);
    const description = meta('meta[property="og:description"]');
    const body =
      description ?? document.querySelector<HTMLElement>("main")?.textContent.trim() ?? null;
    if (!title || !body || body.length < 40) {
      return this.failure(
        "response_shape_change",
        response.url,
        startedAt,
        response.status,
        "public_embedded_data",
        hash,
        ["The anonymous page did not expose a useful public title and body contract."],
      );
    }
    const externalId = hash.slice(0, 24);
    const discoveredAt = this.now().toISOString();
    const item: SourceItem = {
      id: `${request.target.id}:${externalId}`,
      externalId,
      targetId: request.target.id,
      adapterId: this.id,
      canonicalUrl: response.url,
      author: title,
      title,
      body,
      description,
      publishedAt: null,
      discoveredAt,
      media: [],
      transcript: null,
      comments: [],
      evidence: [{ route: response.url, retrievedAt: discoveredAt }],
      completeness: {
        title: "available",
        body: "available",
        description: description ? "available" : "unavailable",
        transcript: "unsupported",
        comments: "unsupported",
        media: "unavailable",
      },
    };
    return {
      kind: "completed",
      outcome: "items_found",
      items: [item],
      checkpoint: hash,
      diagnostic: this.diagnostic(
        "items_found",
        response.url,
        startedAt,
        response.status,
        "public_embedded_data",
        hash,
        [],
      ),
    };
  }

  private diagnostic(
    classification: AdapterDiagnostic["classification"],
    route: string,
    startedAt: string,
    status: number | null,
    parserStage: AdapterDiagnostic["parserStage"],
    hash: string,
    causeChain: string[],
  ): AdapterDiagnostic {
    return {
      classification,
      route,
      status,
      contentType: "text/html",
      parserStage,
      responseHash: hash,
      adapterVersion: this.version,
      startedAt,
      finishedAt: this.now().toISOString(),
      retries: 0,
      affectedCapabilities: classification === "items_found" ? [] : ["items"],
      causeChain,
    };
  }

  private failure(
    outcome: Extract<SourceCollectionResult, { kind: "failed" }>["outcome"],
    route: string,
    startedAt: string,
    status: number | null,
    parserStage: AdapterDiagnostic["parserStage"],
    hash: string,
    causeChain: string[],
  ): SourceCollectionResult {
    return {
      kind: "failed",
      outcome,
      items: [],
      checkpoint: null,
      diagnostic: this.diagnostic(outcome, route, startedAt, status, parserStage, hash, causeChain),
    };
  }
}
