import type { FastifyInstance } from "fastify";
import { CLEAR_GENERATED_DATA_CONFIRMATION } from "@chief-of-staff-demo/shared";
import type { ConfigStore } from "../config.js";
import {
  executeGeneratedDataClear,
  previewGeneratedData,
  type GeneratedDataClearReceipt,
  type GeneratedDataInventory,
} from "../clear-data/workspace.js";
import { googleFailureHint, type GoogleConnection } from "../google/connection.js";
import type { GoogleAuth } from "../google/oauth.js";
import {
  clearSpreadsheetDataRows,
  isSpreadsheetMissing,
  type ClearedTab,
} from "../google/sheets.js";
import type { ContentResearchStore } from "../modules/content-research/store.js";

/**
 * The repeatable generated-data clear's API: a read-only inventory of what the
 * Workspace holds, and the one confirmed action that empties it. The local
 * half is the fail-safe default (it always runs); the Sheets half is
 * best-effort and reported per destination, so a dropped Google connection
 * costs the rows in the cloud, never the reset itself.
 *
 * Google Tasks, Gmail drafts, the transcripts Drive folder and every
 * credential are outside the boundary by design: Tasks and drafts because the
 * owner said so, the folder because it is the seed the data came from, the
 * credentials because the action is a data clear, not a sign-out.
 */

/** One remote spreadsheet this app writes, and what happened to its rows. */
interface ClearedSheetOutcome {
  destination: "youtube-trends" | "content-research-ledger";
  outcome: "cleared" | "skipped" | "missing" | "failed";
  tabs?: number;
  rows?: number;
  reason?: string;
}

/** The confirm response: the local receipt plus each destination's outcome. */
interface ClearDataReceipt extends GeneratedDataClearReceipt {
  sheets: ClearedSheetOutcome[];
}

export interface ClearDataRouteDeps {
  workspaceDir: string;
  configStore: ConfigStore;
  google: Pick<GoogleConnection, "auth">;
  contentResearch: ContentResearchStore;
  /** Whether the Modules' schedulers are running right now. */
  modulesRunning: () => boolean;
  stopModules: () => void;
  startModules: (options: { seedV1Watchlist: boolean }) => Promise<void>;
  /** Resolves when every in-flight intake, wake-up and enqueued Run has settled. */
  drain: () => Promise<void>;
  /** Test seam: the Sheets row-delete, as the YouTube host takes a client seam. */
  clearRows?: (auth: GoogleAuth, spreadsheetId: string) => Promise<ClearedTab[]>;
}

interface ClearDestination {
  destination: ClearedSheetOutcome["destination"];
  spreadsheetId: string | null;
}

async function clearDestination(
  deps: ClearDataRouteDeps,
  entry: ClearDestination,
): Promise<ClearedSheetOutcome> {
  if (!entry.spreadsheetId) {
    return {
      destination: entry.destination,
      outcome: "skipped",
      reason: "No spreadsheet has been created for this destination.",
    };
  }
  const access = deps.google.auth();
  if (!access.ok) {
    return {
      destination: entry.destination,
      outcome: "skipped",
      reason: googleFailureHint(access.state),
    };
  }
  const clearRows = deps.clearRows ?? clearSpreadsheetDataRows;
  try {
    const cleared = await clearRows(access.auth, entry.spreadsheetId);
    return {
      destination: entry.destination,
      outcome: "cleared",
      tabs: cleared.length,
      rows: cleared.reduce((sum, tab) => sum + tab.rowsRemoved, 0),
    };
  } catch (error) {
    if (isSpreadsheetMissing(error)) {
      return {
        destination: entry.destination,
        outcome: "missing",
        reason: "The spreadsheet is gone from Google Drive; clear it from Settings instead.",
      };
    }
    return {
      destination: entry.destination,
      outcome: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function registerClearDataApi(app: FastifyInstance, deps: ClearDataRouteDeps): void {
  app.get("/api/clear-data/inventory", async (): Promise<GeneratedDataInventory> => {
    return previewGeneratedData(deps.workspaceDir);
  });

  app.post(
    "/api/clear-data/confirm",
    async (request, reply): Promise<ClearDataReceipt | undefined> => {
      const body = (request.body ?? {}) as { typedConfirmation?: unknown };
      const typedConfirmation =
        typeof body.typedConfirmation === "string" ? body.typedConfirmation : "";
      /* The phrase is checked before the Modules are stopped: a typo must not
       pause the product for nothing. */
      if (typedConfirmation !== CLEAR_GENERATED_DATA_CONFIRMATION) {
        reply.code(403).send({ error: "confirmation-mismatch" });
        return;
      }

      const startedAt = Date.now();
      /* Destinations are captured before the wipe: the Resonance Ledger's
       pointer lives inside people.json, which the wipe deletes whole. */
      const ledgerRef = deps.contentResearch.getLedger();
      const destinations: ClearDestination[] = [
        {
          destination: "youtube-trends",
          spreadsheetId: deps.configStore.get().modules["youtube-trends"].spreadsheetId || null,
        },
        { destination: "content-research-ledger", spreadsheetId: ledgerRef.spreadsheetId },
      ];

      /* The wipe never deletes runs/ under an in-flight execute: the schedulers
       stop taking new work, then everything enqueued settles (issue #144's
       quiesce, applied to a live Workspace instead of a gated one). */
      const wasRunning = deps.modulesRunning();
      if (wasRunning) {
        deps.stopModules();
        await deps.drain();
      }
      const result = executeGeneratedDataClear(deps.workspaceDir, { typedConfirmation });
      if (result.outcome === "confirmation-mismatch") {
        reply.code(403).send({ error: "confirmation-mismatch" });
        return;
      }

      /* The same, now-emptied Resonance Ledger stays the destination: the
       pointer is configuration, not generated data, and losing it would have
       the next Run create a second spreadsheet beside the emptied one. */
      if (ledgerRef.spreadsheetId) {
        deps.contentResearch.setLedger({
          spreadsheetId: ledgerRef.spreadsheetId,
          spreadsheetUrl: ledgerRef.spreadsheetUrl,
        });
      }

      const sheets: ClearedSheetOutcome[] = [];
      for (const entry of destinations) {
        sheets.push(await clearDestination(deps, entry));
      }

      /* The Modules resume on the emptied Workspace. The V1 watchlist seed is
       deliberately withheld: the seed would re-create Person Profiles and
       watches, and a cleared Workspace holds no data, not demo data. */
      if (wasRunning) {
        await deps.startModules({ seedV1Watchlist: false });
      }

      return {
        schemaVersion: 1,
        clearedAt: result.receipt.clearedAt,
        durationMs: Date.now() - startedAt,
        local: result.receipt.local,
        sheets,
      };
    },
  );
}
