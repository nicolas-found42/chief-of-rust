import type {
  AdapterDiagnostic,
  ContentScoutRunResult,
  RunMeta,
  SourceBackfillWindowDays,
  SourceCollectionAttemptReceipt,
} from "@chief-of-staff-demo/shared";
import {
  CONTENT_SCOUT_MODULE_ID,
  CONTENT_SCOUT_MODULE_VERSION,
  SOURCE_BACKFILL_WINDOWS_DAYS,
} from "@chief-of-staff-demo/shared";
import {
  StageFailure,
  type RetryPlan,
  type RunContext,
  type ShellModule,
} from "../../engine/module.js";
import type { RunOutcome } from "../../runs.js";
import { collectSourceTargets, type CollectedSourceTargetProgress } from "./collection.js";
import type {
  SourceAdapter,
  SourceCollectionResult,
} from "../../source-adapters/source-adapter.js";
import type { ContentScoutStore } from "./store.js";

export const CONTENT_SCOUT_BACKFILL_INTAKE = "source-backfill";

export interface ContentScoutBackfillInput {
  targetId: string;
  windowDays: SourceBackfillWindowDays;
}

/** The Run's own `externalId` doubles as the durable record of what was requested, so a retry or a recovered restart can reconstruct it without a separate artifact read. */
export function backfillExternalId(input: ContentScoutBackfillInput): string {
  return `${input.targetId}:${input.windowDays}`;
}

function parseBackfillExternalId(value: string | null): ContentScoutBackfillInput | null {
  if (!value) return null;
  const separator = value.lastIndexOf(":");
  if (separator === -1) return null;
  const targetId = value.slice(0, separator);
  const windowDays = Number(value.slice(separator + 1));
  if (!targetId || !SOURCE_BACKFILL_WINDOWS_DAYS.includes(windowDays as SourceBackfillWindowDays)) {
    return null;
  }
  return { targetId, windowDays: windowDays as SourceBackfillWindowDays };
}

