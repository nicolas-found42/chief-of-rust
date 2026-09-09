import type {
  MeetingBriefProviderOutcome,
  MeetingBriefProviderOutcomes,
} from "@chief-of-staff-demo/shared";
import { MEETING_BRIEF_PROVIDER_OUTCOMES_VERSION } from "@chief-of-staff-demo/shared";

/**
 * Meeting Brief completeness and retry policy (issue #137).
 *
 * Every provider selected in an attendee's versioned bundle is required: a
 * Brief is never composed or delivered while a required provider outcome is
 * failed (spec #82, Decision 19). The Run records one versioned outcome per
 * selected provider — outcome, diagnostics and the reusable artifact — so a
 * sibling's success survives a failure and a retry reruns only the missing
 * work. Automatic retries use bounded backoff and stop 30 minutes before the
 * occurrence start; at cutoff the Run fails visibly and sends nothing.
 *
 * A provider leaves the required set only through an explicit policy action
 * recorded on the Run; nothing here relaxes a requirement by itself.
 */

/** The cutoff: 30 minutes before the occurrence start (spec Decision 19). */
const MEETING_BRIEF_RETRY_CUTOFF_MS = 30 * 60 * 1000;

/** Bounded backoff between automatic attempts — implementation policy values. */
const MEETING_BRIEF_RETRY_BASE_MS = 60 * 1000;
const MEETING_BRIEF_RETRY_MAX_MS = 10 * 60 * 1000;

/** Epoch ms of the enrich cutoff for one occurrence, or null when unparseable. */
export function briefCutoffAt(startAt: string): number | null {
  const startMs = Date.parse(startAt);
  return Number.isNaN(startMs) ? null : startMs - MEETING_BRIEF_RETRY_CUTOFF_MS;
}

/**
 * Bounded exponential backoff before automatic attempt `retryCount + 1`:
 * one minute after the first failure, doubled per retry, never longer than
 * ten minutes so a recoverable outage still converges inside the cutoff.
 */
export function providerRetryDelayMs(retryCount: number): number {
  return Math.min(
    MEETING_BRIEF_RETRY_BASE_MS * 2 ** Math.max(0, retryCount - 1),
    MEETING_BRIEF_RETRY_MAX_MS,
  );
}

export interface EnrichmentVerdict {
  complete: boolean;
  failed: MeetingBriefProviderOutcome[];
}

/**
 * The completeness gate over one Run's provider outcome ledger: complete when
 * no required provider outcome is failed. A provider disabled through an
 * explicit policy action is no longer required — the exclusion is the
 * person's recorded action, never inferred here.
 */
export function enrichmentVerdict(
  outcomes: readonly MeetingBriefProviderOutcome[],
  disabledProviders: readonly string[] = [],
): EnrichmentVerdict {
  const disabled: Record<string, true> = {};
  for (const provider of disabledProviders) disabled[provider] = true;
  const failed = outcomes.filter(
    (outcome) => outcome.outcome === "failed" && disabled[outcome.provider] !== true,
  );
  return { complete: failed.length === 0, failed };
}

export function readProviderOutcomes(raw: string | null): MeetingBriefProviderOutcomes | null {
  /* The artifact is durable local state: the version check narrows an
     unvalidated JSON parse, so the constant is read through a number-typed
     alias to keep the comparison runtime-meaningful. */
  const LEDGER_VERSION_NUMBER: number = MEETING_BRIEF_PROVIDER_OUTCOMES_VERSION;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MeetingBriefProviderOutcomes;
    if (parsed.version !== LEDGER_VERSION_NUMBER || !Array.isArray(parsed.outcomes)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The durable ledger written to `provider-outcomes.json`. While enrichment is
 * incomplete the retry count grows so the next attempt's backoff is bounded by
 * what already happened; a completing attempt keeps the count as history.
 */
export function buildProviderOutcomesLedger(options: {
  occurrenceKey: string;
  eventVersion: string;
  bundleVersion: number;
  outcomes: readonly MeetingBriefProviderOutcome[];
  prior: MeetingBriefProviderOutcomes | null;
  incomplete: boolean;
}): MeetingBriefProviderOutcomes {
  const { occurrenceKey, eventVersion, bundleVersion, outcomes, prior, incomplete } = options;
  return {
    version: MEETING_BRIEF_PROVIDER_OUTCOMES_VERSION,
    bundleVersion,
    occurrenceKey,
    eventVersion,
    retryCount: incomplete ? (prior?.retryCount ?? 0) + 1 : (prior?.retryCount ?? 0),
    outcomes: [...outcomes],
  };
}
