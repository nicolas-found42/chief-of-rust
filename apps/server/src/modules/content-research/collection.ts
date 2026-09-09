import type {
  SourceBackfillWindowDays,
  SourceCollectionAttemptReceipt,
  SourceTarget,
} from "@chief-of-staff-demo/shared";
import type {
  SourceAdapter,
  SourceCollectionResult,
} from "../../source-adapters/source-adapter.js";
import { sanitizeAdapterDiagnostic } from "../../source-adapters/diagnostics.js";
import {
  COLLECTION_DEFAULT_BACKOFF_MS as DEFAULT_BACKOFF_MS,
  COLLECTION_GLOBAL_CONCURRENCY as GLOBAL_CONCURRENCY,
  COLLECTION_MAX_ATTEMPTS as MAX_ATTEMPTS,
  RETRYABLE_COLLECTION_OUTCOMES as RETRYABLE,
  failedResult,
  hostOf,
  type AttemptReceipt,
  mapLimit,
  unavailableAdapter,
} from "../../source-adapters/collection.js";

export interface CollectedPersonTarget {
  personId: string;
  personName: string;
  target: SourceTarget;
  adapter: SourceAdapter;
  result: SourceCollectionResult;
  attempts: SourceCollectionAttemptReceipt[];
}

export async function collectContentResearch(input: {
  persons: { id: string; name: string; targets: SourceTarget[] }[];
  adapters: SourceAdapter[];
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  since: string;
  until: string;
  backfillWindowDays?: SourceBackfillWindowDays;
}): Promise<CollectedPersonTarget[]> {
  type WorkItem = {
    personId: string;
    personName: string;
    target: SourceTarget;
    adapter: SourceAdapter;
  };
  const work: WorkItem[] = [];
  for (const person of input.persons) {
    for (const target of person.targets) {
      const adapter =
        input.adapters.find((candidate) => candidate.supports(target)) ??
        unavailableAdapter(target);
      work.push({ personId: person.id, personName: person.name, target, adapter });
    }
  }

  // Group by host for serialization per host (same as content-scout)
  const byHost = new Map<string, WorkItem[]>();
  for (const item of work) {
    const host = hostOf(item.target);
    const group = byHost.get(host) ?? [];
    group.push(item);
    byHost.set(host, group);
  }

  const collected: CollectedPersonTarget[] = [];
  await mapLimit([...byHost.values()], GLOBAL_CONCURRENCY, async (group) => {
    for (const item of group) {
      const receipts: AttemptReceipt[] = [];
      let result: SourceCollectionResult | null = null;
      for (let cycleAttempt = 1; cycleAttempt <= MAX_ATTEMPTS; cycleAttempt += 1) {
        const startedAt = input.now().toISOString();
        const backfillUnsupported =
          input.backfillWindowDays !== undefined &&
          !(item.adapter.backfillWindowsDays ?? []).includes(input.backfillWindowDays);
        if (item.adapter.state === "coming_later" || backfillUnsupported) {
          result = failedResult({
            target: item.target,
            adapter: item.adapter,
            startedAt,
            finishedAt: input.now().toISOString(),
            outcome: "unsupported_capability",
            cause: backfillUnsupported
              ? `The ${item.adapter.id} Source Adapter does not support a ${input.backfillWindowDays}-day backfill.`
              : "This Source Adapter has no approved collection route.",
          });
        } else {
          try {
            result = await item.adapter.collect({
              target: item.target,
              since: input.since,
              until: input.until,
              checkpoint: item.target.checkpoint,
              conditional: item.target.conditional,
            });
          } catch (error) {
            result = failedResult({
              target: item.target,
              adapter: item.adapter,
              startedAt,
              finishedAt: input.now().toISOString(),
              outcome: "internal_failure",
              cause: error instanceof Error ? error.message : String(error),
            });
          }
        }
        result = {
          ...result,
          diagnostic: sanitizeAdapterDiagnostic(result.diagnostic, item.adapter.version),
        };
        const retry =
          result.kind === "failed" && RETRYABLE.has(result.outcome) && cycleAttempt < MAX_ATTEMPTS;
        const backoffMs = retry
          ? Math.max(
              0,
              result.diagnostic.retryAfterMs ?? DEFAULT_BACKOFF_MS * 2 ** (cycleAttempt - 1),
            )
          : 0;
        receipts.push({
          targetId: item.target.id,
          adapterId: item.adapter.id,
          attempt: cycleAttempt,
          startedAt,
          finishedAt: input.now().toISOString(),
          outcome: result.outcome,
          checkpointBefore: item.target.checkpoint,
          checkpointAfter: result.kind === "completed" ? result.checkpoint : null,
          conditionalRequest: item.target.conditional,
          conditionalResponse: result.conditional ?? null,
          backoffMs,
          diagnostic: result.diagnostic,
          itemsFound: result.items.length,
        });
        if (!retry) break;
        await input.sleep(backoffMs);
      }
      const final = result!;
      collected.push({
        personId: item.personId,
        personName: item.personName,
        target: item.target,
        adapter: item.adapter,
        result: {
          ...final,
          diagnostic: { ...final.diagnostic, retries: receipts.length - 1 },
        },
        attempts: receipts.map((r, idx) => ({
          ...r,
          diagnostic: { ...r.diagnostic, retries: idx },
        })),
      });
    }
  });
  return collected;
}
