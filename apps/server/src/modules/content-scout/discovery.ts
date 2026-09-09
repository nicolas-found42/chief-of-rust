import type { RunMeta } from "@chief-of-staff-demo/shared";
import { CONTENT_SCOUT_MODULE_ID, CONTENT_SCOUT_MODULE_VERSION } from "@chief-of-staff-demo/shared";
import { StageFailure, type RetryPlan, type ShellModule } from "../../engine/module.js";
import type { RunOutcome } from "../../runs.js";
import type { SourceDiscoverer } from "./ports.js";
import type { ContentScoutStore } from "./store.js";

export const CONTENT_SCOUT_DISCOVERY_INTAKE = "source-discovery";

export interface ContentScoutDiscoveryInput {
  invocation: "manual" | "scheduled";
}

export function contentScoutDiscoveryModule(deps: {
  store: ContentScoutStore;
  discoverer: SourceDiscoverer;
  discoveryCompleted?: (period: string | null) => void;
}): ShellModule<ContentScoutDiscoveryInput> {
  return {
    id: CONTENT_SCOUT_MODULE_ID,
    version: CONTENT_SCOUT_MODULE_VERSION,
    failureHint: () =>
      "Source Discovery could not produce suggestions. Approved Sources were not changed.",
    planRetry(meta: Readonly<RunMeta>): RetryPlan<ContentScoutDiscoveryInput> | null {
      return meta.intake === CONTENT_SCOUT_DISCOVERY_INTAKE && meta.status === "failed"
        ? {
            fromStage: meta.failedStage ?? "discover",
            reason: "failed_discovery_stage",
            input: { invocation: "manual" },
          }
        : null;
    },
    planRecovery(meta) {
      return meta.intake === CONTENT_SCOUT_DISCOVERY_INTAKE &&
        (meta.status === "pending" || meta.status === "running")
        ? {
            fromStage: meta.failedStage ?? "discover",
            reason: "orphaned_discovery_run",
            input: { invocation: "scheduled" },
          }
        : null;
    },
    async run(ctx): Promise<RunOutcome> {
      let count = 0;
      await ctx.stage("discover", async () => {
        const brandProfile = deps.store.currentBrandProfile();
        if (!brandProfile) {
          throw new StageFailure(
            "brand_profile_missing",
            "Accept a Brand Profile before Source Discovery.",
          );
        }
        const proposals = await deps.discoverer.discover({
          brandProfile,
          approvedTargets: deps.store.listSourceTargets(),
        });
        const saved = deps.store.saveSourceSuggestions(proposals);
        count = saved.length;
        ctx.writeFile("source-suggestions.json", `${JSON.stringify(saved, null, 2)}\n`);
        ctx.writeFile("result.json", `${JSON.stringify({ suggestions: count }, null, 2)}\n`);
        ctx.event("source_suggestions_created", { count });
        deps.discoveryCompleted?.(ctx.meta().externalId);
      });
      return { status: "done", summary: `${count} new Source Suggestion${count === 1 ? "" : "s"}` };
    },
  };
}
