import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEETING_DEBRIEF_MODULE_ID,
  MEETING_DEBRIEF_STAGES,
  type IdentityDecision,
  type MeetingDebriefExtraction,
  type MeetingDebriefRunResult,
  type TranscriptMention,
  type TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import {
  MeetingDebriefHost,
  type DebriefIdentityReview,
} from "../../../apps/server/src/modules/meeting-debrief/host";
import type {
  DebriefCatalogReader,
  DebriefIdentityReviewReader,
  DebriefExtractInput,
} from "../../../apps/server/src/modules/meeting-debrief/module";
import { openRuns, type Runs } from "../../../apps/server/src/runs";

function makeRecord(overrides: Partial<TranscriptRecord> = {}): TranscriptRecord {
  return {
    id: "drive_fileA_r1",
    source: {
      sourceSystem: "drive",
      externalFileId: "fileA",
      fileName: "Weekly sync - 2026-08-17T13-00-00.000Z.md",
      sourceUrl: null,
      checksum: "deadbeef",
      observedRevision: 1,
      modifiedAt: null,
    },
    ingestedAt: "2026-08-31T12:00:00.000Z",
    extractorVersion: 1,
    normalizedText: "Alice: We decided to ship on Friday.\nBob: I will own the follow-up.\n",
    meetingDate: "2026-08-17",
    occurrence: null,
    speakers: ["Alice", "Bob"],
    speakerIdentityMappings: [],
    roster: [],
    meetingId: null,
    ...overrides,
  };
}

function makeMention(
  id: string,
  surfaceText: string,
  transcriptId = "drive_fileA_r1",
): TranscriptMention {
  return {
    id,
    kind: "person",
    surfaceText,
    normalizedForms: [surfaceText.toLowerCase()],
    emails: [],
    profileUrls: [],
    verifiedHandles: {},
    externalContactIds: [],
    speakerCalendarEmail: null,
    titles: [],
    roles: [],
    aliases: [],
    relationshipAssertions: [],
    rosterContext: [],
    organizationContext: null,
    attendeeStatus: "speaker",
    confidence: "high",
    provenance: {
      transcriptId,
      spanStart: 0,
      spanEnd: surfaceText.length,
      quote: surfaceText,
      timestamp: null,
      speakerLabel: null,
      meetingDate: null,
    },
    minedAt: "2026-08-31T12:00:00.000Z",
    algorithmVersion: 1,
  };
}

function makeDecision(
  mentionId: string,
  outcome: IdentityDecision["outcome"],
  profileId: string | null,
): IdentityDecision {
  return {
    id: `decision_${mentionId}_${outcome}`,
    mentionId,
    transcriptId: "drive_fileA_r1",
    action: outcome === "linked" ? "confirm" : "unresolved",
    outcome,
    profileId,
    profileRevision: profileId ? 1 : null,
    decidedBy: "owner",
    decidedAt: "2026-08-31T12:00:00.000Z",
    note: null,
    mappingAuthority: null,
  };
}

interface Harness {
  workspaceDir: string;
  runs: Runs;
  host: MeetingDebriefHost;
  catalog: Map<string, TranscriptRecord>;
  identity: Map<string, DebriefIdentityReview>;
  extractInputs: DebriefExtractInput[];
  app: FastifyInstance;
}

function fakeExtraction(input: DebriefExtractInput): Promise<MeetingDebriefExtraction> {
  const resolved = input.identity.mentions.find((mention) =>
    input.identity.decisions.some((d) => d.mentionId === mention.id && d.outcome === "linked"),
  );
  const extraction: MeetingDebriefExtraction = {
    version: 1,
    summary: `Review of ${input.record.source.fileName}`,
    decisions: [
      { statement: "Ship the billing fix on Friday", evidence: "We decided to ship on Friday" },
    ],
    actionItems: [
      {
        title: "Follow up on the billing fix",
        owner: "Alice",
        ownerMentionId: resolved?.id ?? null,
        ownerProfileId: null,
        dueDate: "2026-08-22",
      },
    ],
    openQuestions: [{ question: "Is the rollout on track?", raisedBy: "Alice" }],
    effectivenessEvidence: "Decisions were made crisply.",
    coachingAdvice: "Close open questions before the next sync.",
    suggestedRecipients: [],
  };
  return Promise.resolve(extraction);
}

type ExtractFn = (input: DebriefExtractInput) => Promise<MeetingDebriefExtraction>;

