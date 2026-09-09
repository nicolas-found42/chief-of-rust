/* oxlint-disable typescript/no-explicit-any, typescript/no-unused-vars -- test fixtures use any for fakes */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { beforeEach, describe, expect, it } from "vitest";
import type { MeetingBriefEvent } from "@chief-of-staff-demo/shared";
import {
  completeFixtureBrief,
  fixtureGmailDeliveryProvider,
} from "../../../apps/server/src/modules/meeting-brief-generator/testRuntime";
import { GOOGLE_ENRICHMENT_MAX_GMAIL_EXACT } from "@chief-of-staff-demo/shared";
import { openRuns, type Runs } from "../../../apps/server/src/runs";
import { MeetingBriefHost } from "../../../apps/server/src/modules/meeting-brief-generator/host";
import { FakeGmailProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/gmail";
import { FakeCalendarHistoryProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/calendarHistory";
import { FakeDriveProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/drive";
import { FakePublicIntelligenceProvider } from "../../../apps/server/src/modules/meeting-brief-generator/enrichment/publicIntelligence";
import type { HubSpotApi } from "../../../apps/server/src/modules/meeting-brief-generator/hubspot/client";
import { enrichUnified } from "../../../apps/server/src/modules/meeting-brief-generator/enrichment/enrich";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";

function makeAttendeeProfiles(): WorkspacePersonProfiles {
  return new WorkspacePersonProfiles({
    store: new PersonProfileStore(mkdtempSync(join(tmpdir(), "mb-attendee-profiles-"))),
    now: () => new Date("2026-08-28T10:00:00.000Z"),
    lifecycle: [],
  });
}

function stubHubSpotApi(): HubSpotApi {
  return {
    async listContacts() {
      return { results: [] };
    },
    async searchContactByEmail() {
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

const fixtureDeliver = fixtureGmailDeliveryProvider();

function fixtureEvent(overrides: Partial<MeetingBriefEvent> = {}): MeetingBriefEvent {
  return {
    calendarId: "primary",
    eventId: "evt_google_1",
    occurrenceId: "2026-08-28T15:00:00Z",
    version: "v1",
    summary: "Sync with External Guests",
    description: "Discuss roadmap",
    startAt: new Date("2026-08-28T15:00:00.000Z").toISOString(),
    endAt: new Date("2026-08-28T16:00:00.000Z").toISOString(),
    location: "https://meet.example.com/abc",
    conferenceLink: "https://meet.example.com/abc",
    organizer: { email: "owner@example.com", displayName: "Owner" },
    attendees: [
      { email: "alice@external.co", displayName: "Alice External", responseStatus: "accepted" },
      { email: "bob@gmail.com", displayName: "Bob Consumer", responseStatus: "accepted" },
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: "accepted",
        organizer: true,
      },
    ],
    attachments: [],
    ...overrides,
    status: overrides.status ?? "confirmed",
  };
}

let workspaceDir: string;
let runs: Runs;
let now: Date;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "mbf-google-"));
  runs = openRuns(workspaceDir);
  now = new Date("2026-08-28T09:00:00.000Z");
});

describe("Google enrichment via host seam — bounded, keyed, diagnostics, untrusted", () => {
  it("same-version retry preserves the complete HubSpot contact/company/deal checkpoint", async () => {
    const files = new Map<string, string>();
    const calls: string[] = [];
    const hubSpotApi: HubSpotApi = {
      async listContacts() {
        return { results: [] };
      },
      async searchContactByEmail(email) {
        calls.push(`contact:${email}`);
        return {
          id: "contact-1",
          email,
          properties: {},
          associatedCompanyIds: [],
          associatedDealIds: [],
        };
      },
      async getAssociatedCompanyIds() {
        calls.push("company-associations");
        return ["company-1"];
      },
      async getCompany() {
        calls.push("company");
        return { id: "company-1", name: "External Co", domain: "external.co", properties: {} };
      },
      async getAssociatedDealIds() {
        calls.push("contact-deals");
        return ["deal-1"];
      },
      async getAssociatedDealIdsForCompany() {
        calls.push("company-deals");
        return [];
      },
      async getDeal() {
        calls.push("deal");
        return { id: "deal-1", name: "Renewal", amount: null, stage: null, properties: {} };
      },
    };
    const ctx = {
      readFile: (name: string) => files.get(name) ?? null,
      writeFile: (name: string, value: string) => files.set(name, value),
      event: () => {},
    };
    const deps = {
      providers: {
        gmailProvider: new FakeGmailProvider(),
        calendarHistoryProvider: new FakeCalendarHistoryProvider(),
        driveProvider: new FakeDriveProvider(),
        attendeeProfiles: makeAttendeeProfiles(),
        getHubSpotApi: () => hubSpotApi,
        publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
      },
      internalDomains: ["example.com"],
    };
    const event = fixtureEvent({
      attendees: [
        { email: "alice@external.co", responseStatus: "accepted" },
        { email: "owner@example.com", responseStatus: "accepted", organizer: true },
      ],
    });

    const first = await enrichUnified(event, ctx, deps);
    const callCount = calls.length;
    const second = await enrichUnified(event, ctx, deps);

    expect(calls).toHaveLength(callCount);
    expect(first.sections.filter((section) => section.source.startsWith("hubspot-"))).toEqual(
      second.sections.filter((section) => section.source.startsWith("hubspot-")),
    );
    expect(second.sections.some((section) => section.source === "hubspot-company")).toBe(true);
    expect(second.sections.some((section) => section.source === "hubspot-deal")).toBe(true);
  });

  it("same-version retry requests only failed HubSpot work and reuses completed contact work", async () => {
    const files = new Map<string, string>();
    let contactCalls = 0;
    let companyAssociationCalls = 0;
    const apiWithPartialFailure: HubSpotApi = {
      ...stubHubSpotApi(),
      async searchContactByEmail(email) {
        contactCalls += 1;
        return {
          id: "contact-1",
          email,
          properties: {},
          associatedCompanyIds: [],
          associatedDealIds: [],
        };
      },
      async getAssociatedCompanyIds() {
        companyAssociationCalls += 1;
        if (companyAssociationCalls === 1) {
          throw Object.assign(new Error("temporary company source failure"), { status: 500 });
        }
        return ["company-1"];
      },
      async getCompany() {
        return { id: "company-1", name: "External Co", domain: "external.co", properties: {} };
      },
    };
    const ctx = {
      readFile: (name: string) => files.get(name) ?? null,
      writeFile: (name: string, value: string) => files.set(name, value),
      event: () => {},
    };
    const deps = {
      providers: {
        gmailProvider: new FakeGmailProvider(),
        calendarHistoryProvider: new FakeCalendarHistoryProvider(),
        driveProvider: new FakeDriveProvider(),
        attendeeProfiles: makeAttendeeProfiles(),
        getHubSpotApi: () => apiWithPartialFailure,
        publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
      },
      internalDomains: ["example.com"],
    };
    const event = fixtureEvent({
      attendees: [
        { email: "alice@external.co", responseStatus: "accepted" },
        { email: "owner@example.com", responseStatus: "accepted", organizer: true },
      ],
    });

    const first = await enrichUnified(event, ctx, deps);
    const second = await enrichUnified(event, ctx, deps);

    expect(
      first.sections.some(
        (section) => section.source === "hubspot-company" && section.status === "completed",
      ),
    ).toBe(true);
    expect(
      second.sections.some(
        (section) => section.source === "hubspot-company" && section.status === "completed",
      ),
    ).toBe(true);
    expect(contactCalls).toBe(1);
    expect(companyAssociationCalls).toBe(2);
  });

  it("collects at most 10 exact-address Gmail, bounded company-domain for non-Consumer, 10 prior meetings, bounded Docs", async () => {
    const gmail = new FakeGmailProvider();
    // Alice exact: 12 threads (should be limited to 10, truncated), company domain threads 3, dedup tested via duplicate ids
    const exactThreadsForAlice = Array.from({ length: 12 }, (_, i) => ({
      id: i < 11 ? `t${i}` : "t0", // last is duplicate of t0
      snippet: `Exact thread ${i} with alice@external.co — ${"x".repeat(600)}`, // test untrusted truncation to 500
    }));
    gmail.setExactThreads("alice@external.co", exactThreadsForAlice);
    gmail.setCompanyThreads("external.co", [
      { id: "c1", snippet: "Company thread 1 @external.co" },
      { id: "c2", snippet: "Company thread 2 @external.co" },
      { id: "c1", snippet: "Company duplicate c1" }, // dedup
    ]);
    // Bob is consumer gmail.com — should have exact but no company Gmail
    gmail.setExactThreads("bob@gmail.com", [{ id: "b1", snippet: "Bob exact thread" }]);
    // No company threads for gmail.com should be queried; set if it were, would be ignored

    const calendar = new FakeCalendarHistoryProvider();
    calendar.setPastMeetings(
      "alice@external.co",
      Array.from({ length: 15 }, (_, i) => ({
        id: `cal${i}`,
        summary: `Past meeting ${i} with Alice`,
        startAt: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
      })),
    );
    calendar.setPastMeetings("bob@gmail.com", []); // empty success

    const drive = new FakeDriveProvider();
    drive.setDocs("fulltext contains 'external.co' or fulltext contains 'alice@external.co'", [
      {
        id: "doc1",
        name: "External Co Proposal",
        webViewLink: "https://drive.google.com/file/d/doc1/view",
      },
      {
        id: "doc1",
        name: "Duplicate doc1",
        webViewLink: "https://drive.google.com/file/d/doc1/view",
      },
      { id: "doc2", name: "Alice Notes", webViewLink: "https://drive.google.com/file/d/doc2/view" },
    ]);
    drive.setDocs("fulltext contains 'bob@gmail.com'", []); // bob consumer, person-level empty

    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      gmailDeliveryProvider: fixtureDeliver,
      completeBrief: completeFixtureBrief,
      enrichmentProviders: {
        gmailProvider: gmail,
        calendarHistoryProvider: calendar,
        driveProvider: drive,
        attendeeProfiles: makeAttendeeProfiles(),
        getHubSpotApi: () => stubHubSpotApi(),
        publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
      },
      getInternalDomains: () => ["internal.example"],
    });

    const event = fixtureEvent({ version: "v1" });
    host.scheduleOccurrence(event, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    const created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(1);
    await host.idle();

    const runId = created[0];
    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("done");

    // Gmail exact for alice: at most 10, deduped, truncated diagnostics
    const gmailExactRaw = runs.open(runId)!.readArtifact("gmail-exact-alice_external_co-v1.json")!;
    const gmailExact = JSON.parse(gmailExactRaw);
    expect(gmailExact.key).toBe("v1::alice@external.co::gmail-exact");
    expect(gmailExact.stableRef).toBe("v1::alice@external.co::gmail-exact");
    expect(gmailExact.status).toBe("completed");
    expect(gmailExact.evidence).toHaveLength(10); // bounded to 10
    expect(gmailExact.diagnostics.bounded).toBe(true);
    expect(gmailExact.diagnostics.maxResults).toBe(GOOGLE_ENRICHMENT_MAX_GMAIL_EXACT);
    expect(gmailExact.diagnostics.truncated).toBe(true);
    expect(gmailExact.diagnostics.untrusted).toBe(true);
    // Evidence truncated to 500
    expect(gmailExact.evidence[0].length).toBeLessThanOrEqual(500);
    expect(gmailExact.references[0]).toContain("https://mail.google.com");

    // Company-domain for alice (non-Consumer) should exist, deduped to 2
    const gmailCompanyRaw = runs
      .open(runId)!
      .readArtifact("gmail-company-alice_external_co-external_co-v1.json")!;
    const gmailCompany = JSON.parse(gmailCompanyRaw);
    expect(gmailCompany.key).toBe("v1::alice@external.co::gmail-company-domain::external.co");
    expect(gmailCompany.status).toBe("completed");
    expect(gmailCompany.evidence).toHaveLength(2); // deduped from 3 to 2
    expect(gmailCompany.companyDomain).toBe("external.co");

    // Bob is consumer — should have exact but no company Gmail artifact
    const bobExactRaw = runs.open(runId)!.readArtifact("gmail-exact-bob_gmail_com-v1.json")!;
    expect(bobExactRaw).toBeTruthy();
    const bobCompanyExists = runs
      .open(runId)!
      .readArtifact("gmail-company-bob_gmail_com-gmail_com-v1.json");
    expect(bobCompanyExists).toBeNull(); // consumer domain not used for company Gmail

    // Calendar history for alice bounded to 10, dedup not needed but limited
    const calRaw = runs.open(runId)!.readArtifact("calendar-history-alice_external_co-v1.json")!;
    const cal = JSON.parse(calRaw);
    expect(cal.key).toBe("v1::alice@external.co::calendar-history");
    expect(cal.status).toBe("completed");
    expect(cal.evidence).toHaveLength(10);
    expect(cal.diagnostics.bounded).toBe(true);
    expect(cal.diagnostics.maxResults).toBe(10);
    expect(cal.diagnostics.truncated).toBe(true);
    // Bob calendar empty success
    const bobCalRaw = runs.open(runId)!.readArtifact("calendar-history-bob_gmail_com-v1.json")!;
    const bobCal = JSON.parse(bobCalRaw);
    expect(bobCal.status).toBe("empty");
    expect(bobCal.evidence).toHaveLength(0);

    // Drive: alice company domain relevant docs, deduped 2, bob empty person-level
    const driveAliceRaw = runs
      .open(runId)!
      .readArtifact("drive-alice_external_co-external_co-v1.json")!;
    const driveAlice = JSON.parse(driveAliceRaw);
    expect(driveAlice.key).toBe("v1::alice@external.co::drive-docs::external.co");
    expect(driveAlice.status).toBe("completed");
    expect(driveAlice.evidence).toHaveLength(2); // deduped
    expect(driveAlice.diagnostics.untrusted).toBe(true);

    const driveBobRaw = runs.open(runId)!.readArtifact("drive-bob_gmail_com-person-v1.json")!;
    const driveBob = JSON.parse(driveBobRaw);
    expect(driveBob.status).toBe("empty");

    // Keep guest with no Employer Match person-level — both guests remain
    const enrichRaw = runs.open(runId)!.readArtifact("enrich.json")!;
    const enrich = JSON.parse(enrichRaw);
    const sections = enrich.sections as Array<any>;
    // Should have at least gmail-exact for both, calendar, drive
    expect(
      sections.some((s: any) => s.source === "gmail-exact" && s.guest === "alice@external.co"),
    ).toBe(true);
    expect(
      sections.some((s: any) => s.source === "gmail-exact" && s.guest === "bob@gmail.com"),
    ).toBe(true);
    // No company inference for consumer: bob has no company-domain section
    expect(
      sections.some((s: any) => s.source === "gmail-company-domain" && s.guest === "bob@gmail.com"),
    ).toBe(false);
  });

  it("a persistently failed provider blocks the Brief; successful siblings and their artifacts survive", async () => {
    const failingGmail = fromPartial<FakeGmailProvider>({
      async listExactThreads(guestEmail: string, _max: number) {
        if (guestEmail.toLowerCase() === "alice@external.co")
          throw Object.assign(new Error("transient"), { status: 500 });
        return [{ id: "ok", snippet: "ok" }];
      },
      async listCompanyThreads(_domain: string, _max: number) {
        return [];
      },
    });

    const calendar = new FakeCalendarHistoryProvider();
    calendar.setPastMeetings("alice@external.co", []);
    calendar.setPastMeetings("bob@gmail.com", []);

    const drive = new FakeDriveProvider();
    drive.setDocs("fulltext contains 'external.co' or fulltext contains 'alice@external.co'", []);
    drive.setDocs("fulltext contains 'bob@gmail.com'", []);

    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      gmailDeliveryProvider: fixtureDeliver,
      completeBrief: completeFixtureBrief,
      enrichmentProviders: {
        gmailProvider: failingGmail,
        calendarHistoryProvider: calendar,
        driveProvider: drive,
        attendeeProfiles: makeAttendeeProfiles(),
        getHubSpotApi: () => stubHubSpotApi(),
        publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
      },
      getInternalDomains: () => [],
    });

    const event = fixtureEvent({
      version: "v1",
      attendees: [
        { email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" },
        {
          email: "owner@example.com",
          displayName: "Owner",
          responseStatus: "accepted",
          organizer: true,
        },
      ],
    });
    host.scheduleOccurrence(event, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    const created = await host.processDueSchedules(new Date(now));
    await host.idle();
    const runId = created[0];
    const detail = runs.detail(runId)!;
    // #137 completeness gate: a failed selected provider prevents composition and
    // delivery; the Run blocks for an automatic bounded-backoff retry, never
    // completing a partial Brief.
    expect(detail.status).toBe("blocked");
    expect(
      detail.events.some(
        (e) => e.type === "run_blocked" && e.detail?.reason === "provider_retry_backoff",
      ),
    ).toBe(true);
    expect(runs.open(runId)!.readArtifact("enrich.json")).toBeNull();
    expect(runs.open(runId)!.readArtifact("result.json")).toBeNull();
    // The versioned ledger records every selected provider independently.
    const ledger = JSON.parse(runs.open(runId)!.readArtifact("provider-outcomes.json")!);
    expect(ledger.version).toBe(1);
    expect(ledger.retryCount).toBe(1);
    const outcomes = new Map(
      (ledger.outcomes as { provider: string; attendee: string; outcome: string }[]).map((o) => [
        `${o.provider}:${o.attendee}`,
        o.outcome,
      ]),
    );
    expect(outcomes.get("gmail-relationship:alice@external.co")).toBe("failed");
    expect(outcomes.get("calendar-history:alice@external.co")).toBe("empty");
    expect(outcomes.get("drive-workspace:alice@external.co")).toBe("empty");
    expect(outcomes.get("person-profile:alice@external.co")).toBe("empty");
    // No Brief composed, so nothing was delivered to anyone.
    const gmailExactRaw = runs.open(runId)!.readArtifact("gmail-exact-alice_external_co-v1.json")!;
    const gmailExact = JSON.parse(gmailExactRaw);
    expect(gmailExact.status).toBe("failed");
    expect(gmailExact.diagnostics.attempts).toBe(2);
    expect(gmailExact.diagnostics.bounded).toBe(true);
    // The failed attendee's sibling provider artifacts survived for the retry.
    const calRaw = runs.open(runId)!.readArtifact("calendar-history-alice_external_co-v1.json")!;
    expect(JSON.parse(calRaw).status).toBe("empty");
  });

  it("provider-wide unavailability fails enrich stage", async () => {
    const gmail = new FakeGmailProvider({
      mode: "unavailable",
      unavailableError: Object.assign(new Error("Gmail API has not been used in project 123"), {
        status: 403,
        response: {
          data: {
            error: {
              message: "Gmail API has not been used in project 123",
              errors: [{ reason: "accessNotConfigured" }],
            },
          },
        },
      }),
    });
    const calendar = new FakeCalendarHistoryProvider();
    const drive = new FakeDriveProvider();

    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      gmailDeliveryProvider: fixtureDeliver,
      completeBrief: completeFixtureBrief,
      enrichmentProviders: {
        gmailProvider: gmail,
        calendarHistoryProvider: calendar,
        driveProvider: drive,
        attendeeProfiles: makeAttendeeProfiles(),
        getHubSpotApi: () => stubHubSpotApi(),
        publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
      },
    });

    const event = fixtureEvent({ version: "v1" });
    host.scheduleOccurrence(event, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    const created = await host.processDueSchedules(new Date(now));
    await host.idle();
    const runId = created[0];
    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("failed");
    expect(detail.failedStage).toBe("enrich");
  });

  it("a quoted Google ETag event version still composes valid artifact names", async () => {
    // Google Calendar returns `etag` as a quoted string, e.g. "\"3576241611505950\"".
    // Every artifact filename interpolates eventVersion, and runs.ts rejects names
    // outside /^[A-Za-z0-9][A-Za-z0-9._-]*$/ — so the quotes must be sanitized.
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      gmailDeliveryProvider: fixtureDeliver,
      completeBrief: completeFixtureBrief,
      enrichmentProviders: {
        gmailProvider: new FakeGmailProvider(),
        calendarHistoryProvider: new FakeCalendarHistoryProvider(),
        driveProvider: new FakeDriveProvider(),
        attendeeProfiles: makeAttendeeProfiles(),
        getHubSpotApi: () => stubHubSpotApi(),
        publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
      },
    });

    const event = fixtureEvent({ version: '"3576241611505950"' });
    host.scheduleOccurrence(event, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    const created = await host.processDueSchedules(new Date(now));
    await host.idle();
    const detail = runs.detail(created[0]);

    const invalidName = detail?.events.find((e) =>
      JSON.stringify(e.detail ?? {}).includes("Invalid artifact name"),
    );
    expect(invalidName).toBeUndefined();
    expect(detail?.failedStage).not.toBe("enrich");
  });

  it("same-version retry preserves completed/empty without crossing revision version", async () => {
    // First, test preservation within same Run via internal bounded retry + manual retry
    // Create a provider that fails first call for alice, then succeeds; our enrich per-source already retries boundedly, so this will succeed without manual retry.
    // For manual retry preservation, we need a provider that fails persistently for one source, causing that source to be failed, then on manual retry of the whole Run (if Run failed provider-wide) it should preserve.
    // Simulate provider-wide failure first, then fix provider and retry same Run.
    const gmailUnavail = new FakeGmailProvider({ mode: "unavailable" });
    const calendar = new FakeCalendarHistoryProvider();
    calendar.setPastMeetings("alice@external.co", [
      { id: "c1", summary: "Past", startAt: new Date().toISOString() },
    ]);
    const drive = new FakeDriveProvider();
    drive.setDocs("fulltext contains 'external.co' or fulltext contains 'alice@external.co'", [
      { id: "d1", name: "Doc", webViewLink: "https://drive/d1" },
    ]);

    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      gmailDeliveryProvider: fixtureDeliver,
      completeBrief: completeFixtureBrief,
      enrichmentProviders: {
        gmailProvider: gmailUnavail,
        calendarHistoryProvider: calendar,
        driveProvider: drive,
        attendeeProfiles: makeAttendeeProfiles(),
        getHubSpotApi: () => stubHubSpotApi(),
        publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
      },
    });

    const eventV1 = fixtureEvent({ version: "v1" });
    host.scheduleOccurrence(eventV1, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    let created = await host.processDueSchedules(new Date(now));
    await host.idle();
    const runId = created[0];
    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("failed");
    // No artifacts should be completed due to provider-wide early throw; but we can test that after fixing provider, retry preserves nothing to preserve (since none). Instead test individual failure preservation via successful Run's artifacts not crossing revision.
    // Now create revision Run with version v2: should not reuse v1 artifacts
    const gmail2 = new FakeGmailProvider();
    gmail2.setExactThreads("alice@external.co", [{ id: "new1", snippet: "New thread v2" }]);
    const host2 = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      gmailDeliveryProvider: fixtureDeliver,
      completeBrief: completeFixtureBrief,
      enrichmentProviders: {
        gmailProvider: gmail2,
        calendarHistoryProvider: calendar,
        driveProvider: drive,
        attendeeProfiles: makeAttendeeProfiles(),
        getHubSpotApi: () => stubHubSpotApi(),
        publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
      },
    });
    // Simulate revision: new event version v2 distinct occurrence to avoid dedup with failed v1 same key
    const eventV2 = fixtureEvent({
      version: "v2",
      eventId: "evt_google_2",
      occurrenceId: "2026-08-28T16:00:00Z",
    });
    host2.scheduleOccurrence(eventV2, new Date("2026-08-28T12:00:00.000Z"));
    now = new Date("2026-08-28T12:00:00.000Z");
    created = await host2.processDueSchedules(new Date(now));
    await host2.idle();
    const runId2 = created[0];
    const detail2 = runs.detail(runId2)!;
    expect(detail2.status).toBe("done");
    const v2Gmail = JSON.parse(
      runs.open(runId2)!.readArtifact("gmail-exact-alice_external_co-v2.json")!,
    );
    expect(v2Gmail.evidence[0]).toContain("New thread v2");
    // Ensure v1 artifact not copied to v2
    // v1 run may have no artifact due to failure, but v2's artifact key is different
    expect(v2Gmail.key).toBe("v2::alice@external.co::gmail-exact");
    expect(v2Gmail.eventVersion).toBe("v2");

    // Now test same-version retry preserves completed/empty: create a successful v3 run, then manually retry after making provider fail, ensure retry doesn't overwrite completed.
    const gmail3 = new FakeGmailProvider();
    gmail3.setExactThreads("alice@external.co", [{ id: "orig", snippet: "Original" }]);
    calendar.setPastMeetings("alice@external.co", []);
    drive.setDocs("fulltext contains 'external.co' or fulltext contains 'alice@external.co'", []);
    const host3 = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      gmailDeliveryProvider: fixtureDeliver,
      completeBrief: completeFixtureBrief,
      enrichmentProviders: {
        gmailProvider: gmail3,
        calendarHistoryProvider: calendar,
        driveProvider: drive,
        attendeeProfiles: makeAttendeeProfiles(),
        getHubSpotApi: () => stubHubSpotApi(),
        publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
      },
    });
    const eventV3 = fixtureEvent({
      version: "v3",
      eventId: "evt_google_3",
      occurrenceId: "2026-08-28T17:00:00Z",
    });
    host3.scheduleOccurrence(eventV3, new Date("2026-08-28T13:00:00.000Z"));
    now = new Date("2026-08-28T13:00:00.000Z");
    created = await host3.processDueSchedules(new Date(now));
    await host3.idle();
    const runId3 = created[0];
    const v3Detail = runs.detail(runId3)!;
    expect(v3Detail.status).toBe("done");
    const origGmail = JSON.parse(
      runs.open(runId3)!.readArtifact("gmail-exact-alice_external_co-v3.json")!,
    );
    expect(origGmail.status).toBe("completed");
    expect(origGmail.evidence[0]).toBe("Original");

    // Now simulate retry of same version v3 with provider now returning different data; since artifact already completed/empty, it should be preserved and not overwritten.
    // To test this, we need to make the Run fail and then retry; but our successful Run won't be retried via retryRun because it's done. We can test preservation by directly calling enrichGmailExact again with same ctx reading existing file.
    // Instead, test that second call to enrichGmailExact for same version returns preserved without calling provider.
    const countingGmail = new FakeGmailProvider();
    countingGmail.setExactThreads("alice@external.co", [
      { id: "new", snippet: "Should not be used" },
    ]);
    // Use the same Run's context by opening the run and calling enrichGmailExact with that Run's file store
    const runHandle = runs.open(runId3)!;
    const fakeCtx = {
      readFile: (name: string) => runHandle.readArtifact(name),
      writeFile: (name: string, text: string) => runHandle.writeArtifact(name, text),
      event: () => {},
    };
    const result = await (
      await import("../../../apps/server/src/modules/meeting-brief-generator/google/gmail")
    ).enrichGmailExact(countingGmail, "v3", "alice@external.co", fakeCtx);
    expect(result.artifact.evidence[0]).toBe("Original"); // preserved
    expect(countingGmail.getCallCount("exact:alice@external.co")).toBe(0); // provider not called due to preservation
  });

  it("dedup and limit enforced even when provider returns many duplicates", async () => {
    const gmail = new FakeGmailProvider();
    const manyThreads = Array.from({ length: 20 }, (_, i) => ({
      id: `dup`,
      snippet: `Thread ${i}`,
    })); // all same id
    gmail.setExactThreads("alice@external.co", manyThreads);
    const calendar = new FakeCalendarHistoryProvider();
    const drive = new FakeDriveProvider();
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      gmailDeliveryProvider: fixtureDeliver,
      completeBrief: completeFixtureBrief,
      enrichmentProviders: {
        gmailProvider: gmail,
        calendarHistoryProvider: calendar,
        driveProvider: drive,
        attendeeProfiles: makeAttendeeProfiles(),
        getHubSpotApi: () => stubHubSpotApi(),
        publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
      },
    });
    const event = fixtureEvent({
      version: "v1",
      attendees: [
        { email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" },
        {
          email: "owner@example.com",
          displayName: "Owner",
          responseStatus: "accepted",
          organizer: true,
        },
      ],
    });
    host.scheduleOccurrence(event, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    const created = await host.processDueSchedules(new Date(now));
    await host.idle();
    const runId = created[0];
    const artifact = JSON.parse(
      runs.open(runId)!.readArtifact("gmail-exact-alice_external_co-v1.json")!,
    );
    expect(artifact.evidence).toHaveLength(1); // deduped to 1
    expect(artifact.status).toBe("completed");
  });
});

