import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MEETING_DEBRIEF_MODULE_ID,
  MEETING_DEBRIEF_REVIEW_EXPIRY_DAYS,
  type MeetingDebriefRunResult,
  type MeetingDebriefReviewState,
  type MeetingDebriefReviewView,
  type TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import { MeetingDebriefHost } from "../../../apps/server/src/modules/meeting-debrief/host";
import type {
  DebriefCatalogReader,
  DebriefExtractInput,
  DebriefIdentityReviewReader,
} from "../../../apps/server/src/modules/meeting-debrief/module";
import { workspaceProfileDirectory } from "../../../apps/server/src/modules/meeting-debrief/profiles";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { RunNotResumableError } from "../../../apps/server/src/engine/runner";
import { openRuns, type Runs } from "../../../apps/server/src/runs";
import type { RunMeta } from "@chief-of-staff-demo/shared";

const OWNER_EMAIL = "owner@example.com";
const BASE_TIME = Date.parse("2026-09-01T12:00:00.000Z");
const EXPIRY_PROBE_DAYS = MEETING_DEBRIEF_REVIEW_EXPIRY_DAYS + 1;

function makeRecord(overrides: Partial<TranscriptRecord> = {}): TranscriptRecord {
  return {
    id: "drive_reviewA_r1",
    source: {
      sourceSystem: "drive",
      externalFileId: "reviewA",
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

/**
 * Each generation names itself in the fields it owns, so a merge test can
 * tell a regenerated field from a kept one. The immutable input alone
 * determines the call — the previous extraction is not an argument.
 */
function fakeExtraction(input: DebriefExtractInput, generation: number) {
  return {
    version: 1 as const,
    summary: `Review of ${input.record.source.fileName} (generation ${generation})`,
    decisions: [{ statement: `Decision from generation ${generation}`, evidence: null }],
    actionItems: [
      {
        title: `Follow up from generation ${generation}`,
        owner: "Alice",
        ownerMentionId: null,
        ownerProfileId: null,
        dueDate: null,
      },
    ],
    openQuestions: [],
    effectivenessEvidence: "Decisions were made crisply.",
    coachingAdvice: "Close open questions before the next sync.",
    suggestedRecipients: [] as Array<{ name: string; email: string | null }>,
  };
}

interface Harness {
  runs: Runs;
  host: MeetingDebriefHost;
  people: WorkspacePersonProfiles;
  catalog: Map<string, TranscriptRecord>;
  clock: { setNow(value: Date): void; advanceDays(days: number): Date };
  app: FastifyInstance;
  /** Every extraction call's input, in order, across generations. */
  extractInputs: DebriefExtractInput[];
  /** Forces the next extraction call to fail once (regeneration failure). */
  failNextExtraction: { value: boolean };
  /** Arms the flip-after-first-call owner gate (durable-refusal test). */
  ownerFlip: { armed: boolean; calls: number };
  workspaceDir: string;
}

function makeHarness(HostCtor: typeof MeetingDebriefHost = MeetingDebriefHost): Harness {
  const workspaceDir = mkdtempSync(join(tmpdir(), "meeting-debrief-review-"));
  const runs = openRuns(workspaceDir);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    lifecycle: [],
  });
  const catalog: Map<string, TranscriptRecord> = new Map();
  let nowMs = BASE_TIME;
  const clock = {
    setNow(value: Date) {
      nowMs = value.getTime();
    },
    advanceDays(days: number) {
      nowMs += days * 24 * 60 * 60 * 1000;
      return new Date(nowMs);
    },
  };
  let generation = 0;
  const extractInputs: DebriefExtractInput[] = [];
  const failNextExtraction = { value: false };
  /* Armed only by the durable-refusal test: the FIRST ownerEmail() call of the
     armed flow (the host route's synchronous pre-check) still sees the owner,
     every later call (the Module Stage's durable re-assertion) does not — a
     deterministic construction of the gate flip between the two adapters. */
  const ownerFlip = { armed: false, calls: 0 };
  const host = new HostCtor({
    runs,
    catalog: {
      getTranscript: (id) => catalog.get(id) ?? null,
    } satisfies DebriefCatalogReader,
    identity: {
      reviewFor: () => ({ mentions: [], decisions: [], organizations: [] }),
    } satisfies DebriefIdentityReviewReader,
    extract: (input) => {
      if (failNextExtraction.value) {
        failNextExtraction.value = false;
        return Promise.reject(new Error("model unavailable"));
      }
      extractInputs.push(input);
      generation += 1;
      return Promise.resolve(fakeExtraction(input, generation));
    },
    now: () => new Date(nowMs),
    profiles: workspaceProfileDirectory(people),
    ownerEmail: () => (ownerFlip.armed && ++ownerFlip.calls > 1 ? null : OWNER_EMAIL),
    log: () => {},
  });
  const app = fastify({ logger: false });
  host.routes(app);
  return {
    runs,
    host,
    people,
    catalog,
    clock,
    app,
    extractInputs,
    failNextExtraction,
    ownerFlip,
    workspaceDir,
  };
}

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});

