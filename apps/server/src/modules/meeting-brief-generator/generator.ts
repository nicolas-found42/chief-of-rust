import type {
  MeetingBrief,
  MeetingBriefEnrichmentSection,
  MeetingBriefPersonProfileLink,
  MeetingBriefProviderOutcome,
  MeetingBriefRunResult,
} from "@chief-of-staff-demo/shared";
import type { CompleteJson } from "../../llm/providers.js";
import { StageFailure, type RunContext } from "../../engine/module.js";
import { composeBrief } from "./compose.js";
import { enrichUnified, type MeetingBriefEnrichmentProviders } from "./enrichment/enrich.js";
import {
  briefCutoffAt,
  buildProviderOutcomesLedger,
  enrichmentVerdict,
  providerRetryDelayMs,
  readProviderOutcomes,
} from "./completeness.js";
import { deliveryIdFor, deliveryState } from "./deliver.js";
import type { FrozenSnapshot } from "./snapshot.js";

/** The occurrence captured by the snapshot Stage and handed to the generator. */
export type FrozenMeetingOccurrence = FrozenSnapshot & {
  supersedesRunId?: string | null;
  profileRefreshOf?: string;
};

/**
 * The Meeting Brief Generator's one public interface (issue #168). Everything
 * that decides Brief content stays behind this seam.
 */
export interface MeetingBriefGenerator {
  generate(occurrence: FrozenMeetingOccurrence): Promise<MeetingBrief>;
}

interface EnrichmentResult {
  sections: unknown[];
  evidence: string[];
  personProfileLinks?: MeetingBriefPersonProfileLink[];
  outcomes?: MeetingBriefProviderOutcome[];
  bundleVersion?: number;
}

export interface MeetingBriefGeneratorOptions {
  context: RunContext;
  now?: () => Date;
  enrichmentProviders?: MeetingBriefEnrichmentProviders;
  getCompleteJson?: () => CompleteJson;
  getInternalDomains?: () => string[];
  getDisabledProviders?: () => readonly string[];
  /** Internal test seam for deterministic enrichment adapters. */
  enrich?: (occurrence: FrozenMeetingOccurrence, context: RunContext) => Promise<EnrichmentResult>;
  /** Internal test seam for deterministic model adapters. */
  completeBrief?: (
    occurrence: FrozenMeetingOccurrence,
    enrichment: EnrichmentResult,
  ) => Promise<MeetingBrief>;
}

function readEnrichment(raw: string | null): EnrichmentResult {
  if (!raw) return { sections: [], evidence: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<EnrichmentResult>;
    return {
      sections: Array.isArray(parsed.sections) ? parsed.sections : [],
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
      personProfileLinks: Array.isArray(parsed.personProfileLinks) ? parsed.personProfileLinks : [],
    };
  } catch {
    return { sections: [], evidence: [] };
  }
}