function parseArtifact<T>(ctx: RunContext, name: string): T | null {
  const raw = ctx.readFile(name);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function duration(diagnostic: AdapterDiagnostic): number {
  const started = Date.parse(diagnostic.startedAt);
  const finished = Date.parse(diagnostic.finishedAt);
  return Number.isFinite(started) && Number.isFinite(finished) && finished >= started
    ? finished - started
    : 0;
}

function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

export interface ContentScoutBackfillDeps {
  store: ContentScoutStore;
  adapters: SourceAdapter[];
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  recordSanitizedDiagnostic?: (id: string, contentType: string, body: string) => void;
}

/**
 * One user-requested, bounded historical collection for a single active
 * Source Target. It shares the daily-intake collection path (bounded
 * concurrency, retries, per-host backoff) but never touches the Source
 * Target's checkpoint or conditional state, so it cannot corrupt Daily
 * Intake's 48-hour overlap. Requesting a window an Adapter did not declare
 * fails the Run as `unsupported_capability` rather than completing as an
 * empty success.
 */
export function contentScoutBackfillModule(
  deps: ContentScoutBackfillDeps,
): ShellModule<ContentScoutBackfillInput> {
  return {
    id: CONTENT_SCOUT_MODULE_ID,
    version: CONTENT_SCOUT_MODULE_VERSION,

    failureHint(stage): string {
      if (stage === "collect") {
        return "The requested backfill could not complete. Check the Source Adapter diagnostics, then retry.";
      }
      return "Content Scout could not finish this backfill.";
    },

    planRetry(meta: Readonly<RunMeta>): RetryPlan<ContentScoutBackfillInput> | null {
      if (meta.intake !== CONTENT_SCOUT_BACKFILL_INTAKE || meta.status !== "failed") return null;
      const input = parseBackfillExternalId(meta.externalId);
      if (!input) return null;
      return { fromStage: meta.failedStage ?? "collect", reason: "failed_backfill_stage", input };
    },

    planRecovery(meta) {
      if (
        meta.intake !== CONTENT_SCOUT_BACKFILL_INTAKE ||
        (meta.status !== "pending" && meta.status !== "running")
      ) {
        return null;
      }
      const input = parseBackfillExternalId(meta.externalId);
      if (!input) return null;
      return { fromStage: meta.failedStage ?? "collect", reason: "orphaned_backfill_run", input };
    },

    async run(ctx, input): Promise<RunOutcome> {
      let itemsFound = 0;

      await ctx.stage("collect", async () => {
        const target = deps.store
          .listSourceTargets()
          .find((candidate) => candidate.id === input.targetId);
        if (!target) {
          throw new StageFailure(
            "source_target_missing",
            "That Source Target no longer exists; the backfill cannot run.",
          );
        }
        // Ignore the real checkpoint/conditional state entirely: a backfill is
        // a bounded historical snapshot, never a contributor to (or reader of)
        // Daily Intake's checkpoint and 48-hour overlap.
        const backfillTarget = { ...target, checkpoint: null, conditional: null };

        const progress =
          parseArtifact<CollectedSourceTargetProgress[]>(ctx, "collection-progress.json") ?? [];
        // Reconstruct the full attempt history a restart or a manual retry may
        // have left split across the progress and attempts artifacts, mirroring
        // Daily Intake's own collect Stage so the same restart-safety holds here.
        const attemptReceipts =
          parseArtifact<SourceCollectionAttemptReceipt[]>(ctx, "collection-attempts.json") ?? [];
        for (const prior of progress.flatMap((entry) => entry.attempts)) {
          if (
            !attemptReceipts.some(
              (candidate) =>
                candidate.targetId === prior.targetId && candidate.attempt === prior.attempt,
            )
          ) {
            attemptReceipts.push(prior);
          }
        }
        if (progress.length > 0) {
          ctx.writeFile(
            "collection-attempts.json",
            `${JSON.stringify(attemptReceipts, null, 2)}\n`,
          );
        }
        const priorAttempts = Math.max(
          0,
          ...attemptReceipts
            .filter((receipt) => receipt.targetId === target.id)
            .map((receipt) => receipt.attempt),
        );

        const [collected] = await collectSourceTargets({
          targets: [backfillTarget],
          adapters: deps.adapters,
          now: deps.now,
          sleep: deps.sleep,
          backfillWindowDays: input.windowDays,
          collectionStart: () =>
            new Date(deps.now().getTime() - input.windowDays * 86_400_000).toISOString(),
          previous: progress,
          attemptOffsets: { [target.id]: priorAttempts },
          attemptCompleted: ({ target: attemptTarget, result, attempts }) => {
            const receipt = attempts.at(-1)!;
            if (result.diagnosticBody) {
              deps.recordSanitizedDiagnostic?.(
                `${ctx.runId}-${safePart(attemptTarget.id)}-${receipt.attempt}`,
                result.diagnosticBody.contentType,
                result.diagnosticBody.body,
              );
            }
            // The raw response body is retained (sanitized) via the call above;
            // it must never reach a durable Run artifact unsanitized.
            const persistedResult: SourceCollectionResult = { ...result };
            delete persistedResult.diagnosticBody;
            const entry = {
              targetId: attemptTarget.id,
              result: persistedResult,
              attempts,
            } satisfies CollectedSourceTargetProgress;
            const index = progress.findIndex(
              (candidate) => candidate.targetId === attemptTarget.id,
            );
            if (index === -1) progress.push(entry);
            else progress[index] = entry;
            ctx.writeFile("collection-progress.json", `${JSON.stringify(progress, null, 2)}\n`);
            if (
              !attemptReceipts.some(
                (candidate) =>
                  candidate.targetId === attemptTarget.id && candidate.attempt === receipt.attempt,
              )
            ) {
              attemptReceipts.push(receipt);
            }
            ctx.writeFile(
              "collection-attempts.json",
              `${JSON.stringify(attemptReceipts, null, 2)}\n`,
            );
          },
        });

        const { adapter, result, attempts: newAttempts } = collected!;
        const allAttempts = attemptReceipts.filter((receipt) => receipt.targetId === target.id);
        itemsFound = result.items.length;
        const supported = (adapter.backfillWindowsDays ?? []).includes(input.windowDays);

        ctx.writeFile("source-items.json", `${JSON.stringify(result.items, null, 2)}\n`);
        const row: ContentScoutRunResult["adapters"][number] = {
          adapterId: adapter.id,
          state: adapter.state,
          targetsAttempted: 1,
          outcome: result.outcome,
          itemsFound,
          durationMs: allAttempts.reduce(
            (total, attempt) => total + (attempt.diagnostic ? duration(attempt.diagnostic) : 0),
            0,
          ),
          retries: Math.max(0, allAttempts.length - 1),
          lastSuccessfulRequest:
            result.kind === "completed"
              ? { at: result.diagnostic.finishedAt, route: result.diagnostic.route }
              : null,
          errorClassifications: result.kind === "failed" ? [result.outcome] : [],
          affectedCapabilities: [...result.diagnostic.affectedCapabilities],
          attempts: allAttempts,
        };
        const runResult: ContentScoutRunResult = {
          backfill: {
            targetId: target.id,
            windowDays: input.windowDays,
            adapterId: adapter.id,
            supported,
          },
          adapters: [row],
          shortlist: { opportunityCount: 0, omittedCount: 0 },
          warnings: result.kind === "failed" ? 1 : 0,
        };
        ctx.writeFile("result.json", `${JSON.stringify(runResult, null, 2)}\n`);

        for (const attempt of newAttempts) {
          ctx.event("source_adapter_attempted", {
            adapterId: adapter.id,
            targetId: target.id,
            attempt: attempt.attempt,
            outcome: attempt.outcome,
            backoffMs: attempt.backoffMs,
          });
        }

        if (result.kind === "completed") {
          ctx.event("source_adapter_completed", {
            adapterId: adapter.id,
            targetId: target.id,
            outcome: result.outcome,
            itemsFound,
          });
          return;
        }

        ctx.event("source_adapter_failed", {
          adapterId: adapter.id,
          targetId: target.id,
          outcome: result.outcome,
        });
        throw new StageFailure(
          result.outcome,
          result.outcome === "unsupported_capability"
            ? `The ${adapter.id} Source Adapter does not support a ${input.windowDays}-day backfill for this Source Target.`
            : `The ${input.windowDays}-day backfill could not complete: ${result.outcome.replaceAll("_", " ")}.`,
        );
      });

      return {
        status: "done",
        summary: `${itemsFound} Source Item${itemsFound === 1 ? "" : "s"} collected`,
        detail: { targetId: input.targetId, windowDays: input.windowDays },
      };
    },
  };
}