describe("Google connection diagnoses without side effects", () => {
  it("classifies disabled API vs missing scope vs rejected", async () => {
    // Reuse existing google connection classification logic via verifySetup
    const { openGoogleConnection, googleSurfaceHint } =
      await import("../../../apps/server/src/google/connection");
    const { ConfigStore } = await import("../../../apps/server/src/config");
    const workspace = mkdtempSync(join(tmpdir(), "google-check-"));
    const store = new ConfigStore(join(workspace, "config.json"));
    store.load();
    store.update({
      google: {
        clientId: "id.apps",
        clientSecret: "secret",
        refreshToken: "rt",
        lastConnectedAt: new Date().toISOString(),
        hasExpiredBefore: false,
      },
    } as any);
    // Mock surfaceProbe to throw different errors for gmail-read vs calendar vs drive
    const probe = async (_cfg: any, _port: number, surface: any) => {
      if (surface === "gmail-read") {
        const err = Object.assign(new Error("Gmail API has not been used in project 999"), {
          response: {
            data: {
              error: {
                message: "Gmail API has not been used in project 999",
                errors: [{ reason: "accessNotConfigured" }],
              },
            },
          },
        });
        throw err;
      }
      if (surface === "calendar") {
        const err = Object.assign(new Error("Request had insufficient authentication scopes."), {
          response: {
            data: {
              error: {
                message: "Request had insufficient authentication scopes.",
                errors: [{ reason: "insufficientPermissions" }],
              },
            },
          },
        });
        throw err;
      }
      if (surface === "drive") {
        // success
        return;
      }
    };
    const conn = openGoogleConnection(store, 4317, {
      probe: async () => ({ email: "owner@example.com" }),
      surfaceProbe: probe as any,
    });
    const check = await conn.verifySetup();
    const gmailItem = check.items.find((i) => i.label === "Gmail history");
    expect(gmailItem?.ok).toBe(false);
    expect(gmailItem?.detail).toContain("Gmail API is not enabled");
    expect(gmailItem?.detail).toContain("project 999");
    const calItem = check.items.find((i) => i.label === "Google Calendar");
    expect(calItem?.ok).toBe(false);
    expect(calItem?.detail).toContain("calendar.readonly");
    expect(check.state).toBe("connected"); // disabled API / missing scope does not make expired, only rejected does
    // Ensure googleSurfaceHint for rejected
    const rejected = Object.assign(new Error("invalid_grant"), {
      response: { data: { error: "invalid_grant" } },
    });
    expect(googleSurfaceHint("gmail-read", rejected)).toContain("Sign in again");
  });
});
