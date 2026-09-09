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
  COLLECTION_GLOBAL_CONCURRENCY as CONTENT_SCOUT_COLLECTION_GLOBAL_CONCURRENCY,
  COLLECTION_MAX_ATTEMPTS as CONTENT_SCOUT_COLLECTION_MAX_ATTEMPTS,
  RETRYABLE_COLLECTION_OUTCOMES as RETRYABLE,
  failedResult,
  hostOf,
  mapLimit,
  unavailableAdapter,
} from "../../source-adapters/collection.js";

/** Shared Daily Intake limits. Targets on one host are always serialized. */
export interface CollectedSourceTarget {
  target: SourceTarget;
  adapter: SourceAdapter;
  result: SourceCollectionResult;
  attempts: SourceCollectionAttemptReceipt[];
}

export interface CollectedSourceTargetProgress {
  targetId: string;
  result: SourceCollectionResult;
  attempts: SourceCollectionAttemptReceipt[];
}

export async function collectSourceTargets(input: {
  targets: SourceTarget[];
  adapters: SourceAdapter[];
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  collectionStart: (target: SourceTarget, now: Date) => string;
  attemptCompleted?: (entry: CollectedSourceTarget) => void;
  previous?: CollectedSourceTargetProgress[];
  attemptOffsets?: Record<string, number>;
  /** Present only for a user-requested backfill: the window each target's Adapter must declare support for. */
  backfillWindowDays?: SourceBackfillWindowDays;
}): Promise<CollectedSourceTarget[]> {
  const work = input.targets.map((target, index) => ({
    target,
    adapter:
      input.adapters.find((candidate) => candidate.supports(target)) ?? unavailableAdapter(target),
    previous: input.previous?.find((entry) => entry.targetId === target.id),
    index,
  }));
  const byHost = new Map<string, typeof work>();
  for (const item of work) {
    const host = hostOf(item.target);
    const group = byHost.get(host) ?? [];
    group.push(item);
    byHost.set(host, group);
  }
  const collected: (CollectedSourceTarget & { index: number })[] = [];
  await mapLimit(
    [...byHost.values()],
    CONTENT_SCOUT_COLLECTION_GLOBAL_CONCURRENCY,
    async (group) => {
      for (const item of group) {
        const receipts: SourceCollectionAttemptReceipt[] = [...(item.previous?.attempts ?? [])];
        let result: SourceCollectionResult | null = item.previous?.result ?? null;
        if (
          result !== null &&
          (result.kind === "completed" ||
            !RETRYABLE.has(result.outcome) ||
            receipts.length >= CONTENT_SCOUT_COLLECTION_MAX_ATTEMPTS)
        ) {
          collected.push({
            target: item.target,
            adapter: item.adapter,
            result: {
              ...result,
              diagnostic: { ...result.diagnostic, retries: Math.max(0, receipts.length - 1) },
            },
            attempts: receipts,
            index: item.index,
          });
          continue;
        }
        const attemptBase = (input.attemptOffsets?.[item.target.id] ?? 0) - receipts.length;
        for (
          let cycleAttempt = receipts.length + 1;
          cycleAttempt <= CONTENT_SCOUT_COLLECTION_MAX_ATTEMPTS;
          cycleAttempt += 1
        ) {
          const attempt = attemptBase + cycleAttempt;
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
                since: input.collectionStart(item.target, input.now()),
                until: input.now().toISOString(),
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
            result.kind === "failed" &&
            RETRYABLE.has(result.outcome) &&
            cycleAttempt < CONTENT_SCOUT_COLLECTION_MAX_ATTEMPTS;
          const backoffMs = retry
            ? Math.max(
                0,
                result.diagnostic.retryAfterMs ?? DEFAULT_BACKOFF_MS * 2 ** (cycleAttempt - 1),
              )
            : 0;
          receipts.push({
            targetId: item.target.id,
            adapterId: item.adapter.id,
            attempt,
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
          input.attemptCompleted?.({
            target: item.target,
            adapter: item.adapter,
            result: {
              ...result,
              diagnostic: { ...result.diagnostic, retries: receipts.length - 1 },
            },
            attempts: [...receipts],
          });
          if (!retry) break;
          await input.sleep(backoffMs);
        }
        const final = result!;
        collected.push({
          target: item.target,
          adapter: item.adapter,
          result: {
            ...final,
            diagnostic: { ...final.diagnostic, retries: receipts.length - 1 },
          },
          attempts: receipts,
          index: item.index,
        });
      }
    },
  );
  return collected.sort((left, right) => left.index - right.index);
}
