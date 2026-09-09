import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TranscriptRecord } from "@chief-of-staff-demo/shared";
import { registerTranscriptRelevanceApi } from "../../../apps/server/src/api/transcript-review";
import {
  TRANSCRIPT_RELEVANCE_INDEX_VERSION,
  TranscriptRelevanceService,
} from "../../../apps/server/src/transcript-catalog/relevance";
import { TranscriptRelevanceStore } from "../../../apps/server/src/transcript-catalog/relevance-store";

/**
 * The semantic relevance Review surface (issue #127): the owner searches the
 * retained corpus, reads bounded cited results with their diagnostics, and
 * records confirm / reject / unresolved decisions over a real server on a
 * temporary Workspace.
 */
const NOW = () => new Date("2026-08-31T12:00:00.000Z");

function record(
  id: string,
  fileName: string,
  text: string,
  meetingDate: string | null,
): TranscriptRecord {
  return {
    id,
    source: {
      sourceSystem: "drive",
      externalFileId: id,
      fileName,
      sourceUrl: null,
      checksum: `checksum-${id}`,
      observedRevision: 1,
      modifiedAt: null,
    },
    ingestedAt: "2026-08-31T12:00:00.000Z",
    extractorVersion: 1,
    normalizedText: text,
    meetingDate,
    occurrence: null,
    speakers: [],
    speakerIdentityMappings: [],
    roster: [],
    meetingId: null,
  };
}

const CORPUS: TranscriptRecord[] = [
  record(
    "drive_sync_r1",
    "Weekly Product Sync — 2026-08-17.md",
    "[00:00] Sam: We got six reports of the export button timing out on large accounts.\n[00:30] Priya: The synchronous export path needs to move to a background job.",
    "2026-08-17",
  ),
  record(
    "drive_board_r1",
    "Board Prep — 2026-08-19.md",
    "[00:00] Jordan: Board prep — the investor update draft is due Thursday.",
    "2026-08-19",
  ),
];

let app: FastifyInstance;
let workspaceDir: string;
let service: TranscriptRelevanceService;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-transcript-review-"));
  service = new TranscriptRelevanceService({
    corpus: { listTranscripts: () => CORPUS },
    store: new TranscriptRelevanceStore(workspaceDir),
    now: NOW,
  });
  app = fastify();
  registerTranscriptRelevanceApi(app, { relevance: service });
  return app.ready();
});

afterEach(async () => {
  await app.close();
});

async function search(text: string): Promise<{ items: unknown[] }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/transcripts/review/relevance/search",
    payload: { text },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

describe("POST /api/transcripts/review/relevance/search", () => {
  it("returns bounded cited results with query context, explanation, and index version", async () => {
    const { items } = await search("export button timing out");
    expect(items).toHaveLength(1);
    const item = items[0] as {
      candidate: Record<string, unknown>;
      decision: unknown;
      reviewState: string;
    };
    expect(item.reviewState).toBe("pending");
    expect(item.decision).toBeNull();
    expect(item.candidate.sourceContext).toEqual({
      fileName: "Weekly Product Sync — 2026-08-17.md",
      meetingDate: "2026-08-17",
      sourceUrl: null,
    });
    expect(item.candidate.relevanceVersion).toBe(String(TRANSCRIPT_RELEVANCE_INDEX_VERSION));
    expect(String(item.candidate.explanation)).toContain("export");
  });

  it("refuses a malformed meeting shape with a typed 400, not a 500", async () => {
    for (const meeting of [
      { title: 42 },
      { attendees: "Dana Okonkwo" },
      { topics: ["support", 7] },
      "not an object",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/transcripts/review/relevance/search",
        payload: { text: "export button timing out", meeting },
      });
      expect(response.statusCode, `meeting ${JSON.stringify(meeting)}`).toBe(400);
      expect(response.json().error).toBe("invalid-query");
    }
  });

  it("refuses an empty query", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/transcripts/review/relevance/search",
      payload: { text: "   " },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/transcripts/review/relevance", () => {
  it("lists the queue with review state, pending work first", async () => {
    await search("export button timing out");
    await search("investor update draft");

    const list = await app.inject({ method: "GET", url: "/api/transcripts/review/relevance" });
    expect(list.statusCode).toBe(200);
    const items = list.json<{ items: { reviewState: string }[] }>().items;
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.reviewState)).toEqual(["pending", "pending"]);

    const first = (await search("export button timing out")).items[0] as {
      candidate: { id: string };
    };
    await app.inject({
      method: "POST",
      url: `/api/transcripts/review/relevance/${first.candidate.id}/decision`,
      payload: { action: "confirm" },
    });
    const after = (
      await app.inject({ method: "GET", url: "/api/transcripts/review/relevance" })
    ).json<{
      items: { reviewState: string; candidate: { id: string } }[];
    }>();
    expect(after.items.map((item) => item.reviewState)).toEqual(["pending", "confirmed"]);
  });
});

describe("POST /api/transcripts/review/relevance/:candidateId/decision", () => {
  it("records a decision and returns the updated item", async () => {
    const { items } = await search("export button timing out");
    const candidate = (items[0] as { candidate: { id: string } }).candidate;

    const response = await app.inject({
      method: "POST",
      url: `/api/transcripts/review/relevance/${candidate.id}/decision`,
      payload: { action: "reject", note: "Not relevant to preparation." },
    });
    expect(response.statusCode).toBe(200);
    const { item } = response.json<{
      item: {
        reviewState: string;
        decision: { outcome: string; note: string | null };
      };
    }>();
    expect(item.reviewState).toBe("rejected");
    expect(item.decision.outcome).toBe("rejected");
    expect(item.decision.note).toBe("Not relevant to preparation.");
  });

  it("classifies an unknown candidate as 404 and a nonsense action as 400", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/api/transcripts/review/relevance/rel_unknown/decision",
      payload: { action: "confirm" },
    });
    expect(missing.statusCode).toBe(404);

    const { items } = await search("export button timing out");
    const candidate = (items[0] as { candidate: { id: string } }).candidate;
    const invalid = await app.inject({
      method: "POST",
      url: `/api/transcripts/review/relevance/${candidate.id}/decision`,
      payload: { action: "promote" },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