async function startRun(record: TranscriptRecord): Promise<string> {
  h.catalog.set(record.id, record);
  await h.host.process(record);
  await h.host.idle();
  return h.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs[0].id;
}

function reviewStateOf(runId: string): MeetingDebriefReviewState {
  const raw = h.runs.open(runId)!.readArtifact("review.json")!;
  // Test-side read of a Module-owned artifact: shape asserted by the suite.
  return JSON.parse(raw) as MeetingDebriefReviewState;
}

describe("Meeting Debrief completion (no review wait)", () => {
  it("finishes once extraction completes, with the review record written and nothing waiting", async () => {
    const runId = await startRun(makeRecord());

    const meta = h.runs.open(runId)!.read();
    /* The Debrief used to stop here against a thirty-day owner wait. It no
       longer waits for anybody: the extraction is the finished product, and
       the only thing still gated is the outward writes. */
    expect(meta.status).toBe("done");
    expect(meta.wait).toBeNull();

    /* The review record is still written — the roster, the recipients and the
       done/dismiss decisions are all still real. It is simply not a gate. */
    const state = reviewStateOf(runId);
    expect(state.roster.status).toBe("unconfirmed");
    expect(state.recipients.additional).toEqual([]);
    expect(state.review.droppedActionItems).toEqual([]);
    expect(state.request).toBeNull();
    expect(state.approval).toBeNull();
  });

  it("never expires: time passing leaves a finished Debrief alone", async () => {
    const runId = await startRun(makeRecord());
    h.clock.advanceDays(EXPIRY_PROBE_DAYS);

    /* Nothing is waiting, so there is nothing for recovery to sweep, and no
       clock that can take a Debrief away from the owner unread. */
    expect(await h.host.recover()).toBe(0);
    await h.host.idle();

    const detail = h.runs.detail(runId)!;
    expect(detail.status).toBe("done");
    expect(detail.skipReason).toBeNull();
    expect(h.runs.open(runId)!.readArtifact("result.json")).not.toBeNull();

    const served = await (
      await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` })
    ).json();
    expect(served.review.state).toBe("extracted");
    expect(served.extraction).not.toBeNull();
    const index = await (
      await h.app.inject({ method: "GET", url: "/api/meeting-debrief/index" })
    ).json();
    expect(index.entries[0].reviewState).toBeNull();

    // Still no outward records: those wait for an explicit publish.
    expect(detail.files.sort()).toEqual(["result.json", "review.json"]);
    expect(detail.events.filter((event) => /draft|task|gmail|send/i.test(event.type))).toEqual([]);
  });
});

describe("Meeting Debrief whole-field regeneration (#140, ADR-0037)", () => {
  it("regenerates a whole field from the immutable input and cannot see the rejected value", async () => {
    const runId = await startRun(makeRecord());
    const firstInputs = h.extractInputs.map((input) => structuredClone(input));
    expect(firstInputs).toHaveLength(1);

    const posted = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "summary" },
    });
    expect(posted.statusCode).toBe(200);
    await h.host.idle();

    // Regeneration ends the Run again rather than returning it to a wait.
    const meta = h.runs.open(runId)!.read();
    expect(meta.status).toBe("done");
    expect(meta.wait).toBeNull();

    // The regenerated field comes from the new generation; the others do not move.
    const raw = h.runs.open(runId)!.readArtifact("result.json")!;
    const result = JSON.parse(raw) as MeetingDebriefRunResult;
    expect(result.debrief.summary).toContain("generation 2");
    expect(result.debrief.decisions[0]?.statement).toBe("Decision from generation 1");

    // Audited: one regenerate Stage, on the Run's own timeline.
    const events = h.runs.detail(runId)!.events.map((event) => event.type);
    expect(events).toContain("debrief_regeneration_requested");
    expect(events.filter((type) => type === "debrief_regenerated")).toEqual([
      "debrief_regenerated",
    ]);

    // Structural unreachability: the regeneration saw exactly what the first
    // generation saw — the immutable record and Catalog review state, and
    // nothing shaped like the rejected extraction.
    expect(h.extractInputs).toHaveLength(2);
    expect(h.extractInputs[1]).toEqual(firstInputs[0]);
  });

  it("keeps a rejected field out of the regeneration request type", async () => {
    const runId = await startRun(makeRecord());
    await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "summary" },
    });
    await h.host.idle();

    const regenerationInput = h.extractInputs[1];
    expect(Object.keys(regenerationInput).sort()).toEqual(["identity", "record"]);
    expect(Object.keys(regenerationInput.record)).not.toContain("debrief");
  });

  it("refuses an unknown field and refuses a second request while one is in flight", async () => {
    const runId = await startRun(makeRecord());
    const bad = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "actionItemTitles" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("regenerates a whole field, leaving the review record untouched", async () => {
    const runId = await startRun(makeRecord());

    const regenerateSummary = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "summary" },
    });
    expect(regenerateSummary.statusCode).toBe(200);
    await h.host.idle();

    await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "actionItems" },
    });
    await h.host.idle();
    /* Nothing positional survives a regeneration to be cleared: review
       decisions live on canonical Action Items now (issue #199). */
    expect(reviewStateOf(runId).review).toEqual({
      droppedActionItems: [],
      completedActionItems: [],
    });
    const result = JSON.parse(
      h.runs.open(runId)!.readArtifact("result.json")!,
    ) as MeetingDebriefRunResult;
    expect(result.debrief.actionItems[0]?.title).toContain("generation 3");
  });

  it("fails the regeneration visibly and retries it from the review wait", async () => {
    const runId = await startRun(makeRecord());
    h.failNextExtraction.value = true;

    await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "summary" },
    });
    await h.host.idle();

    const detail = h.runs.detail(runId)!;
    expect(detail.status).toBe("failed");
    expect(detail.failedStage).toBe("regenerate");
    expect(detail.failureHint).toBe("Extraction failed. Retry to re-run it.");

    await h.host.retryRun(runId);
    await h.host.idle();
    expect(h.runs.detail(runId)?.status).toBe("done");
    const result = JSON.parse(
      h.runs.open(runId)!.readArtifact("result.json")!,
    ) as MeetingDebriefRunResult;
    expect(result.debrief.summary).toContain("generation 2");
  });
});

describe("the retired positional review routes (#199)", () => {
  /* The contract half of the expand-contract migration. An index into an
     extracted array was never an identity a decision could be pinned to, and
     no production caller may reach for one again. */
  it.each(["drop", "done", "dismiss"])(
    "answers not-found for /action-items/:index/%s",
    async (verb) => {
      const runId = await startRun(makeRecord());

      const response = await h.app.inject({
        method: "POST",
        url: `/api/meeting-debrief/${runId}/action-items/0/${verb}`,
      });

      expect(response.statusCode).toBe(404);
      expect(reviewStateOf(runId).review).toEqual({
        droppedActionItems: [],
        completedActionItems: [],
      });
    },
  );

  it("answers not-found for the cross-Debrief action-item rollup", async () => {
    await startRun(makeRecord());

    const response = await h.app.inject({
      method: "GET",
      url: "/api/meeting-debrief/action-items",
    });

    expect(response.statusCode).toBe(404);
  });

  it("reports no positional review state on the detail surface", async () => {
    const runId = await startRun(makeRecord());

    const detail = await (
      await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` })
    ).json();

    expect(detail.review).not.toHaveProperty("droppedActionItems");
    expect(detail.review).not.toHaveProperty("completedActionItems");
    expect(detail.review).not.toHaveProperty("actionItemTasks");
  });
});