function makeHarness(extraction: ExtractFn = fakeExtraction): Harness {
  const workspaceDir = mkdtempSync(join(tmpdir(), "meeting-debrief-"));
  const runs = openRuns(workspaceDir);
  const catalog = new Map<string, TranscriptRecord>();
  const identity = new Map<string, DebriefIdentityReview>();
  const extractInputs: DebriefExtractInput[] = [];
  const catalogReader: DebriefCatalogReader = {
    getTranscript: (id) => catalog.get(id) ?? null,
  };
  const identityReader: DebriefIdentityReviewReader = {
    reviewFor: (id) => identity.get(id) ?? { mentions: [], decisions: [], organizations: [] },
  };
  const host = new MeetingDebriefHost({
    runs,
    catalog: catalogReader,
    identity: identityReader,
    extract: (input) => {
      extractInputs.push(input);
      return extraction(input);
    },
    log: () => {},
  });
  const app = fastify({ logger: false });
  host.routes(app);
  return { workspaceDir, runs, host, catalog, identity, extractInputs, app };
}

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});

describe("Meeting Debrief Run creation (#139)", () => {
  it("starts exactly one Debrief Run per mined Transcript revision, however often mining reports it", async () => {
    const record = makeRecord();
    await h.host.process(record);
    await h.host.process(record);
    await h.host.backfill([record]);

    await h.host.idle();

    const page = h.runs.list({ module: MEETING_DEBRIEF_MODULE_ID });
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0]?.module).toBe(MEETING_DEBRIEF_MODULE_ID);
  });

  it("starts a separate Run for a new source revision of the same file", async () => {
    const record = makeRecord();
    const revision2 = makeRecord({ id: "drive_fileA_r2" });
    await h.host.process(record);
    await h.host.process(revision2);
    await h.host.idle();

    const page = h.runs.list({ module: MEETING_DEBRIEF_MODULE_ID });
    expect(page.runs).toHaveLength(2);
  });

  it("finishes as soon as it has extracted — nothing waits for the owner", async () => {
    const record = makeRecord();
    h.catalog.set(record.id, record);
    await h.host.process(record);
    await h.host.idle();

    const run = h.runs.detail(h.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs[0].id);
    /* A Debrief used to stop here against a thirty-day owner wait, which left
       a workspace of transcripts `blocked` behind a person. The one thing that
       still waits for the owner is the outward writes. */
    expect(run?.status).toBe("done");
    expect(run?.wait).toBeNull();
    expect(run?.summary).toContain("action item");
  });

  it("skips with a visible reason when the Catalog no longer holds the Transcript", async () => {
    const record = makeRecord({ id: "drive_gone_r1" });
    await h.host.process(record);
    await h.host.idle();

    const run = h.runs.detail(h.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs[0].id);
    expect(run?.status).toBe("skipped");
    expect(run?.skipReason).toBe("transcript_not_in_catalog");
  });
});

