import type {
  AdapterDiagnostic,
  ContentScoutRunResult,
  ContentShortlist,
  RunMeta,
  SourceItem,
  SourceCollectionAttemptReceipt,
  SourceTarget,
} from "@chief-of-staff-demo/shared";
import { CONTENT_SCOUT_MODULE_ID, CONTENT_SCOUT_MODULE_VERSION } from "@chief-of-staff-demo/shared";
import { StageFailure, type RetryPlan, type ShellModule } from "../../engine/module.js";
import type { RunContext } from "../../engine/module.js";
import type { RunOutcome } from "../../runs.js";
import type { OpportunityRanker } from "./ports.js";
import type { OpportunityProjects } from "../../content-projects/opportunity-projects.js";
import type {
  SourceAdapter,
  SourceCollectionResult,
} from "../../source-adapters/source-adapter.js";
import type { ContentScoutStore } from "./store.js";
import { collectSourceTargets, type CollectedSourceTargetProgress } from "./collection.js";
import { sanitizeDiagnosticRoute } from "../../source-adapters/diagnostics.js";
import { determineEligibility, enforceOpportunityIdentity } from "./eligibility.js";
import {
  CONTENT_SCOUT_MAX_COMMENTS,
  filterPromisingItems,
  selectDiverseComments,
} from "./enrichment.js";

export const CONTENT_SCOUT_INTAKE = "daily-intake";

export type ContentScoutInput =
  | { kind: "intake"; invocation: "manual" | "scheduled" }
  | { kind: "selection"; opportunityIds: string[] }
  | { kind: "skip" };

export interface ContentScoutModuleDeps {
  store: ContentScoutStore;
  adapters: SourceAdapter[];
  ranker: OpportunityRanker;
  /** Selecting a shortlisted Opportunity starts exactly one governed Content Project (#133). */
  opportunityProjects?: OpportunityProjects;
  supersede?: (oldRunId: string, newRunId: string) => void;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  recordSanitizedDiagnostic?: (id: string, contentType: string, body: string) => void;
  intakeCompleted?: (period: string | null) => void;
  shortlistSize?: () => number;
  isOwnerProfileConfirmed?: () => boolean;
}

function collectionStart(target: SourceTarget, now: Date): string {
  const overlapMs = target.lastSuccessfulAt === null ? 7 * 86_400_000 : 48 * 3_600_000;
  const anchor = target.lastSuccessfulAt
    ? new Date(target.lastSuccessfulAt).getTime()
    : now.getTime();
  return new Date(anchor - overlapMs).toISOString();
}

function duration(diagnostic: AdapterDiagnostic): number {
  const started = Date.parse(diagnostic.startedAt);
  const finished = Date.parse(diagnostic.finishedAt);
  return Number.isFinite(started) && Number.isFinite(finished) && finished >= started
    ? finished - started
    : 0;
}

function laterSuccessfulRequest(
  current: ContentScoutRunResult["adapters"][number]["lastSuccessfulRequest"],
  candidate: ContentScoutRunResult["adapters"][number]["lastSuccessfulRequest"],
) {
  if (!current) return candidate;
  if (!candidate) return current;
  return Date.parse(candidate.at) >= Date.parse(current.at) ? candidate : current;
}

function addAdapterResult(
  rows: ContentScoutRunResult["adapters"],
  input: {
    target: SourceTarget;
    adapter: SourceAdapter;
    result: SourceCollectionResult;
    attempts: SourceCollectionAttemptReceipt[];
  },
): void {
  const attemptDurationMs = input.attempts.reduce(
    (total, attempt) => total + (attempt.diagnostic ? duration(attempt.diagnostic) : 0),
    0,
  );
  const durationMs = attemptDurationMs || duration(input.result.diagnostic);
  const errorClassifications = input.result.kind === "failed" ? [input.result.outcome] : [];
  const successfulRequest =
    input.result.kind === "completed"
      ? {
          at: input.result.diagnostic.finishedAt,
          route: input.result.diagnostic.route,
        }
      : input.target.lastSuccessfulAt
        ? {
            at: input.target.lastSuccessfulAt,
            route: sanitizeDiagnosticRoute(input.target.url),
          }
        : null;
  const existing = rows.find((row) => row.adapterId === input.adapter.id);
  if (!existing) {
    rows.push({
      adapterId: input.adapter.id,
      state: input.adapter.state,
      targetsAttempted: 1,
      outcome: input.result.outcome,
      itemsFound: input.result.items.length,
      durationMs,
      retries: input.result.diagnostic.retries,
      lastSuccessfulRequest: successfulRequest,
      errorClassifications,
      affectedCapabilities: [...input.result.diagnostic.affectedCapabilities],
      attempts: [...input.attempts],
    });
    return;
  }
  existing.targetsAttempted += 1;
  existing.itemsFound += input.result.items.length;
  existing.durationMs += durationMs;
  existing.retries += input.result.diagnostic.retries;
  existing.lastSuccessfulRequest =
    laterSuccessfulRequest(existing.lastSuccessfulRequest, successfulRequest) ?? null;
  existing.errorClassifications = [
    ...new Set([...(existing.errorClassifications ?? []), ...errorClassifications]),
  ];
  existing.affectedCapabilities = [
    ...new Set([...existing.affectedCapabilities, ...input.result.diagnostic.affectedCapabilities]),
  ];
  existing.attempts.push(...input.attempts);
  if (input.result.kind === "failed") existing.outcome = input.result.outcome;
  else if (existing.errorClassifications.length === 0 && input.result.items.length > 0) {
    existing.outcome = "items_found";
  }
}

