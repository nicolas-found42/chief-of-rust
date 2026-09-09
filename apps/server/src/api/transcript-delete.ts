import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  TranscriptDeletionReceipt,
  TranscriptRecord,
  TranscriptSummary,
  TranscriptDeletionTombstone,
} from "@chief-of-staff-demo/shared";
import { TranscriptDeletionError } from "../transcript-catalog/deletion.js";
import type { TranscriptDeletionService } from "../transcript-catalog/deletion.js";
import type { TranscriptCatalogStore } from "../transcript-catalog/store.js";

export interface TranscriptDeletionApiContext {
  catalog: TranscriptCatalogStore;
  /** The deletion cascade; routes stay thin over it (issue #128). */
  deletion: TranscriptDeletionService;
}

/** Metadata only: a listing never carries the retained transcript text. */
function summaryOf(record: TranscriptRecord): TranscriptSummary {
  return {
    id: record.id,
    externalFileId: record.source.externalFileId,
    fileName: record.source.fileName,
    sourceUrl: record.source.sourceUrl,
    meetingDate: record.meetingDate,
    ingestedAt: record.ingestedAt,
  };
}

/**
 * The transcript deletion surface (issue #128). Like Person Profiles and the
 * relevance Review lane, transcript lifecycle work is a Workspace resource,
 * not a hosted Module: its routes hang off the Shell under /api/transcripts
 * and stay thin over the deletion cascade, which owns the tombstone, the
 * consumer cascades, and the zero-remote-operations guarantee.
 */
export function registerTranscriptDeletionApi(
  app: FastifyInstance,
  ctx: TranscriptDeletionApiContext,
): void {
  const deletion = ctx.deletion;
  const catalog = ctx.catalog;

  app.get("/api/transcripts", async () => ({
    transcripts: catalog
      .listTranscripts()
      .map(summaryOf)
      .sort((left, right) => left.id.localeCompare(right.id)),
  }));

  /* Static segments win over the :id route below, so tombstone reads do not
     depend on registration order. */
  app.get("/api/transcripts/tombstones", async () => ({ tombstones: deletion.tombstones() }));

  app.post(
    "/api/transcripts/tombstones/:externalFileId/restore",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { externalFileId } = request.params as { externalFileId: string };
      const restored = deletion.restoreProcessingPermission(externalFileId);
      if (restored === null) {
        reply.code(404);
        return {
          error: "tombstone-not-found",
          message: "No deleted source stands behind that file id.",
        };
      }
      return restored;
    },
  );

  app.get("/api/transcripts/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const record = catalog.readTranscript(id);
    if (record) return summaryOf(record);
    const receipt = deletion.deletionReceipt(id);
    /* A deleted transcript's route stays resolvable while its tombstone
       stands; once the owner restores processing permission the source may
       be reingested, so the record is simply gone again. */
    if (receipt && deletion.tombstone(receipt.externalFileId)) {
      reply.code(410);
      const deleted: {
        error: string;
        message: string;
        tombstone: TranscriptDeletionTombstone;
        receipt: TranscriptDeletionReceipt;
      } = {
        error: "transcript-deleted",
        message:
          "This transcript was deleted from the local Workspace; its source file will not be reingested until processing permission is restored.",
        tombstone: receipt.tombstone,
        receipt,
      };
      return deleted;
    }
    reply.code(404);
    return { error: "transcript-not-found", message: `Unknown transcript: ${id}` };
  });
  app.get(
    "/api/transcripts/:id/deletion-preview",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const record = catalog.readTranscript(id);
      if (!record) {
        reply.code(404);
        return { error: "transcript-not-found", message: `Unknown transcript: ${id}` };
      }
      const preview = deletion.preview(id);
      return { transcript: summaryOf(record), consumerRecords: preview.consumerRecords };
    },
  );

  app.post("/api/transcripts/:id/delete", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { confirmation?: unknown };
    try {
      return deletion.delete(id, {
        confirmation: typeof body.confirmation === "string" ? body.confirmation : "",
      });
    } catch (error: unknown) {
      if (error instanceof TranscriptDeletionError) {
        const deleted = error.code === "transcript-not-found" ? deletion.deletionReceipt(id) : null;
        reply.code(deleted ? 410 : error.code === "confirmation-required" ? 400 : 404);
        if (deleted) {
          return { error: "transcript-already-deleted", tombstone: deleted.tombstone };
        }
        return { error: error.code, message: error.message };
      }
      throw error;
    }
  });
}
