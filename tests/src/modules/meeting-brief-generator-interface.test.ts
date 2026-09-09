import { describe, expect, it } from "vitest";
import type {
  MeetingBrief,
  MeetingBriefEvent,
  MeetingBriefProviderOutcome,
  MeetingBriefProviderOutcomes,
} from "@chief-of-staff-demo/shared";
import type { RunContext } from "../../../apps/server/src/engine/module";
import { meetingBriefModule } from "../../../apps/server/src/modules/meeting-brief-generator/module";
import { buildFrozenSnapshot } from "../../../apps/server/src/modules/meeting-brief-generator/snapshot";
import {
  createMeetingBriefGenerator,
  type FrozenMeetingOccurrence,
} from "../../../apps/server/src/modules/meeting-brief-generator/generator";

const NOW = new Date("2026-09-01T12:00:00.000Z");

function frozenOccurrence(): FrozenMeetingOccurrence {
  const event: MeetingBriefEvent = {
    calendarId: "primary",
    eventId: "evt-generator-interface",
    occurrenceId: "2026-09-01T15:00:00Z",
    version: "v1",
    summary: "Generator Interface Review",
    startAt: "2026-09-01T15:00:00.000Z",
    endAt: "2026-09-01T16:00:00.000Z",
    organizer: { email: "owner@example.com", displayName: "Owner" },
    attendees: [{ email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" }],
    status: "confirmed",
  };
  return buildFrozenSnapshot(event, NOW.toISOString());
}

function fixtureBrief(input: FrozenMeetingOccurrence): MeetingBrief {
  return {
    version: 1,
    eventId: input.eventId,
    occurrenceId: input.occurrenceId,
    eventVersion: input.version,
    generatedAt: NOW.toISOString(),
    logistics: {
      title: input.summary,
      startAt: input.startAt,
      endAt: input.endAt,
      location: null,
      conferenceLink: null,
      organizer: input.organizer ?? null,
    },
    summary: `Brief for ${input.summary}`,
    guests: [],
    companies: [],
    conversationStarters: [],
    sourceReferences: [],
    missingEvidence: [],
    uncertainty: [],
  };
}

function runContext() {
  const files = new Map<string, string>();
  const stages: string[] = [];
  const events: Array<{ type: string; detail?: Record<string, unknown> }> = [];
  const waits: Array<{ reason: string; timeout: unknown }> = [];
  const waitSignal = new Error("wait");
  const context: RunContext = {
    runId: "run-generator-interface",
    meta: () => {
      throw new Error("unused");
    },
    async stage(name, fn) {
      stages.push(name);
      return fn();
    },
    event(type, detail) {
      events.push(detail ? { type, detail } : { type });
    },
    attempt: () => 1,
    wait(request): never {
      waits.push(request);
      throw waitSignal;
    },
    readFile: (name) => files.get(name) ?? null,
    writeFile: (name, text) => void files.set(name, text),
  };
  return { context, events, files, stages, waits, waitSignal };
}

describe("MeetingBriefGenerator interface — issue #168", () => {
  it("receives the exact occurrence captured by the Run snapshot caller", async () => {
    const harness = runContext();
    const stopAfterCapture = new Error("captured");
    let captured: FrozenMeetingOccurrence | null = null;
    const module = meetingBriefModule({
      now: () => NOW,
      getOwnerEmail: () => "owner@example.com",
      createBriefGenerator: () => ({
        async generate(occurrence) {
          captured = occurrence;
          throw stopAfterCapture;
        },
      }),
    });

    const input = frozenOccurrence();
    const error = await module.run(harness.context, input).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBe(stopAfterCapture);
    const persistedOccurrence = JSON.parse(harness.files.get("snapshot.json")!) as Record<
      string,
      unknown
    >;
    Reflect.deleteProperty(persistedOccurrence, "eligible");
    expect(captured).toEqual(persistedOccurrence);
    expect(captured).toMatchObject({
      capturedAt: NOW.toISOString(),
      materialFingerprint: expect.any(String),
    });
  });

  it("preserves successful evidence and blocks composition when a required provider fails", async () => {
    const harness = runContext();
    let composeCalls = 0;
    const outcomes: MeetingBriefProviderOutcome[] = [
      {
        provider: "calendar-history",
        attendee: "alice@external.co",
        outcome: "completed",
        artifact: "calendar-history-alice.json",
        diagnostics: { httpStatus: null, errorCode: null, reason: null },
      },
      {
        provider: "gmail-relationship",
        attendee: "alice@external.co",
        outcome: "failed",
        artifact: "gmail-alice.json",
        diagnostics: { httpStatus: 500, errorCode: null, reason: "transient" },
      },
    ];
    const generator = createMeetingBriefGenerator({
      context: harness.context,
      now: () => NOW,
      enrich: async () => ({
        sections: [],
        evidence: ["calendar-history-alice.json"],
        outcomes,
        bundleVersion: 1,
      }),
      completeBrief: async (input) => {
        composeCalls += 1;
        return fixtureBrief(input);
      },
    });

    const error = await generator.generate(frozenOccurrence()).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBe(harness.waitSignal);
    expect(composeCalls).toBe(0);
    expect(harness.stages).toEqual(["enrich"]);
    expect(harness.files.has("enrich.json")).toBe(false);
    expect(harness.waits).toHaveLength(1);
    expect(harness.waits[0]?.reason).toBe("provider_retry_backoff");
    const ledger = JSON.parse(
      harness.files.get("provider-outcomes.json")!,
    ) as MeetingBriefProviderOutcomes;
    expect(ledger).toMatchObject({
      version: 1,
      bundleVersion: 1,
      occurrenceKey: "evt-generator-interface::2026-09-01T15:00:00Z",
      eventVersion: "v1",
      retryCount: 1,
      outcomes,
    });
  });

  it("selects frozen evidence and assembles the prompt before returning the Brief", async () => {
    const harness = runContext();
    let prompt = "";
    const generator = createMeetingBriefGenerator({
      context: harness.context,
      now: () => NOW,
      getInternalDomains: () => ["example.com"],
      enrich: async () => ({
        sections: [
          {
            source: "calendar-history",
            guest: "alice@external.co",
            status: "completed",
            company: null,
            evidence: ["Alice led the prior launch review."],
            references: ["calendar:event/prior-review"],
          },
        ],
        evidence: ["calendar:event/prior-review"],
      }),
      getCompleteJson: () => async (request) => {
        prompt = request.user;
        return {
          summary: "Prepare for the launch review with Alice.",
          guests: [
            {
              email: "alice@external.co",
              name: "Alice",
              role: null,
              background: "Led the prior launch review.",
              relationshipHistory: ["Led the prior launch review."],
              crmContext: null,
              talkingPoints: ["Ask what changed since the prior review."],
              uncertainty: [],
              evidenceReferences: ["calendar:event/prior-review"],
            },
          ],
          companies: [],
          conversationStarters: ["What changed?", "What matters next?"],
          sourceReferences: ["calendar:event/prior-review"],
          missingEvidence: [],
          uncertainty: [],
        };
      },
    });

    const brief = await generator.generate(frozenOccurrence());

    expect(harness.stages).toEqual(["enrich", "compose"]);
    expect(brief).toMatchObject({
      eventId: "evt-generator-interface",
      eventVersion: "v1",
      summary: "Prepare for the launch review with Alice.",
    });
    expect(prompt).toContain("Event title: Generator Interface Review");
    expect(prompt).toContain("Alice led the prior launch review.");
    expect(prompt).toContain("calendar:event/prior-review");
  });
});
