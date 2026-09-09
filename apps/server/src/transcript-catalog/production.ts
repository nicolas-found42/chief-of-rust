import type { AppConfig, DriveIntakeStatus } from "@chief-of-staff-demo/shared";
import { buildDriveClient } from "../intake/drive.js";
import type { GoogleConnection } from "../google/connection.js";
import type { WorkspacePersonProfiles } from "../person-profile/profiles.js";
import {
  ConsentRequiredError,
  TranscriptCatalog,
  type TranscriptDebriefProcessor,
} from "./catalog.js";
import { createDriveCatalogSource } from "./drive-source.js";
import type { TranscriptIdentityService } from "./identity.js";

/**
 * Production composition of the Transcript Catalog (issue #142, completing the
 * #126 hand-forward).
 *
 * Until now only the Catalog's *store* was composed in production: the
 * ingestion service — consent, the processing ledger, and immutable record
 * registration — existed but was constructed nowhere outside tests and the
 * browser-suite seed. Transcript → Tasks was therefore still the only thing
 * reading the transcript folder, which is exactly the duplicate intake #142
 * retires. This is the replacement it is retired in favour of.
 *
 * The Catalog polls nothing on its own: a pass processes what the source
 * lists, and the caller decides when a pass runs. That keeps one Drive client,
 * one folder read, and one checkpoint in the Workspace.
 */
export interface TranscriptCatalogRuntimeOptions {
  workspaceDir: string;
  port: number;
  google: GoogleConnection;
  /**
   * The Workspace's one identity service. Built by the Shell rather than
   * here: the Person Profiles product and the Meeting Debrief ask it the
   * same questions over the same directory, and a service constructed
   * privately in here is one nothing outside this file can be seen to hold.
   */
  identity: TranscriptIdentityService;
  people: WorkspacePersonProfiles;
  getConfig: () => AppConfig;
  /** Disclosed in the pre-consent inventory, so consent is informed. */
  getLlmInfo: () => { provider: string; model: string };
  /** The Meeting Debrief hand-off; absent, mining still completes. */
  debrief?: TranscriptDebriefProcessor;
  log?: (message: string) => void;
}

export interface TranscriptCatalogRuntime {
  catalog: TranscriptCatalog;
  /**
   * What the intake remembers: its configuration and the last completed pass
   * of this process. It asks Google nothing (ADR-0008), and after a restart it
   * claims no last-checked time it does not have — the pass fact is held in
   * memory rather than as a durable checkpoint, because the Catalog's ledger
   * is already the durable record of what was processed.
   */
  /** Configuration and this process's last pass. The Catalog's own ledger is
   *  added by the route, which reads it from the Catalog itself. */
  intakeStatus(): Omit<DriveIntakeStatus, "catalog">;
  /** Begins the periodic processing pass at the configured Drive interval. */
  start(): void;
  stop(): void;
  /**
   * Resolves when the in-flight intake pass — and any Module Run it enqueued —
   * has settled. The migration gate's quiesce seam (issue #144): arming the
   * gate waits on it before the reset deletes Workspace state.
   */
  drain(): Promise<void>;
}

export function createTranscriptCatalogRuntime(
  options: TranscriptCatalogRuntimeOptions,
): TranscriptCatalogRuntime {
  const log = options.log ?? (() => {});
  const identity = options.identity;

  const config = options.getConfig();
  /* The disclosure is read per inventory, so a provider or model edited in
     Settings is what the next consent decision names (#198). The Drive client
     and folder stay composition-time: they change through consent, which is
     this runtime's own restart seam. */
  const catalog = new TranscriptCatalog({
    workspaceDir: options.workspaceDir,
    source: createDriveCatalogSource(buildDriveClient(config, options.port), {
      folderId: config.drive.folderId,
      folderName: config.drive.folderName || null,
    }),
    disclosure: () => {
      const llm = options.getLlmInfo();
      return { provider: llm.provider, model: llm.model };
    },
    identity,
    ...(options.debrief ? { debrief: options.debrief } : {}),
    log,
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  let lastPassAt: string | null = null;
  let lastPassOutcome: "ok" | "failed" | null = null;
  /* One pass at a time, over one settled promise: the migration gate's arm
     seam drains it before the reset deletes Workspace state (issue #144). */
  let pending: Promise<void> = Promise.resolve();
  const runPass = (): void => {
    pending = pending
      .catch(() => undefined)
      .then(pass)
      .catch((error: unknown) => {
        log(
          `transcript catalog pass failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };

  /**
   * One pass, guarded. Consent, an unconfigured folder and a disconnected
   * Google account all mean "there is nothing to read yet", not an error to
   * surface on a timer — the Catalog itself refuses without consent, and the
   * operator sees the reason on the intake surface rather than in a log loop.
   * A guarded skip is not an attempt: neither lastPassAt nor lastPassOutcome
   * moves, so the /runs liveness line cannot claim a failed check that never
   * ran.
   */
  const pass = async (): Promise<void> => {
    const current = options.getConfig();
    if (!current.drive.enabled || !current.drive.folderId) return;
    const status = await options.google.state();
    if (status.state !== "connected") return;
    try {
      await catalog.processAvailable();
      lastPassOutcome = "ok";
    } catch (error) {
      if (error instanceof ConsentRequiredError) return;
      lastPassOutcome = "failed";
      log(
        `transcript catalog pass failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    lastPassAt = new Date().toISOString();
  };

  return {
    catalog,
    intakeStatus(): Omit<DriveIntakeStatus, "catalog"> {
      const current = options.getConfig();
      return {
        enabled: current.drive.enabled,
        configured: Boolean(current.drive.folderId),
        folderName: current.drive.folderName,
        pollIntervalMinutes: current.drive.pollIntervalMinutes,
        lastPollAt: lastPassAt,
        lastPollOutcome: lastPassOutcome,
      };
    },
    start(): void {
      if (timer !== null) return;
      const minutes = options.getConfig().drive.pollIntervalMinutes;
      timer = setInterval(runPass, minutes * 60_000);
      /* Node keeps the process alive for a timer; intake must not be the
         reason a shutdown hangs. */
      timer.unref();
      runPass();
    },
    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    async drain(): Promise<void> {
      await pending;
    },
  };
}