describe("Meeting Debrief consumes the immutable Catalog artifact (#139)", () => {
  it("extracts from the stored record — never a fresh Drive fetch or its own conversion", async () => {
    const record = makeRecord({
      normalizedText: "Alice: The immutable artifact text.\n",
    });
    h.catalog.set(record.id, record);
    await h.host.process(record);
    await h.host.idle();

    expect(h.extractInputs).toHaveLength(1);
    expect(h.extractInputs[0]?.record.normalizedText).toBe("Alice: The immutable artifact text.\n");
    expect(h.extractInputs[0]?.record.source.checksum).toBe("deadbeef");
  });

  it("consumes identity review state from the Catalog instead of guessing", async () => {
    const record = makeRecord();
    h.catalog.set(record.id, record);
    h.identity.set(record.id, {
      mentions: [makeMention("m1", "Alice"), makeMention("m2", "Bob")],
      decisions: [makeDecision("m1", "linked", "profile_alice")],
      organizations: [],
    });
    await h.host.process(record);
    await h.host.idle();

    expect(h.extractInputs[0]?.identity.mentions.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(h.extractInputs[0]?.identity.decisions).toHaveLength(1);
  });
});

describe("Meeting Debrief extraction and review state (#139)", () => {
  it("resolves action-item owners only through the Catalog's review state", async () => {
    const record = makeRecord();
    h.catalog.set(record.id, record);
    h.identity.set(record.id, {
      mentions: [makeMention("m1", "Alice"), makeMention("m2", "Bob")],
      decisions: [
        makeDecision("m1", "linked", "profile_alice"),
        makeDecision("m2", "unresolved", null),
      ],
      organizations: [],
    });
    h.host = new MeetingDebriefHost({
      runs: h.runs,
      catalog: { getTranscript: (id) => (id === record.id ? record : null) },
      identity: {
        reviewFor: (id) => h.identity.get(id) ?? { mentions: [], decisions: [], organizations: [] },
      },
      extract: async () => ({
        version: 1 as const,
        summary: "Review",
        decisions: [],
        actionItems: [
          {
            title: "Linked owner",
            owner: "Alice",
            ownerMentionId: "m1",
            ownerProfileId: null,
            dueDate: null,
          },
          {
            title: "Unresolved owner",
            owner: "Bob",
            ownerMentionId: "m2",
            ownerProfileId: null,
            dueDate: null,
          },
          {
            title: "Ghost owner",
            owner: "Ghost",
            ownerMentionId: "ghost",
            ownerProfileId: "profile_supplied_unknown",
            dueDate: null,
          },
          {
            title: "No mention id",
            owner: "Anonymous",
            ownerMentionId: null,
            ownerProfileId: "profile_supplied_guess",
            dueDate: null,
          },
        ],
        openQuestions: [],
        effectivenessEvidence: "n/a",
        coachingAdvice: "n/a",
        suggestedRecipients: [],
      }),
      log: () => {},
    });

    await h.host.process(record);
    await h.host.idle();

    const runId = h.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs[0].id;
    const raw = h.runs.open(runId)!.readArtifact("result.json")!;
    const result = JSON.parse(raw) as MeetingDebriefRunResult;
    const items = result.debrief.actionItems;
    expect(items[0]?.ownerProfileId).toBe("profile_alice");
    expect(items[1]?.ownerProfileId).toBeNull();
    // A model-supplied profile id never survives: an unknown mention id or no
    // mention id at all resolves to null, never to the model's guess.
    expect(items[2]?.ownerProfileId).toBeNull();
    expect(items[3]?.ownerProfileId).toBeNull();
  });

  it("prefills occurrence and roster for Calendar-linked records", async () => {
    const record = makeRecord({
      occurrence: { occurrenceKey: "evt1::2026-08-17T13:00:00Z", calendarEventId: "evt1" },
      roster: [
        { displayName: "Alice", email: "alice@example.com" },
        { displayName: "Bob", email: "bob@example.com" },
      ],
    });
    h.catalog.set(record.id, record);
    await h.host.process(record);
    await h.host.idle();

    const index = await (
      await h.app.inject({ method: "GET", url: "/api/meeting-debrief/index" })
    ).json();
    expect(index.entries).toHaveLength(1);
    const entry = index.entries[0];
    expect(entry.linked).toBe(true);
    expect(entry.occurrenceKey).toBe("evt1::2026-08-17T13:00:00Z");
    expect(entry.rosterStatus).toBe("prefilled");
    expect(entry.rosterSize).toBe(2);
    expect(entry.reviewReadiness).toBe("ready");
  });

  it("visibly requires manual roster confirmation for unlinked records", async () => {
    const record = makeRecord();
    h.catalog.set(record.id, record);
    await h.host.process(record);
    await h.host.idle();

    const index = await (
      await h.app.inject({ method: "GET", url: "/api/meeting-debrief/index" })
    ).json();
    const entry = index.entries[0];
    expect(entry.linked).toBe(false);
    expect(entry.occurrenceKey).toBeNull();
    expect(entry.rosterStatus).toBe("requires_confirmation");
    expect(entry.reviewReadiness).toBe("needs_roster");
  });

  it("serves the detail journey: extraction, roster, identity, and review readiness", async () => {
    const record = makeRecord();
    h.catalog.set(record.id, record);
    h.identity.set(record.id, {
      mentions: [makeMention("m1", "Alice"), makeMention("m2", "Bob"), makeMention("m3", "Ghost")],
      decisions: [
        makeDecision("m1", "linked", "profile_alice"),
        makeDecision("m3", "not-a-person", null),
      ],
      organizations: [],
    });
    await h.host.process(record);
    await h.host.idle();

    const runId = h.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs[0].id;
    const detail = await (
      await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` })
    ).json();
    expect(detail.transcriptId).toBe(record.id);
    expect(detail.meetingDate).toBe("2026-08-17");
    expect(detail.extraction.summary).toContain("Weekly sync");
    expect(detail.extraction.decisions).toHaveLength(1);
    expect(detail.extraction.actionItems).toHaveLength(1);
    expect(detail.extraction.openQuestions).toHaveLength(1);
    expect(detail.extraction.effectivenessEvidence).toBeTruthy();
    expect(detail.extraction.coachingAdvice).toBeTruthy();
    expect(detail.identity.resolved).toEqual([
      { mentionId: "m1", surfaceText: "Alice", profileId: "profile_alice" },
    ]);
    expect(detail.identity.unresolved).toEqual([{ mentionId: "m2", surfaceText: "Bob" }]);
    expect(detail.identity.organizations).toEqual([]);
    expect(detail.reviewReadiness).toBe("needs_roster");

    const missing = await h.app.inject({ method: "GET", url: "/api/meeting-debrief/run_nope" });
    expect(missing.statusCode).toBe(404);
  });

  it("reflects the LATEST Catalog decision per mention, not the first or an out-of-order earlier one", async () => {
    const record = makeRecord();
    h.catalog.set(record.id, record);
    h.identity.set(record.id, {
      mentions: [makeMention("m1", "Alice")],
      decisions: [
        { ...makeDecision("m1", "linked", "profile_first"), decidedAt: "2026-08-31T10:00:00.000Z" },
        { ...makeDecision("m1", "unresolved", null), decidedAt: "2026-08-31T12:00:00.000Z" },
        {
          ...makeDecision("m1", "linked", "profile_out_of_order"),
          decidedAt: "2026-08-31T11:00:00.000Z",
        },
      ],
      organizations: [],
    });
    await h.host.process(record);
    await h.host.idle();

    const runId = h.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs[0].id;
    const detail = await (
      await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` })
    ).json();
    expect(detail.identity.resolved).toEqual([]);
    expect(detail.identity.unresolved).toEqual([{ mentionId: "m1", surfaceText: "Alice" }]);
  });
});