function adapterWarningCount(rows: ContentScoutRunResult["adapters"]): number {
  return rows.filter((row) => (row.errorClassifications?.length ?? 0) > 0).length;
}

function reconcileAttemptHistory(
  rows: ContentScoutRunResult["adapters"],
  attempts: SourceCollectionAttemptReceipt[],
): void {
  for (const row of rows) {
    const adapterAttempts = attempts.filter((attempt) => attempt.adapterId === row.adapterId);
    if (adapterAttempts.length === 0) continue;
    row.attempts = adapterAttempts;
    row.targetsAttempted = new Set(adapterAttempts.map((attempt) => attempt.targetId)).size;
    row.retries = adapterAttempts.length - row.targetsAttempted;
    const measuredDuration = adapterAttempts.reduce(
      (total, attempt) => total + (attempt.diagnostic ? duration(attempt.diagnostic) : 0),
      0,
    );
    if (measuredDuration > 0) row.durationMs = measuredDuration;
  }
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

function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function readRunResult(ctx: RunContext): ContentScoutRunResult {
  return (
    parseArtifact<ContentScoutRunResult>(ctx, "result.json") ?? {
      adapters: [],
      shortlist: { opportunityCount: 0, omittedCount: 0 },
      warnings: 0,
    }
  );
}

/** Content Scout orchestration behind the ContentScoutHost interface. */
export function contentScoutModule(deps: ContentScoutModuleDeps): ShellModule<ContentScoutInput> {
  const selectedRun = async (ctx: RunContext, opportunityIds: string[]): Promise<RunOutcome> => {
    const shortlist = parseArtifact<ContentShortlist>(ctx, "shortlist.json");
    if (!shortlist) {
      throw new StageFailure(
        "shortlist_missing",
        "The immutable shortlist artifact is missing; this Run cannot safely resume.",
      );
    }
    const selected = opportunityIds.map((id) => {
      const found = shortlist.opportunities.find((opportunity) => opportunity.id === id);
      if (!found) throw new Error(`Opportunity is absent from the shortlist: ${id}`);
      return found;
    });
    const pending = deps.store.pendingAction(ctx.runId);
    const projectInput = pending?.kind === "selection" ? pending.project : null;
    const requireOwnerConfirmation = () => {
      if (deps.isOwnerProfileConfirmed && !deps.isOwnerProfileConfirmed()) {
        throw new StageFailure(
          "owner_not_confirmed",
          "Confirm the workspace owner Profile before starting a Content Project.",
        );
      }
    };

    await ctx.stage("projects", async () => {
      requireOwnerConfirmation();
      if (!deps.opportunityProjects) {
        throw new StageFailure(
          "project_seam_unconfigured",
          "The Content Project seam is not configured; a selection cannot start a Project.",
        );
      }
      if (!projectInput) {
        throw new StageFailure(
          "project_input_missing",
          "The selection's Project inputs are missing; select the Opportunity again.",
        );
      }
      const started: NonNullable<ContentScoutRunResult["projects"]> = [];
      for (const opportunity of selected) {
        requireOwnerConfirmation();
        const result = await deps.opportunityProjects.start({
          runId: ctx.runId,
          opportunityId: opportunity.id,
          title: opportunity.title,
          angle: opportunity.angle,
          angleDescription: opportunity.angleDescription,
          urgency: opportunity.urgency,
          sourceUrls: opportunity.sourceItemReferences.map((reference) => reference.canonicalUrl),
          brandProfileRevisionId: shortlist.brandProfileRevisionId,
          project: projectInput,
        });
        started.push({
          opportunityId: opportunity.id,
          projectId: result.projectId,
          created: result.created,
        });
        ctx.event("content_project_started", {
          opportunityId: opportunity.id,
          projectId: result.projectId,
          created: result.created,
        });
      }
      const runResult = readRunResult(ctx);
      runResult.projects = started;
      ctx.writeFile("result.json", `${JSON.stringify(runResult, null, 2)}\n`);
    });

    const active = deps.store.activeShortlist();
    if (
      active?.runId === ctx.runId &&
      active.opportunities.some((item) => item.state === "ready")
    ) {
      await ctx.stage("selection", async () => {
        ctx.wait({
          reason: "Ready opportunities remain. Choose up to three or skip this shortlist.",
          timeout: { kind: "none" },
        });
      });
    }

    return {
      status: "done",
      summary: `${selected.length} Content Project${selected.length === 1 ? "" : "s"} started`,
      detail: { contentProjects: selected.length },
    };
  };

  return {
    id: CONTENT_SCOUT_MODULE_ID,
    version: CONTENT_SCOUT_MODULE_VERSION,

    failureHint(stage): string {
      if (stage === "collect") {
        return "No Available Source Adapter completed. Check Sources and adapter diagnostics, then retry.";
      }
      if (stage === "rank") {
        return "The collected evidence could not be ranked into a shortlist. Retry the Run.";
      }
      if (stage === "projects") {
        return "A Content Project could not be started from a selected Opportunity. The selection is durable; retry starts only what is missing.";
      }
      return "Content Scout could not finish this Run.";
    },

    planRetry(meta: Readonly<RunMeta>): RetryPlan<ContentScoutInput> | null {
      if (meta.intake !== CONTENT_SCOUT_INTAKE || meta.status !== "failed") return null;
      const action = deps.store.pendingAction(meta.id);
      if (action?.kind === "selection") {
        return {
          fromStage: meta.failedStage ?? "draft",
          reason: "selected_opportunities_are_durable",
          input: { kind: "selection", opportunityIds: action.opportunityIds },
        };
      }
      return {
        fromStage: meta.failedStage ?? "collect",
        reason: "failed_collection_stage",
        input: { kind: "intake", invocation: "manual" },
      };
    },

    planResume(meta) {
      if (meta.intake !== CONTENT_SCOUT_INTAKE || meta.status !== "blocked") return null;
      const action = deps.store.pendingAction(meta.id);
      if (action?.kind === "selection") {
        return {
          fromStage: "draft",
          reason: "person_selected_opportunities",
          input: { kind: "selection", opportunityIds: action.opportunityIds },
        };
      }
      return action?.kind === "skip"
        ? { fromStage: "selection", reason: "person_skipped_shortlist", input: { kind: "skip" } }
        : null;
    },

    planRecovery(meta) {
      if (
        meta.intake !== CONTENT_SCOUT_INTAKE ||
        (meta.status !== "pending" && meta.status !== "running")
      )
        return null;
      const action = deps.store.pendingAction(meta.id);
      if (action?.kind === "selection") {
        return {
          fromStage: meta.failedStage ?? "draft",
          reason: "durable_selection_survived_restart",
          input: { kind: "selection", opportunityIds: action.opportunityIds },
        };
      }
      return {
        fromStage: meta.failedStage ?? "collect",
        reason: "orphaned_content_scout_run",
        input: { kind: "intake", invocation: "scheduled" },
      };
    },

    async run(ctx, input): Promise<RunOutcome> {
      if (input.kind === "selection") {
        return await selectedRun(ctx, input.opportunityIds);
      }
      if (input.kind === "skip") {
        deps.store.clearPendingAction(ctx.runId);
        return { status: "skipped", reason: "The shortlist was skipped." };
      }

      let brandProfile = deps.store.currentBrandProfile();
      const targets = deps.store.listSourceTargets().filter((target) => target.state === "active");
      const rows: ContentScoutRunResult["adapters"] = [];
      const diagnostics: AdapterDiagnostic[] = [];
      const items: SourceItem[] = [];
      let availableCompleted = 0;
      let enrichmentWarnings = 0;

      await ctx.stage("collect", async () => {
        if (!brandProfile) {
          throw new StageFailure(
            "brand_profile_missing",
            "Create and accept a Brand Profile before running Content Scout.",
          );
        }
        const progress =
          parseArtifact<CollectedSourceTargetProgress[]>(ctx, "collection-progress.json") ?? [];
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
        const attemptOffsets = Object.fromEntries(
          targets.map((target) => [
            target.id,
            Math.max(
              0,
              ...attemptReceipts
                .filter((receipt) => receipt.targetId === target.id)
                .map((receipt) => receipt.attempt),
            ),
          ]),
        );
        const collected = await collectSourceTargets({
          targets,
          adapters: deps.adapters,
          now: deps.now,
          sleep: deps.sleep,
          collectionStart,
          previous: progress,
          attemptOffsets,
          attemptCompleted: ({ target, result, attempts }) => {
            const receipt = attempts.at(-1)!;
            if (result.diagnosticBody) {
              deps.recordSanitizedDiagnostic?.(
                `${ctx.runId}-${safePart(target.id)}-${receipt.attempt}`,
                result.diagnosticBody.contentType,
                result.diagnosticBody.body,
              );
            }
            if (result.kind === "completed") {
              deps.store.recordCollectionSuccess(
                target.id,
                result.checkpoint,
                result.conditional ?? target.conditional,
              );
            }
            const persistedResult: SourceCollectionResult = { ...result };
            delete persistedResult.diagnosticBody;
            const progressEntry = {
              targetId: target.id,
              result: persistedResult,
              attempts,
            } satisfies CollectedSourceTargetProgress;
            const existingProgress = progress.findIndex((entry) => entry.targetId === target.id);
            if (existingProgress === -1) progress.push(progressEntry);
            else progress[existingProgress] = progressEntry;
            ctx.writeFile("collection-progress.json", `${JSON.stringify(progress, null, 2)}\n`);
            if (
              !attemptReceipts.some(
                (candidate) =>
                  candidate.targetId === target.id && candidate.attempt === receipt.attempt,
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
        for (const { target, adapter, result, attempts } of collected) {
          diagnostics.push(result.diagnostic);
          items.push(...result.items);
          addAdapterResult(rows, { target, adapter, result, attempts });
          for (const attempt of attempts) {
            ctx.event("source_adapter_attempted", {
              adapterId: adapter.id,
              targetId: target.id,
              attempt: attempt.attempt,
              outcome: attempt.outcome,
              backoffMs: attempt.backoffMs,
            });
          }
          if (result.kind === "completed") {
            if (adapter.state === "available") availableCompleted += 1;
            ctx.event("source_adapter_completed", {
              adapterId: adapter.id,
              targetId: target.id,
              outcome: result.outcome,
              itemsFound: result.items.length,
            });
          } else {
            ctx.event("source_adapter_failed", {
              adapterId: adapter.id,
              targetId: target.id,
              outcome: result.outcome,
            });
          }
        }
        ctx.writeFile("source-items.json", `${JSON.stringify(items, null, 2)}\n`);
        ctx.writeFile("adapter-diagnostics.json", `${JSON.stringify(diagnostics, null, 2)}\n`);
        ctx.writeFile("collection-attempts.json", `${JSON.stringify(attemptReceipts, null, 2)}\n`);
        reconcileAttemptHistory(rows, attemptReceipts);
        ctx.writeFile(
          "result.json",
          `${JSON.stringify(
            {
              adapters: rows,
              shortlist: { opportunityCount: 0, omittedCount: 0 },
              warnings: adapterWarningCount(rows),
            } satisfies ContentScoutRunResult,
            null,
            2,
          )}\n`,
        );
        if (availableCompleted === 0) {
          throw new StageFailure(
            "no_available_adapter_completed",
            "No Available Source Adapter completed. Check Sources and adapter diagnostics, then retry.",
          );
        }
      });

      await ctx.stage("rank", async () => {
        brandProfile ??= deps.store.currentBrandProfile();
        const eligibility = determineEligibility({
          items,
          targets: deps.store.listSourceTargets(),
          brandProfile: brandProfile!,
          now: deps.now(),
        });
        ctx.writeFile("eligibility.json", `${JSON.stringify(eligibility, null, 2)}\n`);

        const { promising, discarded } = filterPromisingItems({
          items: eligibility.items,
          targets: deps.store.listSourceTargets(),
          brandProfile: brandProfile!,
          now: deps.now(),
        });
        ctx.writeFile("promising-items.json", `${JSON.stringify(promising, null, 2)}\n`);
        ctx.writeFile("discarded-items.json", `${JSON.stringify(discarded, null, 2)}\n`);

        for (const adapter of deps.adapters) {
          if (!adapter.enrich) continue;
          const owned = promising.filter((item) => item.adapterId === adapter.id);
          if (owned.length === 0) continue;
          try {
            const enriched = await adapter.enrich(owned);
            const replacements = new Map(enriched.map((item) => [item.id, item]));
            for (let index = 0; index < promising.length; index += 1) {
              const replacement = replacements.get(promising[index]!.id);
              if (replacement) promising[index] = replacement;
            }
            for (const item of enriched) {
              if (item.comments.length > CONTENT_SCOUT_MAX_COMMENTS) {
                item.comments = selectDiverseComments(item.comments, CONTENT_SCOUT_MAX_COMMENTS);
              }
            }
          } catch (error) {
            enrichmentWarnings += 1;
            const message = error instanceof Error ? error.message : String(error);
            ctx.event("enrichment_failed", { adapterId: adapter.id, error: message });
            for (const item of owned) {
              item.completeness = {
                ...item.completeness,
                transcript:
                  item.completeness.transcript === "unsupported" ? "unsupported" : "failed",
                comments: item.completeness.comments === "unsupported" ? "unsupported" : "failed",
                media: item.completeness.media === "unsupported" ? "unsupported" : "failed",
              };
            }
          }
        }
        ctx.writeFile("enriched-source-items.json", `${JSON.stringify(promising, null, 2)}\n`);

        const enrichedItemsById = new Map(promising.map((item) => [item.id, item]));
        const rankedItems = eligibility.items.map((item) => enrichedItemsById.get(item.id) ?? item);
        const sourceUrlByItemId = new Map(rankedItems.map((item) => [item.id, item.canonicalUrl]));
        const ranked = enforceOpportunityIdentity({
          ranked: await deps.ranker.rank({
            brandProfile: brandProfile!,
            items: rankedItems,
            storyGroups: eligibility.storyGroups,
            limit: 10,
          }),
          items: rankedItems,
          storyGroups: eligibility.storyGroups,
          adapterStates: new Map(deps.adapters.map((adapter) => [adapter.id, adapter.state])),
        }).flatMap((opportunity) => {
          const sourceItemReferences = opportunity.sourceItemIds.flatMap((id) => {
            const canonicalUrl = sourceUrlByItemId.get(id);
            return canonicalUrl ? [{ id, canonicalUrl }] : [];
          });
          const disposition = deps.store.opportunityCooldownDisposition(
            opportunity,
            sourceItemReferences,
          );
          return disposition.eligible
            ? [
                {
                  ...opportunity,
                  earlyFollowUp: disposition.earlyFollowUp,
                  sourceItemReferences,
                },
              ]
            : [];
        });
        const shown = ranked.slice(0, deps.shortlistSize?.() ?? 5);
        const shortlist: ContentShortlist = {
          runId: ctx.runId,
          createdAt: deps.now().toISOString(),
          brandProfileRevisionId: brandProfile!.id,
          opportunities: shown.map((opportunity) => ({
            ...opportunity,
            state: "ready",
            decision: null,
          })),
          omittedCount: Math.max(0, ranked.length - shown.length),
          supersededByRunId: null,
        };
        const previous = deps.store.installShortlist(shortlist);
        if (previous && previous.runId !== ctx.runId) {
          deps.supersede?.(previous.runId, ctx.runId);
        }
        ctx.writeFile("shortlist.json", `${JSON.stringify(shortlist, null, 2)}\n`);
        const runResult = readRunResult(ctx);
        runResult.adapters = rows;
        runResult.shortlist = {
          opportunityCount: shown.length,
          omittedCount: shortlist.omittedCount,
        };
        runResult.warnings = adapterWarningCount(rows) + enrichmentWarnings;
        ctx.writeFile("result.json", `${JSON.stringify(runResult, null, 2)}\n`);
        ctx.event("shortlist_ranked", {
          opportunities: shown.length,
          omitted: shortlist.omittedCount,
        });
        deps.intakeCompleted?.(ctx.meta().externalId);
      });

      await ctx.stage("selection", async () => {
        ctx.wait({
          reason: "Choose up to three opportunities or skip this shortlist.",
          timeout: { kind: "none" },
        });
      });
      throw new Error("selection wait unexpectedly returned");
    },
  };
}
