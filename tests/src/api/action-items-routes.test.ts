import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ActionItem,
  ActionItemIndex,
  IdentityDecision,
  MeetingDebriefActionItem,
  MeetingDebriefExtraction,
  TranscriptMention,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import { registerTasksApi } from "../../../apps/server/src/api/tasks";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";
import { MeetingDebriefHost } from "../../../apps/server/src/modules/meeting-debrief/host";
import { openRuns, type Runs } from "../../../apps/server/src/runs";

/**
 * Action Items materialized from a Meeting Debrief (issue #177): the Debrief
 * produces them, the Workspace owns them, and the Tasks product reads them
 * without treating one as a Task. The Debrief Host is the real one — its
 * extraction is the only thing standing in — so the hand-off proven here is
 * the hand-off production performs.
 */
let app: FastifyInstance;
let workspaceDir: string;
let runs: Runs;
let host: MeetingDebriefHost;
let ownerProfileId: string | null;
let actionItems: WorkspaceActionItems;
/** What the stand-in extraction proposes; set per test. */
let proposed: MeetingDebriefActionItem[];
/** The Catalog review state the Debrief resolves owners against; set per test. */
let identityReview: { mentions: TranscriptMention[]; decisions: IdentityDecision[] };

function record(overrides: Partial<TranscriptRecord> = {}): TranscriptRecord {
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
    normalizedText: "Alice: We decided to ship on Friday.\n",
    meetingDate: "2026-08-17",
    occurrence: null,
    speakers: ["Alice"],
    speakerIdentityMappings: [],
    roster: [],
    meetingId: "meeting_1",
    ...overrides,
  };
}

/** One mined mention, as the Catalog holds it. */
function mention(id: string, surfaceText: string): TranscriptMention {
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
      transcriptId: "drive_fileA_r1",
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

/** The owner's review decision linking one mention to a Person Profile. */
function linked(mentionId: string, profileId: string): IdentityDecision {
  return {
    id: `decision_${mentionId}`,
    mentionId,
    transcriptId: "drive_fileA_r1",
    action: "confirm",
    outcome: "linked",
    profileId,
    profileRevision: 1,
    decidedBy: "owner",
    decidedAt: "2026-08-31T12:00:00.000Z",
    note: null,
    mappingAuthority: null,
  };
}

function proposal(overrides: Partial<MeetingDebriefActionItem> = {}): MeetingDebriefActionItem {
  return {
    title: "Follow up on the billing fix",
    owner: "Alice",
    ownerMentionId: "m_alice",
    ownerProfileId: null,
    dueDate: "2026-08-22",
    ...overrides,
  };
}

function extraction(): MeetingDebriefExtraction {
  return {
    version: 1,
    summary: "Review of the weekly sync",
    decisions: [],
    actionItems: proposed,
    openQuestions: [],
    effectivenessEvidence: "",
    coachingAdvice: "",
    suggestedRecipients: [],
  };
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-action-items-"));
  runs = openRuns(workspaceDir);
  ownerProfileId = null;
  proposed = [proposal()];
  identityReview = { mentions: [], decisions: [] };
  const store = new TaskStore(workspaceDir);
  actionItems = new WorkspaceActionItems({
    store,
    now: () => new Date("2026-09-04T09:00:00.000Z"),
    ownerProfileId: () => ownerProfileId,
  });
  host = new MeetingDebriefHost({
    runs,
    catalog: { getTranscript: (id) => (id === "drive_fileA_r1" ? record() : null) },
    identity: {
      reviewFor: () => ({ ...identityReview, organizations: [] }),
    },
    extract: () => Promise.resolve(extraction()),
    materializeActionItems: (handover) => actionItems.materialize(handover),
    log: () => {},
  });
  app = fastify();
  /* The Debrief's own routes too: regeneration is reached the way the review
     surface reaches it, not by calling into the Module. */
  host.routes(app);
  registerTasksApi(app, {
    tasks: new WorkspaceTasks({ store, now: () => new Date("2026-09-04T09:00:00.000Z") }),
    actionItems,
  });
  return app.ready();
});

afterEach(async () => {
  await app.close();
});

