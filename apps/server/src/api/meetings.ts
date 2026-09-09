import type { FastifyInstance } from "fastify";
import { MeetingJoinError, type WorkspaceMeetingJoin } from "../meetings/join.js";
import type { WorkspaceMeetings } from "../meetings/store.js";

export interface MeetingsApiContext {
  /** The Workspace's Meetings (ADR-0050); routes stay thin over the store. */
  meetings: WorkspaceMeetings;
  /** The Meeting join owning match, attach, and merge (issue #165). */
  join: WorkspaceMeetingJoin;
}

/**
 * The Meeting resource (ADR-0050).
 *
 * A Meeting is addressed by its own identity, never by its Calendar occurrence
 * key, because a Meeting created from a Transcript alone has no occurrence key
 * to be addressed by. `/api/meetings/overview` stays where it is: Fastify
 * prefers the static segment over the parameter, so the two do not collide.
 */
export function registerMeetingsApi(app: FastifyInstance, ctx: MeetingsApiContext): void {
  app.get("/api/meetings/list", async () => ctx.meetings.index());

  app.get("/api/meetings/:meetingId", async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    const meeting = ctx.meetings.get(meetingId);
    if (!meeting) {
      reply.code(404).send({ error: "meeting-not-found" });
      return;
    }
    return meeting;
  });

  /* The Transcripts the Catalog has matched to this Meeting (issue #153). */
  app.get("/api/meetings/:meetingId/transcripts", async (request) => {
    const { meetingId } = request.params as { meetingId: string };
    return { transcripts: ctx.join.transcriptsForMeeting(meetingId) };
  });

  /* Nearest Meetings for a transcript-owned Meeting, for the merge UI (issue #154). */
  app.get("/api/meetings/:meetingId/near-matches", async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    try {
      return { nearMatches: ctx.join.nearMatchesFor(meetingId) };
    } catch (error) {
      if (error instanceof MeetingJoinError && error.code === "meeting-not-found") {
        reply.code(404).send({ error: "meeting-not-found" });
        return;
      }
      throw error;
    }
  });

  /*
   * Carry a transcript-owned Meeting's Transcripts across to the Calendar
   * Meeting they belong to, then forget the transcript-owned shell, so
   * exactly one Meeting remains (issue #154). The source must be
   * transcript-owned: a Calendar Meeting is never deleted by a merge.
   */
  app.post("/api/meetings/:meetingId/merge", async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    const { targetOccurrenceKey } = (request.body ?? {}) as { targetOccurrenceKey?: unknown };
    if (typeof targetOccurrenceKey !== "string") {
      reply.code(400).send({ error: "target-occurrence-key-required" });
      return;
    }
    try {
      return await ctx.join.mergeTranscriptShell(meetingId, targetOccurrenceKey);
    } catch (error) {
      if (!(error instanceof MeetingJoinError)) throw error;
      const status =
        error.code === "meeting-not-found" || error.code === "target-meeting-not-found" ? 404 : 400;
      reply.code(status).send({ error: error.code });
      return;
    }
  });
}