describe("Meeting Debrief fixed Stages (#139)", () => {
  it("pins the Stage names the Module owns", () => {
    expect([...MEETING_DEBRIEF_STAGES]).toEqual(["associate", "extract", "review", "regenerate"]);
  });
});

describe("Meeting Debrief writes nothing outward (#139)", () => {
  it("leaves no draft, Task, or outward-write event on any Debrief Run", async () => {
    const record = makeRecord();
    h.catalog.set(record.id, record);
    await h.host.process(record);
    await h.host.idle();

    for (const summary of h.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs) {
      const detail = h.runs.detail(summary.id);
      const outward = detail?.events.filter((event) => /draft|task|gmail|send/i.test(event.type));
      expect(outward).toEqual([]);
      const raw = h.runs.open(summary.id)!.readArtifact("result.json");
      if (raw) {
        const result = JSON.parse(raw) as Record<string, unknown>;
        expect(Object.keys(result).sort()).toEqual([
          "debrief",
          "extractedAt",
          "transcriptId",
          "version",
        ]);
      }
      expect(detail?.files).toEqual(["result.json", "review.json"]);
    }
  });
});

describe("Meeting Debrief retry and recovery (#139)", () => {
  it("retries a failed extraction in place from the extract Stage", async () => {
    const record = makeRecord();
    h.catalog.set(record.id, record);
    let attempts = 0;
    let failing = true;
    const failingHost = new MeetingDebriefHost({
      runs: h.runs,
      catalog: { getTranscript: (id) => (id === record.id ? record : null) },
      identity: { reviewFor: () => ({ mentions: [], decisions: [], organizations: [] }) },
      extract: async () => {
        attempts += 1;
        if (failing) throw new Error("model unavailable");
        return fakeExtraction({
          record,
          identity: { mentions: [], decisions: [], organizations: [] },
        });
      },
      log: () => {},
    });

    await failingHost.process(record);
    await failingHost.idle();
    const runId = h.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs[0].id;
    expect(h.runs.detail(runId)?.status).toBe("failed");
    expect(h.runs.detail(runId)?.failedStage).toBe("extract");
    const attemptsAfterFailure = attempts;

    failing = false;
    await failingHost.retryRun(runId);
    await failingHost.idle();

    expect(h.runs.detail(runId)?.status).toBe("done");
    expect(attempts).toBe(attemptsAfterFailure + 1);
  });

  it("recovers an orphaned Run on boot in place from the Run's own identity", async () => {
    const record = makeRecord();
    h.catalog.set(record.id, record);
    const orphan = h.runs.create({
      module: MEETING_DEBRIEF_MODULE_ID,
      moduleVersion: 1,
      intake: "transcript-catalog",
      fileName: record.source.fileName,
      sourceUrl: null,
      externalId: record.id,
    });

    h.host.start();
    await vi.waitFor(() => expect(h.runs.detail(orphan.id)?.status).toBe("done"));

    const page = h.runs.list({ module: MEETING_DEBRIEF_MODULE_ID });
    expect(page.runs).toHaveLength(1);
    h.host.stop();
  });

  it("treats an orphaned Run as the Run a re-mine would have made — no duplicate", async () => {
    const record = makeRecord();
    h.catalog.set(record.id, record);
    const orphan = h.runs.create({
      module: MEETING_DEBRIEF_MODULE_ID,
      moduleVersion: 1,
      intake: "transcript-catalog",
      fileName: record.source.fileName,
      sourceUrl: null,
      externalId: record.id,
    });

    await h.host.process(record);
    await h.host.idle();

    const page = h.runs.list({ module: MEETING_DEBRIEF_MODULE_ID });
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0]?.id).toBe(orphan.id);
  });
});