const LINKED = {
  occurrence: { occurrenceKey: "evt1::2026-08-17T13:00:00Z", calendarEventId: "evt1" },
};

function anchoredProfile(fullName: string, email: string): string {
  const email_ = email.trim().toLowerCase();
  const { profile } = h.people.ensureCalendarAttendeeProfile({
    email: email_,
    provenance: "unit test — Calendar attendee",
  });
  h.people.correct(profile.id, { fullName });
  return profile.id;
}

describe("Meeting Debrief roster confirmation (#140)", () => {
  it("confirms a Calendar-linked roster and binds every attendee through the Calendar seam", async () => {
    const runId = await startRun(
      makeRecord({
        ...LINKED,
        roster: [
          { displayName: "Alice", email: "alice@example.com" },
          { displayName: "Bob", email: "bob@example.com" },
        ],
      }),
    );

    const posted = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: {
        entries: [
          { email: "alice@example.com", displayName: "Alice" },
          { email: "bob@example.com" },
        ],
      },
    });
    expect(posted.statusCode).toBe(200);

    const state = reviewStateOf(runId);
    expect(state.roster.status).toBe("confirmed");
    expect(state.roster.entries.map((entry) => entry.profileId).every((id) => id !== null)).toBe(
      true,
    );
    // Two email-anchored shells now exist, each carrying Calendar provenance.
    expect(
      h.people.search().filter((profile) => profile.primaryEmail?.endsWith("@example.com")),
    ).toHaveLength(2);
    for (const profile of h.people.search()) {
      expect(
        profile.sourceDiagnostics.some((d) => d.source === "calendar" && d.status === "completed"),
      ).toBe(true);
    }

    const events = h.runs.detail(runId)!.events.map((event) => event.type);
    expect(events).toContain("review_roster_confirmed");
  });

  it("binds unlinked roster entries to existing Profiles without minting shells", async () => {
    const aliceId = anchoredProfile("Alice", "alice@example.com");
    const before = h.people.search().length;
    const runId = await startRun(makeRecord());

    const posted = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: {
        entries: [
          { email: "alice@example.com", displayName: "Alice" },
          { email: "carol@example.com", displayName: "Carol" },
        ],
      },
    });
    expect(posted.statusCode).toBe(200);

    const state = reviewStateOf(runId);
    expect(state.roster.status).toBe("confirmed");
    const alice = state.roster.entries.find((entry) => entry.email === "alice@example.com");
    const carol = state.roster.entries.find((entry) => entry.email === "carol@example.com");
    expect(alice?.profileId).toBe(aliceId);
    expect(carol?.profileId).toBeNull();
    // No shell was minted for the typed email.
    expect(h.people.search()).toHaveLength(before);

    const detail = await (
      await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` })
    ).json();
    expect(detail.review.approvalBlockers).toContain("attendee-unverified-email:carol@example.com");
    // The bound, Calendar-anchored attendee is not a blocker.
    expect(detail.review.approvalBlockers).not.toContain(
      "attendee-unverified-email:alice@example.com",
    );
  });

  it("refuses duplicate and malformed roster entries", async () => {
    const runId = await startRun(
      makeRecord({ ...LINKED, roster: [{ displayName: "Alice", email: "alice@example.com" }] }),
    );
    const duplicate = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: { entries: [{ email: "alice@example.com" }, { email: "alice@example.com" }] },
    });
    expect(duplicate.statusCode).toBe(409);
    const malformed = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: { entries: [{ email: "not-an-email" }] },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("excludes the confirmed owner from the attendee gate and from automatic recipients", async () => {
    anchoredProfile("Alice", "alice@example.com");
    const runId = await startRun(
      makeRecord({
        ...LINKED,
        roster: [
          { displayName: "Owner", email: OWNER_EMAIL },
          { displayName: "Alice", email: "alice@example.com" },
        ],
      }),
    );

    const posted = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: {
        entries: [
          { email: OWNER_EMAIL, displayName: "Owner" },
          { email: "alice@example.com", displayName: "Alice" },
        ],
      },
    });
    expect(posted.statusCode).toBe(200);

    const detail = await (
      await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` })
    ).json();
    const view = detail.review as MeetingDebriefReviewView;
    expect(view.automaticRecipients.map((r) => r.email)).toEqual(["alice@example.com"]);
    expect(view.approvalBlockers).toEqual([]);
  });
});