/** Run one Debrief to completion and answer with the Run's id. */
async function debrief(): Promise<string> {
  await host.process(record());
  await host.idle();
  const runIds = runs.list({ module: "meeting-debrief" }).runs.map((entry) => entry.id);
  expect(runIds).toHaveLength(1);
  return runIds[0];
}

async function queue(query = ""): Promise<ActionItem[]> {
  const response = await app.inject({ method: "GET", url: `/api/action-items${query}` });
  expect(response.statusCode).toBe(200);
  return response.json<ActionItemIndex>().items;
}

describe("materializing Action Items from a Debrief", () => {
  it("records one Action Item per proposed commitment, retaining its whole source", async () => {
    proposed = [proposal(), proposal({ title: "Send Bob the rollout plan", owner: "Bob" })];

    const runId = await debrief();

    const items = await queue();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      source: {
        debriefRunId: runId,
        transcriptId: "drive_fileA_r1",
        meetingId: "meeting_1",
      },
      extractionRevision: 1,
      evidence: { responsibleMentionId: "m_alice", responsibleSurfaceName: "Alice" },
      proposal: {
        title: "Follow up on the billing fix",
        notes: "",
        dueDate: "2026-08-22",
        responsiblePerson: null,
      },
      state: "pending",
      promotedTaskId: null,
      decidedAt: null,
      createdAt: "2026-09-04T09:00:00.000Z",
    });
  });

  it("proposes the owner when the Catalog resolved the commitment to the owner's Profile", async () => {
    ownerProfileId = "profile_owner";
    identityReview = {
      mentions: [mention("m_alice", "Alice"), mention("m_bob", "Bob")],
      decisions: [linked("m_alice", "profile_owner"), linked("m_bob", "profile_bob")],
    };
    proposed = [
      proposal(),
      proposal({ title: "Bob's item", owner: "Bob", ownerMentionId: "m_bob" }),
      proposal({ title: "Nobody's item", owner: null, ownerMentionId: null }),
    ];

    await debrief();

    const byTitle = new Map((await queue()).map((item) => [item.proposal.title, item]));
    expect(byTitle.get("Follow up on the billing fix")?.proposal.responsiblePerson).toEqual({
      kind: "owner",
    });
    expect(byTitle.get("Bob's item")?.proposal.responsiblePerson).toEqual({
      kind: "person-profile",
      profileId: "profile_bob",
    });
    expect(byTitle.get("Nobody's item")?.proposal.responsiblePerson).toBeNull();
  });

  it("stages a regenerated proposal beside the decisions already made", async () => {
    const runId = await debrief();
    const first = await queue();
    expect(first).toHaveLength(1);

    proposed = [proposal(), proposal({ title: "Book the follow-up session" })];
    const regenerated = await app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "actionItems" },
    });
    expect(regenerated.statusCode).toBe(200);
    await host.idle();

    const after = await queue();
    expect(after).toHaveLength(2);
    /* The proposal that came back unchanged is the same record it was — a
       regeneration reconciles, it does not replace. */
    expect(after[0]).toEqual(first[0]);
    expect(after[1]).toMatchObject({
      proposal: { title: "Book the follow-up session" },
      extractionRevision: 2,
      state: "pending",
    });
  });
  it("preserves a dismissed decision across regeneration and stages the newcomer", async () => {
    const runId = await debrief();
    const [first] = await queue();
    const dismissed = await app.inject({
      method: "POST",
      url: `/api/action-items/${first.id}/dismiss`,
    });
    expect(dismissed.statusCode).toBe(200);
    proposed = [proposal(), proposal({ title: "Book the follow-up session" })];
    const regenerated = await app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "actionItems" },
    });
    expect(regenerated.statusCode).toBe(200);
    await host.idle();
    const after = await queue();
    expect(after).toHaveLength(2);
    expect(after.find((item) => item.id === first.id)).toMatchObject({
      state: "dismissed",
      extractionRevision: 1,
    });
    expect(
      after.find((item) => item.proposal.title === "Book the follow-up session"),
    ).toMatchObject({
      state: "pending",
      extractionRevision: 2,
    });
    const tasks = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(tasks.json<{ tasks: unknown[] }>().tasks).toEqual([]);
  });

  it("preserves a promoted decision across regeneration without touching its Task", async () => {
    const runId = await debrief();
    const [first] = await queue();
    const promoted = await app.inject({
      method: "POST",
      url: `/api/action-items/${first.id}/promote`,
      payload: { title: "Accepted billing follow-up", notes: "Owner edited notes" },
    });
    expect(promoted.statusCode).toBe(201);
    const taskId = promoted.json<{ task: { id: string } }>().task.id;
    proposed = [proposal(), proposal({ title: "Book the follow-up session" })];
    const regenerated = await app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "actionItems" },
    });
    expect(regenerated.statusCode).toBe(200);
    await host.idle();
    const after = await queue();
    expect(after.find((item) => item.id === first.id)).toMatchObject({
      state: "promoted",
      promotedTaskId: taskId,
    });
    expect(
      after.find((item) => item.proposal.title === "Book the follow-up session"),
    ).toMatchObject({
      state: "pending",
    });
    const task = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
    expect(task.json<{ title: string; notes: string }>()).toMatchObject({
      title: "Accepted billing follow-up",
      notes: "Owner edited notes",
    });
    const allTasks = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(allTasks.json<{ tasks: unknown[] }>().tasks).toHaveLength(1);
  });

  it("keeps the records and their identities across a restart of the application", async () => {
    const runId = await debrief();
    const before = await queue();

    await app.close();
    const store = new TaskStore(workspaceDir);
    app = fastify();
    registerTasksApi(app, {
      tasks: new WorkspaceTasks({ store }),
      actionItems: new WorkspaceActionItems({ store }),
    });
    await app.ready();

    expect(await queue()).toEqual(before);
    expect(before[0]?.source.debriefRunId).toBe(runId);
  });
});

