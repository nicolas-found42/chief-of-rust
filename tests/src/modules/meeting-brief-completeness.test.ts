import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import fastify from "fastify";
import type {
  MeetingBriefEvent,
  MeetingBriefProviderOutcome,
  MeetingBriefProviderOutcomes,
} from "@chief-of-staff-demo/shared";
import { openRuns, type Runs } from "../../../apps/server/src/runs";
import { MeetingBriefHost } from "../../../apps/server/src/modules/meeting-brief-generator/host";
import type { MeetingBriefHostDeps } from "../../../apps/server/src/modules/meeting-brief-generator/host";
import { completeFixtureBrief } from "../../../apps/server/src/modules/meeting-brief-generator/testRuntime";
import { ConfigStore } from "../../../apps/server/src/config";
import {
  FakeGmailProvider,
  type GmailThread,
} from "../../../apps/server/src/modules/meeting-brief-generator/google/gmail";
import { FakeCalendarHistoryProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/calendarHistory";
import { FakeDriveProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/drive";
import { FakePublicIntelligenceProvider } from "../../../apps/server/src/modules/meeting-brief-generator/enrichment/publicIntelligence";
import type { HubSpotApi } from "../../../apps/server/src/modules/meeting-brief-generator/hubspot/client";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
/* Ticket #137 — enforce complete Meeting Brief evidence until the cutoff.
 *
 * Every selected provider records a versioned outcome, diagnostics and a
 * reusable artifact; a failed selected provider blocks composition and
 * delivery while successful siblings survive; automatic retries use bounded
 * backoff and stop 30 minutes before the occurrence start; at cutoff the Run
 * fails visibly and sends nothing; a provider leaves the required set only
 * through an explicit policy action followed by an explicit retry. */

const DUE_AT = "2026-08-28T11:00:00.000Z";
const START_AT = "2026-08-28T15:00:00.000Z";
const CUTOFF_AT = "2026-08-28T14:30:00.000Z";

function makeAttendeeProfiles(): WorkspacePersonProfiles {
  return new WorkspacePersonProfiles({
    store: new PersonProfileStore(mkdtempSync(join(tmpdir(), "mb-completeness-profiles-"))),
    now: () => new Date(DUE_AT),
    lifecycle: [],
  });
}

/**
 * Counts the CRM lookups the Run actually performs. A retry must rerun only the
 * failed provider, and the ledger keeping `crm:…:completed` cannot show that on
 * its own — a provider re-fetched on every attempt would leave the same ledger.
 * The count is what separates a reused artifact from a repeated call.
 */
function stubHubSpotApi(calls: { count: number }): HubSpotApi {
  return {
    async listContacts() {
      return { results: [] };
    },
    async searchContactByEmail() {
      calls.count += 1;
      return null;
    },
    async getAssociatedCompanyIds() {
      return [];
    },
    async getCompany() {
      return null;
    },
    async getAssociatedDealIds() {
      return [];
    },
    async getDeal() {
      return null;
    },
    async getAssociatedDealIdsForCompany() {
      return [];
    },
  };
}

/** Gmail provider whose exact-address lane fails persistently until healed. */
class FlakyGmailProvider extends FakeGmailProvider {
  private failed = true;
  exactCalls = 0;
  heal(): void {
    this.failed = false;
  }
  override async listExactThreads(guestEmail: string, maxResults: number): Promise<GmailThread[]> {
    this.exactCalls += 1;
    if (this.failed) throw Object.assign(new Error("transient gmail outage"), { status: 500 });
    return super.listExactThreads(guestEmail, maxResults);
  }
}

function fixtureEvent(overrides: Partial<MeetingBriefEvent> = {}): MeetingBriefEvent {
  return {
    calendarId: "primary",
    eventId: "evt_complete_1",
    occurrenceId: "2026-08-28T15:00:00Z",
    version: "v1",
    summary: "Completeness Sync",
    startAt: START_AT,
    endAt: "2026-08-28T15:30:00.000Z",
    organizer: { email: "owner@example.com", displayName: "Owner" },
    attendees: [
      { email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" },
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: "accepted",
        organizer: true,
      },
    ],
    attachments: [],
    ...overrides,
    status: "confirmed",
  };
}

interface Harness {
  runs: Runs;
  workspaceDir: string;
  host: MeetingBriefHost;
  gmail: FlakyGmailProvider;
  sends: () => number;
  crmCalls: () => number;
}

function makeHarness(overrides: Partial<MeetingBriefHostDeps> = {}): Harness {
  const workspaceDir = mkdtempSync(join(tmpdir(), "mb-completeness-"));
  const runs = openRuns(workspaceDir);
  const configStore = new ConfigStore(join(workspaceDir, "config.json"));
  configStore.load();
  const gmail = new FlakyGmailProvider();
  let sends = 0;
  const delivery = {
    async findByDeliveryId() {
      return null;
    },
    async send() {
      sends += 1;
      return { messageId: `m-${sends}`, recipient: "owner@example.com" };
    },
  };
  const crmCalls = { count: 0 };
  const host = new MeetingBriefHost({
    runs,
    workspaceDir,
    configStore,
    now: () => new Date(nowMs),
    log: () => {},
    gmailDeliveryProvider: delivery,
    completeBrief: completeFixtureBrief,
    enrichmentProviders: {
      gmailProvider: gmail,
      calendarHistoryProvider: new FakeCalendarHistoryProvider(),
      driveProvider: new FakeDriveProvider(),
      attendeeProfiles: makeAttendeeProfiles(),
      getHubSpotApi: () => stubHubSpotApi(crmCalls),
      publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
    },
    getInternalDomains: () => ["example.com"],
    ...overrides,
  });
  return { runs, workspaceDir, host, gmail, sends: () => sends, crmCalls: () => crmCalls.count };
}

let nowMs = Date.parse(DUE_AT);

async function advance(harness: Harness, to: string): Promise<void> {
  nowMs = Date.parse(to);
  await harness.host.recover();
  await harness.host.idle();
}

function ledgerOf(harness: Harness, runId: string): MeetingBriefProviderOutcomes {
  const raw = harness.runs.open(runId)!.readArtifact("provider-outcomes.json")!;
  return JSON.parse(raw) as MeetingBriefProviderOutcomes;
}

interface HarnessCountingSends extends Harness {
  sendCount: () => number;
}

let harness: Harness;

beforeEach(() => {
  nowMs = Date.parse(DUE_AT);
  harness = makeHarness();
  const event = fixtureEvent();
  harness.host.scheduleOccurrence(event, new Date(DUE_AT));
});

describe("completeness gate — per-provider outcomes block a partial Brief", () => {
  it("blocks on bounded backoff with a versioned ledger, no enrich.json, no compose, no send", async () => {
    const created = await harness.host.processDueSchedules(new Date(nowMs));
    await harness.host.idle();
    const runId = created[0];
    const detail = harness.runs.detail(runId)!;

    expect(detail.status).toBe("blocked");
    const blocked = detail.events.find((e) => e.type === "run_blocked");
    expect(blocked?.detail).toMatchObject({ reason: "provider_retry_backoff" });

    const ledger = ledgerOf(harness, runId);
    expect(ledger.version).toBe(1);
    expect(ledger.bundleVersion).toBe(1);
    expect(ledger.occurrenceKey).toBe("evt_complete_1::2026-08-28T15:00:00Z");
    expect(ledger.retryCount).toBe(1);
    const byProvider = (outcomes: MeetingBriefProviderOutcome[]) =>
      outcomes.map((o) => `${o.provider}:${o.attendee}:${o.outcome}`);
    expect(byProvider(ledger.outcomes)).toContain("gmail-relationship:alice@external.co:failed");
    expect(byProvider(ledger.outcomes)).toContain("gmail-relationship:owner@example.com:failed");
    expect(byProvider(ledger.outcomes)).toContain("crm:alice@external.co:completed");
    expect(byProvider(ledger.outcomes)).toContain("calendar-history:alice@external.co:empty");
    const failedOutcome = ledger.outcomes.find(
      (o) => o.provider === "gmail-relationship" && o.attendee === "alice@external.co",
    )!;
    expect(failedOutcome.diagnostics?.httpStatus).toBe(500);
    expect(failedOutcome.artifact).toContain("gmail-exact-alice_external_co-");

    // No partial Brief anywhere downstream.
    expect(harness.runs.open(runId)!.readArtifact("enrich.json")).toBeNull();
    expect(harness.runs.open(runId)!.readArtifact("result.json")).toBeNull();
    expect(harness.sends()).toBe(0);
  });

  it("a blocked enrich exposes its provider outcomes through the Cross-Run index", async () => {
    await harness.host.processDueSchedules(new Date(nowMs));
    await harness.host.idle();
    const index = harness.host.index();
    const entry = index.briefs[0];
    expect(entry.status).toBe("blocked");
    expect(entry.meetingBrief).toBeNull();
    expect(entry.providerOutcomes?.some((o) => o.outcome === "failed")).toBe(true);
  });
});

describe("automatic bounded-backoff retries", () => {
  it("resumes after the backoff, reruns only the failed provider, and completes when it heals", async () => {
    const created = await harness.host.processDueSchedules(new Date(nowMs));
    await harness.host.idle();
    const runId = created[0];
    ledgerOf(harness, runId);
    const firstRetryAt = Date.parse(
      harness.runs.detail(runId)!.events.find((e) => e.type === "enrich_retry_scheduled")!.detail
        ?.retryAt as string,
    );
    // One minute after the first failure, always before the cutoff.
    expect(firstRetryAt).toBe(Date.parse(DUE_AT) + 60_000);
    expect(firstRetryAt).toBeLessThan(Date.parse(CUTOFF_AT));

    // Advance past the first backoff: gmail still broken.
    await advance(harness, "2026-08-28T11:01:00.000Z");
    let detail = harness.runs.detail(runId)!;
    expect(detail.status).toBe("blocked");
    expect(ledgerOf(harness, runId).retryCount).toBe(2);
    // The second wait backs off further (bounded exponential).
    const retryEvents = harness.runs
      .detail(runId)!
      .events.filter((e) => e.type === "enrich_retry_scheduled");
    const secondRetryAt = Date.parse(retryEvents[retryEvents.length - 1].detail?.retryAt as string);
    expect(secondRetryAt).toBe(Date.parse(DUE_AT) + 60_000 + 120_000);

    /* The whole point of the per-provider ledger: CRM succeeded on the first
       attempt and is not asked again across either backoff. */
    const crmCallsAfterFirstAttempt = harness.crmCalls();
    expect(crmCallsAfterFirstAttempt).toBeGreaterThan(0);

    // Heal the provider and advance: the retry completes the whole Run.
    harness.gmail.heal();
    await advance(harness, "2026-08-28T11:03:00.000Z");
    detail = harness.runs.detail(runId)!;
    expect(detail.status).toBe("done");
    const finalLedger = ledgerOf(harness, runId);
    expect(finalLedger.retryCount).toBe(2);
    expect(finalLedger.outcomes.every((o) => o.outcome !== "failed")).toBe(true);
    expect(harness.crmCalls()).toBe(crmCallsAfterFirstAttempt);
    expect((detail.result as { delivery?: { status?: string } } | null)?.delivery?.status).toBe(
      "sent",
    );
    expect(harness.sends()).toBe(1);
  });
});

describe("the cutoff", () => {
  it("fails the Run visibly at 30 minutes before start and sends nothing", async () => {
    const created = await harness.host.processDueSchedules(new Date(nowMs));
    await harness.host.idle();
    const runId = created[0];
    const sendsAfterBlock = harness.sends();

    await advance(harness, CUTOFF_AT);
    const detail = harness.runs.detail(runId)!;
    expect(detail.status).toBe("failed");
    expect(detail.failedStage).toBe("enrich");
    expect(detail.failureHint).toContain("cutoff");
    const runFailed = detail.events.find((e) => e.type === "run_failed");
    expect(runFailed?.detail?.reason).toContain("brief_cutoff");
    // No partial Brief was composed or delivered.
    expect(harness.runs.open(runId)!.readArtifact("enrich.json")).toBeNull();
    expect(harness.runs.open(runId)!.readArtifact("result.json")).toBeNull();
    expect(harness.sends()).toBe(sendsAfterBlock);
    // Failed, so no further automatic attempts fire.
    const attempts = harness.gmail.exactCalls;
    await advance(harness, "2026-08-28T14:40:00.000Z");
    expect(harness.gmail.exactCalls).toBe(attempts);
  });
});

describe("explicit policy actions", () => {
  it("disable stops automatic retries, records the action, and an explicit retry completes without the provider", async () => {
    const created = await harness.host.processDueSchedules(new Date(nowMs));
    await harness.host.idle();
    const runId = created[0];

    const app = fastify({ logger: false });
    await harness.host.routes(app);
    const response = await app.inject({
      method: "POST",
      url: `/api/meeting-brief/runs/${runId}/provider-policy`,
      payload: { provider: "gmail-relationship", action: "disable", reason: "degraded provider" },
    });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("failed");

    // The action is recorded on the Run and the policy persists in config.
    const detail = harness.runs.detail(runId)!;
    expect(detail.events.some((e) => e.type === "provider_policy_action")).toBe(true);
    expect(detail.failureHint).toContain("explicit policy action");
    const policy = harness.host.getProviderPolicy()["gmail-relationship"];
    expect(policy).toMatchObject({ disabled: true, reason: "degraded provider" });

    // The person's explicit retry is what continues the work.
    await harness.host.retryRun(runId);
    await harness.host.idle();
    const retried = harness.runs.detail(runId)!;
    expect(retried.status).toBe("done");
    expect((retried.result as { delivery?: { status?: string } } | null)?.delivery?.status).toBe(
      "sent",
    );
    const ledger = ledgerOf(harness, runId);
    expect(ledger.outcomes.find((o) => o.provider === "gmail-relationship")?.outcome).toBe(
      "disabled",
    );
  });

  it("re-enabling restores the requirement; a repaired provider completes on explicit retry", async () => {
    const created = await harness.host.processDueSchedules(new Date(nowMs));
    await harness.host.idle();
    const runId = created[0];

    const app = fastify({ logger: false });
    await harness.host.routes(app);
    const repaired = await app.inject({
      method: "POST",
      url: `/api/meeting-brief/runs/${runId}/provider-policy`,
      payload: { provider: "gmail-relationship", action: "repair", reason: "outage cleared" },
    });
    expect(repaired.statusCode).toBe(200);
    await app.close();
    harness.gmail.heal();
    // Repair alone never completes the Run — the explicit retry does.
    const detail = harness.runs.detail(runId)!;
    expect(detail.status).toBe("failed");
    expect(harness.sends()).toBe(0);
    await harness.host.retryRun(runId);
    await harness.host.idle();
    expect(harness.runs.detail(runId)!.status).toBe("done");

    // Re-enable puts the provider back into the required set.
    const app2 = fastify({ logger: false });
    await harness.host.routes(app2);
    const enabled = await app2.inject({
      method: "POST",
      url: `/api/meeting-brief/runs/${runId}/provider-policy`,
      payload: { provider: "gmail-relationship", action: "enable" },
    });
    await app2.close();
    expect(enabled.statusCode).toBe(200);
    expect(harness.host.getProviderPolicy()["gmail-relationship"]).toMatchObject({
      disabled: false,
    });
  });

  it("refuses unknown providers, actions, and foreign runs at the route boundary", async () => {
    await harness.host.processDueSchedules(new Date(nowMs));
    await harness.host.idle();
    const runId = harness.runs.list({ module: "meeting-brief-generator" }).runs[0].id;

    const app = fastify({ logger: false });
    await harness.host.routes(app);
    const badProvider = await app.inject({
      method: "POST",
      url: `/api/meeting-brief/runs/${runId}/provider-policy`,
      payload: { provider: "telepathy", action: "disable" },
    });
    expect(badProvider.statusCode).toBe(400);
    const badAction = await app.inject({
      method: "POST",
      url: `/api/meeting-brief/runs/${runId}/provider-policy`,
      payload: { provider: "crm", action: "relax" },
    });
    expect(badAction.statusCode).toBe(400);
    const foreignRun = await app.inject({
      method: "POST",
      url: "/api/meeting-brief/runs/run_missing/provider-policy",
      payload: { provider: "crm", action: "disable" },
    });
    expect(foreignRun.statusCode).toBe(404);
    await app.close();
  });
});

// Keep the counting-sends shape referenced so the harness type documents it.
export type { HarnessCountingSends };