/** Bind Run machinery and external adapters, leaving callers one operation. */
export function createMeetingBriefGenerator(
  options: MeetingBriefGeneratorOptions,
): MeetingBriefGenerator {
  const now = options.now ?? (() => new Date());
  const { context } = options;

  return {
    async generate(occurrence) {
      let enrichment = readEnrichment(context.readFile("enrich.json"));

      if (context.readFile("enrich.json") === null) {
        await context.stage("enrich", async () => {
          if (options.enrich) {
            enrichment = await options.enrich(occurrence, context);
          } else if (options.enrichmentProviders) {
            enrichment = await enrichUnified(occurrence, context, {
              providers: options.enrichmentProviders,
              internalDomains: options.getInternalDomains?.() ?? [],
              occurrenceKey: occurrence.occurrenceKey,
              ...(options.getDisabledProviders
                ? { disabledProviders: options.getDisabledProviders() }
                : {}),
            });
          } else {
            throw new Error("Meeting Brief enrichment providers are unavailable");
          }

          const outcomes = enrichment.outcomes;
          if (outcomes) {
            const disabled = options.getDisabledProviders?.() ?? [];
            const verdict = enrichmentVerdict(outcomes, disabled);
            const prior = readProviderOutcomes(context.readFile("provider-outcomes.json"));
            const ledger = buildProviderOutcomesLedger({
              occurrenceKey: occurrence.occurrenceKey,
              eventVersion: occurrence.version,
              bundleVersion: enrichment.bundleVersion ?? prior?.bundleVersion ?? 1,
              outcomes,
              prior,
              incomplete: !verdict.complete,
            });
            context.writeFile("provider-outcomes.json", JSON.stringify(ledger, null, 2) + "\n");
            context.event("enrich_provider_outcomes", {
              complete: verdict.complete,
              retryCount: ledger.retryCount,
              failed: verdict.failed.map((outcome) => ({
                provider: outcome.provider,
                attendee: outcome.attendee,
                diagnostics: outcome.diagnostics,
              })),
              disabled: outcomes
                .filter((outcome) => outcome.outcome === "disabled")
                .map((outcome) => outcome.provider),
            });
            if (!verdict.complete) {
              const cutoff = briefCutoffAt(occurrence.startAt);
              const nowMs = now().getTime();
              const failedNames = verdict.failed
                .map((outcome) => `${outcome.provider} (${outcome.attendee})`)
                .join(", ");
              if (cutoff !== null && nowMs >= cutoff) {
                throw new StageFailure(
                  `brief_cutoff: automatic enrichment retries stopped 30 minutes before the occurrence start; failed providers: ${failedNames}. No Brief was composed or delivered.`,
                  "Enrichment stopped at the cutoff. Repair or disable the failed provider, then retry the Run explicitly.",
                );
              }
              const waitUntil = Math.min(
                nowMs + providerRetryDelayMs(ledger.retryCount),
                cutoff ?? Infinity,
              );
              context.event("enrich_retry_scheduled", {
                attempt: ledger.retryCount + 1,
                retryAt: new Date(waitUntil).toISOString(),
                cutoffAt: cutoff === null ? null : new Date(cutoff).toISOString(),
                failed: failedNames,
              });
              context.wait({
                reason: "provider_retry_backoff",
                timeout: { kind: "at", at: new Date(waitUntil).toISOString() },
              });
            }
          }

          context.writeFile("enrich.json", JSON.stringify(enrichment, null, 2) + "\n");
          context.event("enrich_completed", { sections: enrichment.sections.length });
        });
      }

      return context.stage("compose", async () => {
        let brief: MeetingBrief;
        if (options.completeBrief) {
          brief = await options.completeBrief(occurrence, enrichment);
        } else if (options.getCompleteJson) {
          brief = await composeBrief({
            now,
            getCompleteJson: options.getCompleteJson,
            snapshot: occurrence,
            sections: enrichment.sections as MeetingBriefEnrichmentSection[],
            internalDomains: options.getInternalDomains?.() ?? [],
          });
        } else {
          throw new Error("Meeting Brief composition provider is unavailable");
        }
        const supersedes = occurrence.supersedesRunId ?? null;
        const result: MeetingBriefRunResult = {
          version: 1,
          eventId: occurrence.eventId,
          occurrenceId: occurrence.occurrenceId,
          eventVersion: occurrence.version,
          occurrenceKey: occurrence.occurrenceKey,
          snapshotAt: occurrence.capturedAt,
          enrichAt: now().toISOString(),
          composeAt: now().toISOString(),
          meetingBrief: brief,
          delivery: deliveryState(
            "pending",
            deliveryIdFor(
              occurrence.occurrenceKey,
              brief.eventVersion,
              occurrence.profileRefreshOf ? context.runId : undefined,
            ),
          ),
          personProfileLinks: enrichment.personProfileLinks ?? [],
          supersedes,
          ...(occurrence.profileRefreshOf ? { profileRefreshOf: occurrence.profileRefreshOf } : {}),
        };
        context.writeFile("result.json", JSON.stringify(result, null, 2) + "\n");
        context.event("brief_composed", {
          eventVersion: occurrence.version,
          guests: brief.guests.length,
          supersedes,
        });
        return brief;
      });
    },
  };
}