/**
 * Re-extraction properties at the materialization seam itself. A Debrief Run
 * is created once per Transcript, so the Host cannot re-extract one — but
 * regeneration will, and these are the guarantees it depends on.
 */
describe("re-extracting one Debrief", () => {
  function materialize(actionItems_: MeetingDebriefActionItem[]): ActionItem[] {
    return actionItems.materialize({
      debriefRunId: "run_1",
      transcriptId: "drive_fileA_r1",
      meetingId: "meeting_1",
      actionItems: actionItems_,
    });
  }

  it("gives an Action Item an identity that does not move when the proposals do", () => {
    const bob = proposal({ title: "Send Bob the rollout plan", owner: "Bob" });
    const first = materialize([proposal(), bob]).map((item) => item.id);

    const reordered = materialize([bob, proposal()]).map((item) => item.id);

    expect(reordered).toEqual([...first].reverse());
  });

  it("adds nothing and changes no record when the same commitments come back", () => {
    const before = materialize([proposal()]);

    expect(materialize([proposal()])).toEqual(before);
    expect(actionItems.list()).toEqual(before);
  });

  it("counts a genuinely new proposal as the next extraction revision", () => {
    materialize([proposal()]);

    materialize([proposal(), proposal({ title: "Book the follow-up session" })]);

    expect(
      actionItems
        .list()
        .map((item) => item.extractionRevision)
        .sort(),
    ).toEqual([1, 2]);
  });
});

describe("reading the Action Item queue", () => {
  it("lists by state and by source", async () => {
    const runId = await debrief();

    expect(await queue("?state=pending")).toHaveLength(1);
    expect(await queue("?state=promoted")).toEqual([]);
    expect(await queue("?state=dismissed")).toEqual([]);
    expect(await queue(`?debriefRunId=${runId}`)).toHaveLength(1);
    expect(await queue("?transcriptId=drive_fileA_r1")).toHaveLength(1);
    expect(await queue("?meetingId=meeting_1")).toHaveLength(1);
    expect(await queue("?meetingId=meeting_other")).toEqual([]);
  });

  it("does not present an Action Item as a Task", async () => {
    await debrief();

    const tasks = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(tasks.json<{ tasks: unknown[] }>().tasks).toEqual([]);
  });
});