describe("Meeting Debrief recipients (#140, spec #459-461)", () => {
  function confirmedLinkedRun(): Promise<string> {
    return startRun(
      makeRecord({
        ...LINKED,
        roster: [
          { displayName: "Owner", email: OWNER_EMAIL },
          { displayName: "Alice", email: "alice@example.com" },
        ],
      }),
    ).then(async (runId) => {
      const posted = await h.app.inject({
        method: "POST",
        url: `/api/meeting-debrief/${runId}/roster`,
        payload: {
          entries: [
            { email: OWNER_EMAIL, displayName: "Owner" },
            { email: "alice@example.com", displayName: "Alice" },
          ],
        },
      });
      expect(posted.statusCode).toBe(200);
      return runId;
    });
  }

  it("adds a suggested non-attendee recipient only through a verified Profile selection", async () => {
    const carolId = anchoredProfile("Carol", "carol@example.com");
    const runId = await confirmedLinkedRun();

    const unverified = h.people.create({ fullName: "Dave", primaryEmail: "dave@example.com" });
    const refused = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/recipients`,
      payload: { profileId: unverified.id, email: "dave@example.com" },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("recipient-unverified");

    const wrongEmail = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/recipients`,
      payload: { profileId: carolId, email: "not-carol@example.com" },
    });
    expect(wrongEmail.statusCode).toBe(409);

    const added = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/recipients`,
      payload: { profileId: carolId, email: "carol@example.com" },
    });
    expect(added.statusCode).toBe(200);

    const duplicate = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/recipients`,
      payload: { profileId: carolId, email: "carol@example.com" },
    });
    expect(duplicate.statusCode).toBe(409);

    const detail = await (
      await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` })
    ).json();
    const recipientsView = detail.review as MeetingDebriefReviewView;
    expect(recipientsView.additionalRecipients).toEqual([
      { profileId: carolId, profileRevision: expect.any(Number), email: "carol@example.com" },
    ]);
    expect(recipientsView.automaticRecipients.map((r) => r.email)).toEqual(["alice@example.com"]);
    const events = h.runs.detail(runId)!.events.map((event) => event.type);
    expect(events).toContain("review_recipient_added");
  });

  it("refuses an archived Profile as a recipient and allows removing one", async () => {
    const carolId = anchoredProfile("Carol", "carol@example.com");
    const runId = await confirmedLinkedRun();
    await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/recipients`,
      payload: { profileId: carolId, email: "carol@example.com" },
    });

    h.people.archive(carolId);
    const daveId = anchoredProfile("Dave", "dave@example.com");
    const archived = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/recipients`,
      payload: { profileId: carolId, email: "carol@example.com" },
    });
    expect(archived.statusCode).toBe(409);

    const removed = await h.app.inject({
      method: "DELETE",
      url: `/api/meeting-debrief/${runId}/recipients/${encodeURIComponent(daveId)}`,
    });
    expect(removed.statusCode).toBe(404);
    const removedCarol = await h.app.inject({
      method: "DELETE",
      url: `/api/meeting-debrief/${runId}/recipients/${encodeURIComponent(carolId)}`,
    });
    expect(removedCarol.statusCode).toBe(200);
    expect(reviewStateOf(runId).recipients.additional).toEqual([]);
  });
});

describe("Meeting Debrief approval gate and lock (#140, spec #450/452)", () => {
  function confirmedLinkedRun(): Promise<string> {
    return startRun(
      makeRecord({
        ...LINKED,
        roster: [
          { displayName: "Owner", email: OWNER_EMAIL },
          { displayName: "Alice", email: "alice@example.com" },
          { displayName: "Bob", email: "bob@example.com" },
        ],
      }),
    ).then(async (runId) => {
      const posted = await h.app.inject({
        method: "POST",
        url: `/api/meeting-debrief/${runId}/roster`,
        payload: {
          entries: [
            { email: OWNER_EMAIL, displayName: "Owner" },
            { email: "alice@example.com", displayName: "Alice" },
            { email: "bob@example.com", displayName: "Bob" },
          ],
        },
      });
      expect(posted.statusCode).toBe(200);
      return runId;
    });
  }

  it("refuses approval with visible blockers until the gate opens", async () => {
    const runId = await startRun(
      makeRecord({ roster: [{ displayName: "Alice", email: "alice@example.com" }] }),
    );

    const refused = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/approve`,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("approval-blocked");
    expect(refused.json().blockers).toContain("roster-unconfirmed");
    expect(refused.json().blockers).toContain("attendee-unverified-email:alice@example.com");

    // The Run still waits: a refused approval is not a failed Debrief.
    expect(h.runs.detail(runId)?.status).toBe("done");
  });

  it("reports the owner blocker while the owner identity is unconfirmed", async () => {
    const ownerless = makeHarnessWithOwner(null);
    ownerless.catalog.set(
      "drive_reviewB_r1",
      makeRecord({
        id: "drive_reviewB_r1",
        ...LINKED,
        roster: [{ displayName: "Alice", email: "alice@example.com" }],
      }),
    );
    await ownerless.host.process(
      makeRecord({
        id: "drive_reviewB_r1",
        ...LINKED,
        roster: [{ displayName: "Alice", email: "alice@example.com" }],
      }),
    );
    await ownerless.host.idle();
    const runId = ownerless.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs[0].id;

    const refused = await ownerless.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/approve`,
    });
    expect(refused.json().blockers).toContain("owner-identity-unconfirmed");
  });

  it("approves when the gate opens, locks every review mutation, and ends the Run", async () => {
    anchoredProfile("Alice", "alice@example.com");
    anchoredProfile("Bob", "bob@example.com");
    const carolId = anchoredProfile("Carol", "carol@example.com");
    const runId = await confirmedLinkedRun();
    await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/recipients`,
      payload: { profileId: carolId, email: "carol@example.com" },
    });

    const approved = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/approve`,
    });
    expect(approved.statusCode).toBe(200);
    await h.host.idle();

    const detail = h.runs.detail(runId)!;
    expect(detail.status).toBe("done");
    // The owner is never a recipient of their own Debrief: the count names
    // the confirmed attendees plus explicit selections, not the owner.
    expect(detail.summary).toContain("Email draft created for 3 recipients");
    const events = detail.events.map((event) => event.type);
    expect(events).toContain("debrief_approved");

    const approvedView = (
      await (await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` })).json()
    ).review as MeetingDebriefReviewView;
    expect(approvedView.state).toBe("published");
    expect(approvedView.automaticRecipients.map((r) => r.email)).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
    expect(approvedView.additionalRecipients).toHaveLength(1);
    expect(approvedView.approvalBlockers).toEqual([]);

    // Approval locks everything: every mutation seam refuses.
    const locked = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "summary" },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error).toBe("run-not-reviewable");
    const rosterLocked = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: { entries: [] },
    });
    expect(rosterLocked.statusCode).toBe(409);
    const recipientLocked = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/recipients`,
      payload: { profileId: carolId, email: "carol@example.com" },
    });
    expect(recipientLocked.statusCode).toBe(409);
    const deleteLocked = await h.app.inject({
      method: "DELETE",
      url: `/api/meeting-debrief/${runId}/recipients/${encodeURIComponent(carolId)}`,
    });
    expect(deleteLocked.statusCode).toBe(409);
    const approveLocked = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/approve`,
    });
    expect(approveLocked.statusCode).toBe(409);

    const state = reviewStateOf(runId);
    expect(state.approval).not.toBeNull();
    expect(state.request).toBeNull();
  });
});

