import type { FastifyInstance, FastifyReply } from "fastify";
import type { TranscriptCatalog } from "../transcript-catalog/catalog.js";
import type { TranscriptCatalogRuntime } from "../transcript-catalog/production.js";

export interface TranscriptIntakeApiContext {
  catalog: TranscriptCatalog;
  /** Remembered intake facts — configuration and this process's last pass. */
  intakeStatus: TranscriptCatalogRuntime["intakeStatus"];
}

/**
 * The Transcript Catalog's intake surface (issue #142). Like deletion and
 * relevance review, the Catalog is a Workspace resource rather than a hosted
 * Module, so its routes hang off the Shell under /api/transcripts and stay
 * thin over the service, which owns consent, the ledger, and registration.
 *
 * These replace Transcript → Tasks' `/api/drive/sync` and `/api/intake/drive`:
 * the same folder, read once, by the sole intake writer.
 */
export function registerTranscriptIntakeApi(
  app: FastifyInstance,
  ctx: TranscriptIntakeApiContext,
): void {
  const catalog = ctx.catalog;

  /* Remembered facts only: consent, the ledger's counts, whether a backfill
     is paused. Makes no Google call. */
  app.get("/api/transcripts/intake", async () => ({
    ...ctx.intakeStatus(),
    catalog: catalog.status(),
  }));

  /* The pre-consent inventory. Content-free by construction — the file
     listing is read, never a file's bytes — so nothing is mined before the
     operator has seen what consent covers. */
  app.get("/api/transcripts/intake/inventory", async (_request, reply: FastifyReply) => {
    try {
      return await catalog.inventory();
    } catch (error) {
      reply.code(502);
      return {
        error: "inventory-unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  app.post("/api/transcripts/intake/consent", async (_request, reply: FastifyReply) => {
    try {
      await catalog.grantConsent();
      return catalog.status();
    } catch (error) {
      reply.code(502);
      return {
        error: "consent-failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  /* One pass on demand. The periodic pass runs on the configured Drive
     interval; this is the operator asking for it now. */
  app.post("/api/transcripts/intake/sync", async (_request, reply: FastifyReply) => {
    try {
      return await catalog.processAvailable();
    } catch (error) {
      reply.code(502);
      return {
        error: "sync-failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
