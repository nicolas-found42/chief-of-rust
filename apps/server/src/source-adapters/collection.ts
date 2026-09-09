import type {
  AdapterDiagnostic,
  SourceCollectionAttemptReceipt,
  SourceDiagnosticClassification,
  SourceTarget,
} from "@chief-of-staff-demo/shared";
import type { SourceAdapter, SourceCollectionResult } from "./source-adapter.js";

/**
 * The crawling core both collecting Modules share (ADR-0039): how many fetches
 * run at once, how often a retryable failure is retried, how a host name is
 * read off a Target, and how an absent adapter or a thrown adapter is turned
 * into an honest failed result. Content Scout and Content Research each own
 * their orchestration — per Source Target and per Named Person — but neither
 * owns these.
 */
export const COLLECTION_GLOBAL_CONCURRENCY = 4;
export const COLLECTION_MAX_ATTEMPTS = 3;
export const COLLECTION_DEFAULT_BACKOFF_MS = 500;

export const RETRYABLE_COLLECTION_OUTCOMES = new Set<SourceCollectionResult["outcome"]>([
  "rate_limit",
  "timeout",
  "internal_failure",
]);

/** Evidence records the origin a call went to, never its query string. */
function sanitizeRoute(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}/`;
  } catch {
    return "/";
  }
}

export type FailedOutcome = Exclude<
  SourceDiagnosticClassification,
  "items_found" | "legitimate_empty" | "no_new_material"
>;

/** A receipt whose diagnostic is always present — the shape attempts are written with. */
export type AttemptReceipt = Omit<SourceCollectionAttemptReceipt, "diagnostic"> & {
  diagnostic: AdapterDiagnostic;
};

export function hostOf(target: SourceTarget): string {
  try {
    return new URL(target.url).hostname.toLowerCase();
  } catch {
    return `invalid:${target.id}`;
  }
}

export function unavailableAdapter(target: SourceTarget): SourceAdapter {
  return {
    id: target.adapterId,
    state: "coming_later",
    version: "unknown",
    supports: () => false,
    async collect(): Promise<SourceCollectionResult> {
      throw new Error("unavailable");
    },
  };
}

export function failedResult(input: {
  target: SourceTarget;
  adapter: SourceAdapter;
  startedAt: string;
  finishedAt: string;
  outcome: FailedOutcome;
  cause: string;
}): SourceCollectionResult {
  return {
    kind: "failed",
    outcome: input.outcome,
    items: [],
    checkpoint: null,
    diagnostic: {
      classification: input.outcome,
      route: sanitizeRoute(input.target.url),
      status: null,
      contentType: null,
      parserStage: "fetch",
      responseHash: "",
      adapterVersion: input.adapter.version,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      retries: 0,
      affectedCapabilities: [],
      causeChain: [input.cause],
    },
  };
}

export async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      await work(items[current]!);
    }
  });
  await Promise.all(workers);
}