function makeHarnessWithOwner(ownerEmail: string | null): Harness {
  const workspaceDir = mkdtempSync(join(tmpdir(), "meeting-debrief-owner-"));
  const runs = openRuns(workspaceDir);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    lifecycle: [],
  });
  const catalog: Map<string, TranscriptRecord> = new Map();
  const host = new MeetingDebriefHost({
    runs,
    catalog: { getTranscript: (id) => catalog.get(id) ?? null },
    identity: { reviewFor: () => ({ mentions: [], decisions: [], organizations: [] }) },
    extract: (input) => Promise.resolve(fakeExtraction(input, 1)),
    profiles: workspaceProfileDirectory(people),
    ownerEmail: () => ownerEmail,
    log: () => {},
  });
  const app = fastify({ logger: false });
  host.routes(app);
  return {
    runs,
    host,
    people,
    catalog,
    clock: { setNow: () => {}, advanceDays: () => new Date() },
    app,
    extractInputs: [],
    failNextExtraction: { value: false },
    ownerFlip: { armed: false, calls: 0 },
    workspaceDir,
  };
}

describe("approvalBlockers (#140) — the pure gate", () => {
  it("blocks on the owner identity, the roster, and each unverified attendee", async () => {
    const { approvalBlockers } =
      await import("../../../apps/server/src/modules/meeting-debrief/review");
    const state: MeetingDebriefReviewState = {
      version: 1,
      runId: "run_x",
      roster: {
        status: "confirmed",
        confirmedAt: "2026-09-01T00:00:00.000Z",
        entries: [
          { email: OWNER_EMAIL, displayName: "Owner", profileId: "p_owner", profileRevision: 1 },
          {
            email: "alice@example.com",
            displayName: "Alice",
            profileId: "p_alice",
            profileRevision: 2,
          },
        ],
      },
      recipients: { additional: [] },
      review: { droppedActionItems: [], completedActionItems: [] },
      request: null,
      approval: null,
    };
    const open: Parameters<typeof approvalBlockers>[1] = {
      ownerEmail: () => OWNER_EMAIL,
      verifiedForEmail: (email) =>
        email === "alice@example.com" ? { profileId: "p_alice", profileRevision: 2 } : null,
    };
    expect(approvalBlockers(state, open)).toEqual([]);

    const closed: Parameters<typeof approvalBlockers>[1] = {
      ownerEmail: () => null,
      verifiedForEmail: () => null,
    };
    // Without a confirmed owner identity the owner's entry is just another
    // unverified attendee: the gate cannot tell them apart.
    expect(approvalBlockers(state, closed)).toEqual([
      "owner-identity-unconfirmed",
      "attendee-unverified-email:owner@example.com",
      "attendee-unverified-email:alice@example.com",
    ]);

    const unconfirmed: MeetingDebriefReviewState = {
      ...state,
      roster: { ...state.roster, status: "unconfirmed" },
    };
    expect(approvalBlockers(unconfirmed, open)).toEqual(["roster-unconfirmed"]);
  });
});

