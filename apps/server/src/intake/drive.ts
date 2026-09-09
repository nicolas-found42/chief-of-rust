import { google } from "googleapis";
import type { AppConfig } from "@chief-of-staff-demo/shared";
import { buildGoogleAuth } from "../google/oauth.js";

/**
 * The Workspace's Drive seam.
 *
 * This file used to hold the Transcript → Tasks poller as well: its own
 * interval, its own `ingestedIds` checkpoint, and its own conversion path into
 * a second set of Runs. That duplicate intake is retired (issue #142). The
 * Transcript Catalog is the sole private transcript intake writer now, and it
 * reads the same folder through the client below — one Drive client path, one
 * folder read, one ledger.
 *
 * `DriveFileClient` is a deliberate narrowing of the googleapis client to the
 * three calls this Workspace makes, which keeps every consumer honest about
 * what it actually touches.
 */
export interface DriveFileClient {
  files: {
    list: (params: Record<string, unknown>) => Promise<{
      data?: {
        files?: Array<{
          id?: string;
          name?: string;
          mimeType?: string;
          webViewLink?: string;
          size?: string;
          modifiedTime?: string;
        }>;
        nextPageToken?: string | null;
      };
    }>;
    get: (
      params: Record<string, unknown>,
      opts?: Record<string, unknown>,
    ) => Promise<{ data?: unknown }>;
    export: (
      params: Record<string, unknown>,
      opts?: Record<string, unknown>,
    ) => Promise<{ data?: unknown }>;
  };
}

export function buildDriveClient(config: AppConfig, port: number): DriveFileClient {
  const auth = buildGoogleAuth(config, port);
  /* The generated googleapis type is wider and differently optional than the
     narrowing above, so the assertion lives here, at the one place the real
     client is built. */
  return google.drive({ version: "v3", auth }) as unknown as DriveFileClient;
}