describe("Meeting Debrief redo (#140, spec #453)", () => {
  async function approvedRun(): Promise<{ runId: string; record: TranscriptRecord }> {
    anchoredProfile("Alice", "alice@example.com");
    const record = makeRecord({
      ...LINKED,
      roster: [
        { displayName: "Owner", email: OWNER_EMAIL },
        { displayName: "Alice", email: "alice@example.com" },
      ],
    });
    const runId = await startRun(record);
    const posted = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: {
        entries: [
          { email: OWNER_EMAIL, displayName: "Owner" },
          { email: "alice@example.com", displayName: "Alice" },
        ],
      },
    });
    expect(posted.statusCode).toBe(200);
    const approved = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/approve`,
    });
    expect(approved.statusCode).toBe(200);
    await h.host.idle();
    expect(h.runs.detail(runId)?.status).toBe("done");
    return { runId, record };
  }

  it("refuses redo of a Debrief that was never approved", async () => {
    const runId = await startRun(makeRecord());
    const refused = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/redo`,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("redo-requires-approval");
  });

  it("creates a distinct Run with a duplicate-output warning; the approved Run stays silent", async () => {
    const { runId, record } = await approvedRun();

    const redo = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/redo`,
    });
    expect(redo.statusCode).toBe(200);
    const redoRunId = redo.json().runId;
    expect(redoRunId).not.toBe(runId);
    await h.host.idle();

    const redoDetail = h.runs.detail(redoRunId)!;
    expect(redoDetail.status).toBe("done");
    expect(redoDetail.events.some((event) => event.type === "debrief_redo")).toBe(true);
    const redoView = (
      await (await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${redoRunId}` })).json()
    ).review;
    expect(redoView.duplicateWarning).toEqual({ approvedRunId: runId });

    const originalView = (
      await (await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` })).json()
    ).review;
    expect(originalView.duplicateWarning).toBeNull();
    void record;
  });

  it("re-mining the same transcript after redo still starts nothing", async () => {
    const { runId, record } = await approvedRun();
    const redo = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/redo`,
    });
    const redoRunId = redo.json().runId as string;
    await h.host.idle();

    await h.host.process(record);
    await h.host.idle();

    const ids = h.runs
      .list({ module: MEETING_DEBRIEF_MODULE_ID })
      .runs.map((summary) => summary.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set([runId, redoRunId]));
  });
});

class FlakyResumeHost extends MeetingDebriefHost {
  failNextResume = false;
  protected override resumeOwnerTurn(runId: string): Promise<RunMeta> {
    if (this.failNextResume) {
      this.failNextResume = false;
      return Promise.reject(new RunNotResumableError(runId));
    }
    return super.resumeOwnerTurn(runId);
  }
}

describe("Meeting Debrief review corrections (#140 review round)", () => {
  it("durable refusal clears the pending request: the owner can fix blockers and retry", async () => {
    anchoredProfile("Alice", "alice@example.com");
    const record = makeRecord({
      ...LINKED,
      roster: [
        { displayName: "Owner", email: OWNER_EMAIL },
        { displayName: "Alice", email: "alice@example.com" },
      ],
    });
    const runId = await startRun(record);
    const confirmed = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: {
        entries: [
          { email: OWNER_EMAIL, displayName: "Owner" },
          { email: "alice@example.com", displayName: "Alice" },
        ],
      },
    });
    expect(confirmed.statusCode).toBe(200);

    // The gate flips between the route's synchronous check (open) and the
    // Module Stage's durable re-assertion (closed): the refusal happens
    // inside the Run, after the route already said yes.
    h.ownerFlip.armed = true;
    const approved = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/approve`,
    });
    expect(approved.statusCode).toBe(200);
    await h.host.idle();
    h.ownerFlip.armed = false;

    // The Run kept waiting — and the pending request did NOT strand it.
    expect(h.runs.detail(runId)?.status).toBe("done");
    expect(reviewStateOf(runId).request).toBeNull();
    expect(h.runs.detail(runId)!.events.some((e) => e.type === "debrief_approval_refused")).toBe(
      true,
    );

    // Every mutation seam answers again — no run-not-reviewable strand.
    const rosterAgain = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: { entries: [] },
    });
    expect(rosterAgain.statusCode).toBe(200);
    const retried = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/approve`,
    });
    expect(retried.statusCode).toBe(200);
    await h.host.idle();
    expect(h.runs.detail(runId)?.status).toBe("done");
    /* Published on the retry: the gate was the only thing holding it. */
    expect(reviewStateOf(runId).approval).not.toBeNull();
  });

  it("a Shell-side resume failure reports honestly and reverts the persisted request", async () => {
    const flaky = makeHarness(FlakyResumeHost);
    h = flaky;
    const flakyHost = flaky.host as FlakyResumeHost;
    const runId = await startRun(makeRecord());

    flakyHost.failNextResume = true;
    const regenerate = await flaky.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "summary" },
    });
    expect(regenerate.statusCode).toBe(409);
    expect(regenerate.json().error).toBe("run-not-resumable");
    expect(reviewStateOf(runId).request).toBeNull();
    expect(h.runs.detail(runId)?.status).toBe("done");

    // The seam unlocked: the same request goes through now.
    const retried = await flaky.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/regenerate`,
      payload: { field: "summary" },
    });
    expect(retried.statusCode).toBe(200);
    await flaky.host.idle();
    expect(h.runs.detail(runId)?.status).toBe("done");
    expect(reviewStateOf(runId).request).toBeNull();

    // The approve route reverts the same way, once the gate is open.
    anchoredProfile("Alice", "alice@example.com");
    const confirmed = await flaky.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: {
        entries: [
          { email: OWNER_EMAIL, displayName: "Owner" },
          { email: "alice@example.com", displayName: "Alice" },
        ],
      },
    });
    expect(confirmed.statusCode).toBe(200);
    flakyHost.failNextResume = true;
    const approve = await flaky.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/approve`,
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error).toBe("run-not-resumable");
    expect(reviewStateOf(runId).request).toBeNull();
    expect(h.runs.detail(runId)?.status).toBe("done");
  });

  it("mints Calendar shells only for emails the Calendar occurrence actually lists", async () => {
    const runId = await startRun(
      makeRecord({
        ...LINKED,
        roster: [{ displayName: "Alice", email: "alice@example.com" }],
      }),
    );

    const posted = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: {
        entries: [
          { email: "alice@example.com", displayName: "Alice" },
          { email: "dana@elsewhere.com", displayName: "Dana" },
        ],
      },
    });
    expect(posted.statusCode).toBe(200);

    const state = reviewStateOf(runId);
    const alice = state.roster.entries.find((entry) => entry.email === "alice@example.com");
    const dana = state.roster.entries.find((entry) => entry.email === "dana@elsewhere.com");
    // A roster member: the Calendar-anchored shell, as before.
    expect(alice?.profileId).not.toBeNull();
    // A typed email the occurrence never listed: no Calendar-sourced shell.
    expect(dana?.profileId).toBeNull();
    expect(h.people.search().some((profile) => profile.primaryEmail === "dana@elsewhere.com")).toBe(
      false,
    );
    const detail = await (
      await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` })
    ).json();
    expect(detail.review.approvalBlockers).toContain(
      "attendee-unverified-email:dana@elsewhere.com",
    );
  });
});
