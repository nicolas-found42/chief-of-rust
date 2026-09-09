import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../../apps/server/src/config";
import { HubSpotConnection } from "../../../apps/server/src/modules/meeting-brief-generator/hubspot/connection";
import { enrichGuestWithHubSpot } from "../../../apps/server/src/modules/meeting-brief-generator/hubspot/enrichment";
import type { HubSpotApi } from "../../../apps/server/src/modules/meeting-brief-generator/hubspot/client";
import type { HubSpotCompany, HubSpotContact, HubSpotDeal } from "@chief-of-staff-demo/shared";
import { openRuns, type Runs } from "../../../apps/server/src/runs";
import { MeetingBriefHost } from "../../../apps/server/src/modules/meeting-brief-generator/host";
import type { MeetingBriefEvent } from "@chief-of-staff-demo/shared";
import {
  createMeetingBriefTestRuntime,
  fixtureGmailDeliveryProvider,
} from "../../../apps/server/src/modules/meeting-brief-generator/testRuntime";

function fixtureEvent(overrides: Partial<MeetingBriefEvent> = {}): MeetingBriefEvent {
  return {
    calendarId: "primary",
    eventId: "evt_hubspot_1",
    occurrenceId: "2026-08-28T15:00:00Z",
    version: "v1",
    summary: "External sync",
    startAt: "2026-08-28T15:00:00.000Z",
    endAt: "2026-08-28T15:30:00.000Z",
    attendees: [
      { email: "alice@external.co", displayName: "Alice External", responseStatus: "accepted" },
      { email: "bob@gmail.com", displayName: "Bob Consumer", responseStatus: "accepted" },
    ],
    ...overrides,
    status: overrides.status ?? "confirmed",
  };
}

function fakeHubSpotApi(overrides: Partial<HubSpotApi> = {}): HubSpotApi {
  const base: HubSpotApi = {
    async listContacts(limit: number) {
      void limit;
      return { results: [] };
    },
    async searchContactByEmail(email: string) {
      void email;
      return null;
    },
    async getAssociatedCompanyIds(contactId: string) {
      void contactId;
      return [];
    },
    async getCompany(companyId: string) {
      void companyId;
      return null;
    },
    async getAssociatedDealIds(contactId: string) {
      void contactId;
      return [];
    },
    async getAssociatedDealIdsForCompany(companyId: string) {
      void companyId;
      return [];
    },
    async getDeal(dealId: string) {
      void dealId;
      return null;
    },
  };
  return { ...base, ...overrides };
}

function hubSpotError(status: number, category?: string, message?: string) {
  const error = new Error(message ?? `HubSpot ${status}`) as Error & {
    status?: number;
    category?: string;
  };
  error.status = status;
  if (category) error.category = category;
  return error;
}

function seedHubSpotToken(configStore: ConfigStore, token: string): void {
  const current = configStore.get().modules["meeting-brief-generator"];
  configStore.setModuleConfig("meeting-brief-generator", {
    ...current,
    hubspot: { token, lastVerifiedAt: null },
  });
}

describe("HubSpot connection — per-user private-app token, redacted, no shared credential", () => {
  let workspaceDir: string;
  let configStore: ConfigStore;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "hubspot-conn-"));
    configStore = new ConfigStore(join(workspaceDir, "config.json"));
    configStore.load();
  });

  it("starts unconfigured with empty hint", () => {
    const conn = new HubSpotConnection(configStore);
    const status = conn.status();
    expect(status.state).toBe("unconfigured");
    expect(status.tokenHint).toBe("");
    expect(status.lastVerifiedAt).toBeNull();
  });

  it("stores per-user token via Shell and exposes only redacted hint", async () => {
    const conn = new HubSpotConnection(
      configStore,
      () => ({ probe: async () => undefined }),
      () => new Date("2026-08-28T10:00:00.000Z"),
    );
    const token = "pat-na1-abcdef1234567890";
    const status = await conn.connect(token);
    expect(status.state).toBe("connected");
    expect(status.tokenHint).toBe("…7890");
    expect(status.lastVerifiedAt).toBe("2026-08-28T10:00:00.000Z");
    // Never leaks full token via status
    const raw = JSON.stringify(status);
    expect(raw).not.toContain(token);
    expect(raw).toContain("…7890");
    // Stored via ConfigStore, not shared env var
    const stored = configStore.get().modules["meeting-brief-generator"].hubspot.token;
    expect(stored).toBe(token);
    expect(process.env.HUBSPOT_TOKEN).toBeUndefined();
    expect(process.env.HUBSPOT_PRIVATE_APP_TOKEN).toBeUndefined();
  });

  it("redacts token in status after connect — never returns raw token", async () => {
    const conn = new HubSpotConnection(configStore, () => ({ probe: async () => undefined }));
    await conn.connect("pat-na1-secret-token-xyz");
    const status = conn.status();
    expect(status.tokenHint).toBe("…-xyz");
    // Simulate status route payload
    const payload = JSON.stringify(status);
    expect(payload).not.toContain("secret-token");
  });

  it("disconnect clears token and returns unconfigured", async () => {
    const conn = new HubSpotConnection(configStore, () => ({ probe: async () => undefined }));
    await conn.connect("pat-na1-abc123");
    expect(conn.status().state).not.toBe("unconfigured");
    const after = conn.disconnect();
    expect(after.state).toBe("unconfigured");
    expect(after.tokenHint).toBe("");
    expect(configStore.get().modules["meeting-brief-generator"].hubspot.token).toBe("");
  });

  it("never uses a shared Found42 credential — token comes only from ConfigStore", async () => {
    // Even if env var were set, connection ignores it
    process.env.HUBSPOT_TOKEN = "shared-found42-token";
    const conn = new HubSpotConnection(configStore, () => ({ probe: async () => undefined }));
    // No token stored => unconfigured, not shared
    expect(conn.status().state).toBe("unconfigured");
    expect(() => conn.api()).toThrow("Connect your HubSpot");
    delete process.env.HUBSPOT_TOKEN;
  });
});

describe("HubSpot setup probe — bounded read-only, 5 states, no side effect", () => {
  let workspaceDir: string;
  let configStore: ConfigStore;
  const now = () => new Date("2026-08-28T10:00:00.000Z");

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "hubspot-probe-"));
    configStore = new ConfigStore(join(workspaceDir, "config.json"));
    configStore.load();
  });

  it("distinguishes missing_configuration when no token", async () => {
    const conn = new HubSpotConnection(configStore, undefined, now);
    const result = await conn.verifySetup();
    expect(result.state).toBe("missing_configuration");
    expect(result.detail).toMatch(/not configured/i);
    expect(result.items).toHaveLength(0);
  });

  it("distinguishes rejected when HubSpot returns 401", async () => {
    seedHubSpotToken(configStore, "pat-na1-bad-token");
    const conn = new HubSpotConnection(
      configStore,
      () => ({
        probe: async () => {
          throw hubSpotError(401, "INVALID_AUTHENTICATION", "Authentication credentials not found");
        },
      }),
      now,
    );
    const result = await conn.verifySetup();
    expect(result.state).toBe("rejected");
    expect(result.detail).toMatch(/rejected/i);
    expect(result.items[0]?.ok).toBe(false);
  });

  it("distinguishes missing_authority when 403 MISSING_SCOPES", async () => {
    seedHubSpotToken(configStore, "pat-na1-no-scopes");
    const conn = new HubSpotConnection(
      configStore,
      () => ({
        probe: async () => {
          throw hubSpotError(
            403,
            "MISSING_SCOPES",
            "This app hasn't been granted all required scopes",
          );
        },
      }),
      now,
    );
    const result = await conn.verifySetup();
    expect(result.state).toBe("missing_authority");
    expect(result.detail).toMatch(/missing.*scope/i);
  });

  it("distinguishes unavailable on 500 and network error", async () => {
    seedHubSpotToken(configStore, "pat-na1-unavailable");
    const conn500 = new HubSpotConnection(
      configStore,
      () => ({
        probe: async () => {
          throw hubSpotError(500, undefined, "Internal Server Error");
        },
      }),
      now,
    );
    const r500 = await conn500.verifySetup();
    expect(r500.state).toBe("unavailable");

    const connNetwork = new HubSpotConnection(
      configStore,
      () => ({
        probe: async () => {
          throw new TypeError("fetch failed: network unavailable");
        },
      }),
      now,
    );
    const rNet = await connNetwork.verifySetup();
    expect(rNet.state).toBe("unavailable");
  });

  it("reports healthy on success — healthy empty data is still healthy", async () => {
    seedHubSpotToken(configStore, "pat-na1-good-token");
    const conn = new HubSpotConnection(
      configStore,
      () => ({
        probe: async () => undefined, // 200 with empty results is healthy
      }),
      now,
    );
    const result = await conn.verifySetup();
    expect(result.state).toBe("healthy");
    expect(result.items[0]?.ok).toBe(true);
    // Probe leaves no side effect except lastVerifiedAt — token unchanged, no contacts created
    expect(configStore.get().modules["meeting-brief-generator"].hubspot.token).toBe(
      "pat-na1-good-token",
    );
    expect(configStore.get().modules["meeting-brief-generator"].hubspot.lastVerifiedAt).toBe(
      now().toISOString(),
    );
  });

  it("probe is bounded (limit 1) and read-only — does not create side effects", async () => {
    seedHubSpotToken(configStore, "pat-na1-good-token");
    const probe = vi.fn(async () => undefined);
    const conn = new HubSpotConnection(configStore, () => ({ probe }), now);
    await conn.verifySetup();
    expect(probe).toHaveBeenCalledTimes(1);
    // Verify that underlying client would have used limit 1 — we assert probe was called, not that it mutated state
    const stored = configStore.get().modules["meeting-brief-generator"].hubspot;
    expect(stored.token).toBe("pat-na1-good-token");
  });
});

describe("HubSpot enrichment — exact-email + bounded company/deal, artifacts stable", () => {
  it("propagates a contact-level integration outage instead of degrading it to a guest gap", async () => {
    const api = fakeHubSpotApi({
      async searchContactByEmail() {
        throw hubSpotError(503, "UNAVAILABLE", "HubSpot unavailable");
      },
    });

    await expect(enrichGuestWithHubSpot(api, "v1", "alice@external.co")).rejects.toMatchObject({
      status: 503,
    });
  });

  it("propagates a provider-wide outage discovered after the contact lookup succeeds", async () => {
    const api = fakeHubSpotApi({
      async searchContactByEmail(email) {
        return {
          id: "contact-1",
          email,
          properties: { email },
          associatedCompanyIds: [],
          associatedDealIds: [],
        };
      },
      async getAssociatedCompanyIds() {
        throw hubSpotError(503, "UNAVAILABLE", "HubSpot company associations unavailable");
      },
    });

    await expect(enrichGuestWithHubSpot(api, "v1", "alice@external.co")).rejects.toMatchObject({
      status: 503,
    });
  });

  it("contact+company+deal fixture creates completed artifacts with stable refs and employer match", async () => {
    const contact: HubSpotContact = {
      id: "101",
      email: "alice@external.co",
      properties: { email: "alice@external.co", firstname: "Alice" },
      associatedCompanyIds: ["201"],
      associatedDealIds: ["301"],
    };
    const company: HubSpotCompany = {
      id: "201",
      name: "External Co",
      domain: "external.co",
      properties: { name: "External Co", domain: "external.co" },
    };
    const deal: HubSpotDeal = {
      id: "301",
      name: "Big Deal",
      amount: "50000",
      stage: "appointmentscheduled",
      properties: { dealname: "Big Deal", amount: "50000" },
    };
    const api = fakeHubSpotApi({
      async searchContactByEmail(email) {
        expect(email).toBe("alice@external.co"); // exact-email, lowercased
        return contact;
      },
      async getAssociatedCompanyIds(contactId) {
        expect(contactId).toBe("101");
        return ["201"];
      },
      async getCompany(companyId) {
        expect(companyId).toBe("201");
        return company;
      },
      async getAssociatedDealIds(contactId) {
        expect(contactId).toBe("101");
        return ["301"];
      },
      async getAssociatedDealIdsForCompany(companyId) {
        void companyId;
        return [];
      },
      async getDeal(dealId) {
        expect(dealId).toBe("301");
        return deal;
      },
    });

    const { artifacts, sections, employerMatch } = await enrichGuestWithHubSpot(
      api,
      "v1",
      "Alice@External.Co",
    );
    // Normalized email lowercased in artifacts
    expect(artifacts.some((a) => a.source === "hubspot-contact" && a.status === "completed")).toBe(
      true,
    );
    expect(artifacts.some((a) => a.source === "hubspot-company" && a.status === "completed")).toBe(
      true,
    );
    expect(artifacts.some((a) => a.source === "hubspot-deal" && a.status === "completed")).toBe(
      true,
    );
    expect(sections.some((s) => s.source === "hubspot-contact" && s.status === "completed")).toBe(
      true,
    );
    // Employer match is direct company association
    expect(employerMatch).not.toBeNull();
    expect(employerMatch?.name).toBe("External Co");
    expect(employerMatch?.id).toBe("201");
    // Stable refs keyed by eventVersion + guest + source
    const contactArtifact = artifacts.find((a) => a.source === "hubspot-contact")!;
    expect(contactArtifact.key).toBe("v1::alice@external.co::hubspot-contact");
    expect(contactArtifact.stableRef).toBe("v1::alice@external.co::hubspot-contact");
    const companyArtifact = artifacts.find(
      (a) => a.source === "hubspot-company" && a.companyId === "201",
    )!;
    expect(companyArtifact.key).toBe("v1::alice@external.co::hubspot-company::201");
    expect(companyArtifact.isEmployerMatch).toBe(true);
    expect(companyArtifact.diagnostics.employerMatch).toBe(true);
    // No inference from domain alone — domain not used to create company
    // Artifact evidence contains company name
    expect(companyArtifact.evidence[0]).toContain("External Co");
  });

  it("missing contact returns empty artifacts, keeps guest, no employer match", async () => {
    const api = fakeHubSpotApi({
      async searchContactByEmail() {
        return null;
      },
    });
    const { artifacts, sections, employerMatch } = await enrichGuestWithHubSpot(
      api,
      "v2",
      "missing@external.co",
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.status).toBe("empty");
    expect(artifacts[0]?.source).toBe("hubspot-contact");
    expect(sections[0]?.status).toBe("empty");
    expect(employerMatch).toBeNull();
    // No employer match inferred from domain
    expect(artifacts[0]?.diagnostics.reason).toBe("no_exact_email_match");
  });

  it("redacted status never leaks token — enrichment uses token internally but artifacts do not contain it", async () => {
    const contact: HubSpotContact = {
      id: "101",
      email: "alice@external.co",
      properties: { email: "alice@external.co" },
      associatedCompanyIds: [],
      associatedDealIds: [],
    };
    const api = fakeHubSpotApi({
      async searchContactByEmail() {
        return contact;
      },
    });
    // Simulate token that would be used to create api — ensure artifacts don't contain it
    const token = "pat-na1-super-secret-token-xyz123";
    void token; // token is used to create api in real code, not passed to enrichment
    const { artifacts } = await enrichGuestWithHubSpot(api, "v1", "alice@external.co");
    const serialized = JSON.stringify(artifacts);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("pat-na1");
  });

  it("empty empty success — contact found but no company/deal yields empty company/deal artifacts, still healthy", async () => {
    const contact: HubSpotContact = {
      id: "101",
      email: "alice@external.co",
      properties: { email: "alice@external.co" },
      associatedCompanyIds: [],
      associatedDealIds: [],
    };
    const api = fakeHubSpotApi({
      async searchContactByEmail() {
        return contact;
      },
      async getAssociatedCompanyIds() {
        return [];
      },
      async getAssociatedDealIds() {
        return [];
      },
    });
    const { artifacts, sections } = await enrichGuestWithHubSpot(api, "v1", "alice@external.co");
    expect(artifacts.find((a) => a.source === "hubspot-contact")?.status).toBe("completed");
    expect(artifacts.find((a) => a.source === "hubspot-company")?.status).toBe("empty");
    expect(artifacts.find((a) => a.source === "hubspot-deal")?.status).toBe("empty");
    expect(sections.find((s) => s.source === "hubspot-company")?.status).toBe("empty");
    expect(sections.find((s) => s.source === "hubspot-deal")?.status).toBe("empty");
  });

  it("failed retry handling stays per-source — one company fetch failure does not remove guest", async () => {
    const contact: HubSpotContact = {
      id: "101",
      email: "alice@external.co",
      properties: { email: "alice@external.co" },
      associatedCompanyIds: ["201", "202"],
      associatedDealIds: [],
    };
    const api = fakeHubSpotApi({
      async searchContactByEmail() {
        return contact;
      },
      async getAssociatedCompanyIds() {
        return ["201", "202"];
      },
      async getCompany(companyId) {
        if (companyId === "201") throw hubSpotError(500, undefined, "Internal error");
        return {
          id: "202",
          name: "Second Co",
          domain: "second.co",
          properties: { name: "Second Co" },
        };
      },
      async getAssociatedDealIds() {
        return [];
      },
    });
    const { artifacts, sections } = await enrichGuestWithHubSpot(api, "v1", "alice@external.co");
    const failed = artifacts.find((a) => a.companyId === "201");
    const completed = artifacts.find((a) => a.companyId === "202");
    expect(failed?.status).toBe("failed");
    expect(completed?.status).toBe("completed");
    expect(sections.some((s) => s.status === "failed")).toBe(true);
    expect(sections.some((s) => s.status === "completed")).toBe(true);
    // Guest still kept — contact artifact completed
    expect(artifacts.find((a) => a.source === "hubspot-contact")?.status).toBe("completed");
  });

  it("bounded to max 10 companies and deals", async () => {
    const contact: HubSpotContact = {
      id: "101",
      email: "alice@external.co",
      properties: { email: "alice@external.co" },
      associatedCompanyIds: Array.from({ length: 15 }, (_, i) => `c${i}`),
      associatedDealIds: Array.from({ length: 15 }, (_, i) => `d${i}`),
    };
    const api = fakeHubSpotApi({
      async searchContactByEmail() {
        return contact;
      },
      async getAssociatedCompanyIds() {
        // Return 15, enrichment should slice to 10
        return Array.from({ length: 15 }, (_, i) => `c${i}`);
      },
      async getCompany(companyId) {
        return {
          id: companyId,
          name: `Company ${companyId}`,
          domain: `${companyId}.co`,
          properties: { name: `Company ${companyId}` },
        };
      },
      async getAssociatedDealIds() {
        return Array.from({ length: 15 }, (_, i) => `d${i}`);
      },
      async getDeal(dealId) {
        return {
          id: dealId,
          name: `Deal ${dealId}`,
          amount: "1000",
          stage: "qualified",
          properties: { dealname: `Deal ${dealId}` },
        };
      },
      async getAssociatedDealIdsForCompany() {
        return [];
      },
    });
    const { artifacts } = await enrichGuestWithHubSpot(api, "v1", "alice@external.co");
    const companyArtifacts = artifacts.filter((a) => a.source === "hubspot-company" && a.companyId);
    const dealArtifacts = artifacts.filter((a) => a.source === "hubspot-deal" && a.dealId);
    expect(companyArtifacts.length).toBe(10);
    expect(dealArtifacts.length).toBe(10);
    for (const a of [...companyArtifacts, ...dealArtifacts]) {
      expect(a.diagnostics.bounded).toBe(true);
      expect(a.diagnostics.maxResults).toBe(10);
    }
  });

  it("names and domains alone are not employer match — only direct association is", async () => {
    // No contact, so email domain external.co and name Alice External should not create employer match
    const api = fakeHubSpotApi({
      async searchContactByEmail() {
        return null;
      },
    });
    const { employerMatch } = await enrichGuestWithHubSpot(api, "v1", "alice@external.co");
    expect(employerMatch).toBeNull();

    // Even if we have a contact with no company association, domain should not be inferred
    const contact: HubSpotContact = {
      id: "101",
      email: "alice@external.co",
      properties: { email: "alice@external.co" },
      associatedCompanyIds: [],
      associatedDealIds: [],
    };
    const api2 = fakeHubSpotApi({
      async searchContactByEmail() {
        return contact;
      },
      async getAssociatedCompanyIds() {
        return [];
      },
    });
    const result2 = await enrichGuestWithHubSpot(api2, "v1", "alice@external.co");
    expect(result2.employerMatch).toBeNull();
    expect(result2.artifacts.find((a) => a.source === "hubspot-company")?.status).toBe("empty");
  });

  it("stable refs are deterministic across calls", async () => {
    const contact: HubSpotContact = {
      id: "101",
      email: "alice@external.co",
      properties: { email: "alice@external.co" },
      associatedCompanyIds: ["201"],
      associatedDealIds: [],
    };
    const api = fakeHubSpotApi({
      async searchContactByEmail() {
        return contact;
      },
      async getAssociatedCompanyIds() {
        return ["201"];
      },
      async getCompany() {
        return { id: "201", name: "External Co", domain: "external.co", properties: {} };
      },
      async getAssociatedDealIds() {
        return [];
      },
    });
    const first = await enrichGuestWithHubSpot(api, "v1", "alice@external.co");
    const second = await enrichGuestWithHubSpot(api, "v1", "alice@external.co");
    expect(first.artifacts.map((a) => a.stableRef)).toEqual(
      second.artifacts.map((a) => a.stableRef),
    );
    expect(first.artifacts.map((a) => a.key)).toEqual(second.artifacts.map((a) => a.key));
    // Different version yields different stable ref
    const third = await enrichGuestWithHubSpot(api, "v2", "alice@external.co");
    expect(third.artifacts[0]?.stableRef).not.toBe(first.artifacts[0]?.stableRef);
    // Case-insensitive email lowercased
    const fourth = await enrichGuestWithHubSpot(api, "v1", "Alice@External.Co");
    expect(fourth.artifacts[0]?.stableRef).toBe(first.artifacts[0]?.stableRef);
  });
});

describe("Host seam — real Runs/Runner/durableClock/Workspace + fake HubSpot", () => {
  let workspaceDir: string;
  let runs: Runs;
  let now: Date;
  let host: MeetingBriefHost;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "mbf-hubspot-"));
    runs = openRuns(workspaceDir);
    now = new Date("2026-08-28T09:00:00.000Z");
  });

  it("enrichment via host seam writes stable HubSpot artifacts and preserves guest on empty", async () => {
    const contact: HubSpotContact = {
      id: "101",
      email: "alice@external.co",
      properties: { email: "alice@external.co" },
      associatedCompanyIds: ["201"],
      associatedDealIds: ["301"],
    };
    const company: HubSpotCompany = {
      id: "201",
      name: "External Co",
      domain: "external.co",
      properties: { name: "External Co" },
    };
    const deal: HubSpotDeal = {
      id: "301",
      name: "Deal One",
      amount: "25000",
      stage: "closedwon",
      properties: { dealname: "Deal One" },
    };
    const fakeApi = fakeHubSpotApi({
      async searchContactByEmail(email) {
        if (email === "alice@external.co") return contact;
        return null; // bob@gmail.com -> no contact
      },
      async getAssociatedCompanyIds(contactId) {
        if (contactId === "101") return ["201"];
        return [];
      },
      async getCompany(companyId) {
        if (companyId === "201") return company;
        return null;
      },
      async getAssociatedDealIds(contactId) {
        if (contactId === "101") return ["301"];
        return [];
      },
      async getAssociatedDealIdsForCompany() {
        return [];
      },
      async getDeal(dealId) {
        if (dealId === "301") return deal;
        return null;
      },
    });

    host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      enrich: async (input, ctx) => {
        const guests = input.attendees.filter((a) => !a.resource).map((a) => a.email);
        const allArtifacts: unknown[] = [];
        const allSections: unknown[] = [];
        for (const email of guests) {
          const result = await enrichGuestWithHubSpot(fakeApi, input.version, email, ctx);
          allArtifacts.push(...result.artifacts);
          allSections.push(...result.sections);
        }
        // Also add generic Gmail artifact to show composite
        allSections.push({
          source: "gmail",
          guest: "alice@external.co",
          status: "completed",
          evidence: ["gmail thread"],
          references: ["https://mail.example.com/1"],
        });
        return { sections: allSections, evidence: [] };
      },
      completeBrief: async (input) => ({
        version: 1,
        eventId: input.eventId,
        occurrenceId: input.occurrenceId,
        eventVersion: input.version,
        generatedAt: new Date(now).toISOString(),
        logistics: {
          title: input.summary,
          startAt: input.startAt,
          endAt: input.endAt,
          location: input.location ?? null,
          conferenceLink: input.conferenceLink ?? null,
          organizer: input.organizer
            ? input.organizer.displayName !== undefined
              ? { email: input.organizer.email, displayName: input.organizer.displayName }
              : { email: input.organizer.email }
            : null,
        },
        summary: `Brief for ${input.summary}`,
        guests: input.attendees
          .filter((a) => !a.resource)
          .map((a) => ({
            email: a.email,
            name: a.displayName ?? null,
            role: a.email === "alice@external.co" ? "CTO" : null,
            background: null,
            relationshipHistory: [],
            crmContext:
              a.email === "alice@external.co" ? "HubSpot: External Co — Deal One $25000" : null,
            talkingPoints: [],
            uncertainty: [],
            evidenceReferences: ["https://app.hubspot.com/companies/201"],
          })),
        companies: [
          {
            name: "External Co",
            domain: "external.co",
            hubspotContext: "Company External Co with deal Deal One",
            docs: [],
            news: [],
            industry: [],
            uncertainty: [],
            evidenceReferences: ["https://app.hubspot.com/companies/201"],
          },
        ],
        conversationStarters: ["starter 1", "starter 2"],
        sourceReferences: ["https://app.hubspot.com/companies/201"],
        missingEvidence: [],
        uncertainty: [],
      }),
      gmailDeliveryProvider: fixtureGmailDeliveryProvider("msg-123"),
    });

    const event = fixtureEvent({ version: "v1" });
    const dueAt = new Date("2026-08-28T11:00:00.000Z");
    host.scheduleOccurrence(event, dueAt);
    now = new Date("2026-08-28T11:00:00.000Z");
    const created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(1);
    await host.idle();

    const runId = created[0];
    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("done");
    // Artifacts should include hubspot ones per guest
    expect(
      detail.files.some((f) => f.includes("hubspot-v1-alice_external_co-hubspot-contact")),
    ).toBe(true);
    expect(
      detail.files.some((f) => f.includes("hubspot-v1-alice_external_co-hubspot-company")),
    ).toBe(true);
    expect(detail.files.some((f) => f.includes("hubspot-v1-alice_external_co-hubspot-deal"))).toBe(
      true,
    );
    // bob@gmail.com had no contact -> empty artifact still present, guest kept
    expect(detail.files.some((f) => f.includes("bob_gmail_com"))).toBe(true);
    const enrichRaw = runs.open(runId)!.readArtifact("enrich.json")!;
    const enrich = JSON.parse(enrichRaw) as {
      sections: Array<{ source: string; status: string; guest?: string }>;
    };
    expect(
      enrich.sections.some(
        (s) =>
          s.source === "hubspot-contact" &&
          s.guest === "alice@external.co" &&
          s.status === "completed",
      ),
    ).toBe(true);
    expect(
      enrich.sections.some(
        (s) =>
          s.source === "hubspot-contact" && s.guest === "bob@gmail.com" && s.status === "empty",
      ),
    ).toBe(true);
    // Employer match is direct company, not inferred
    const hubspotContactArtifactRaw = runs
      .open(runId)!
      .readArtifact("hubspot-v1-alice_external_co-hubspot-contact.json")!;
    expect(hubspotContactArtifactRaw).toBeTruthy();
    const hubspotCompanyRaw = runs
      .open(runId)!
      .readArtifact("hubspot-v1-alice_external_co-hubspot-company-201.json")!;
    const companyArtifact = JSON.parse(hubspotCompanyRaw) as {
      isEmployerMatch: boolean;
      stableRef: string;
    };
    expect(companyArtifact.isEmployerMatch).toBe(true);
    expect(companyArtifact.stableRef).toBe("v1::alice@external.co::hubspot-company::201");
  });
});

describe("HubSpot probe seam — hermetic under the test runtime, real HubSpot without it", () => {
  let workspaceDir: string;
  let configStore: ConfigStore;
  let runs: Runs;
  const now = () => new Date("2026-08-28T10:00:00.000Z");

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "hubspot-seam-"));
    configStore = new ConfigStore(join(workspaceDir, "config.json"));
    configStore.load();
    runs = openRuns(workspaceDir);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the test runtime's connection answers offline — the journey reaches HubSpot never", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("hermetic runtime must not reach the network");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const runtime = createMeetingBriefTestRuntime({
      runs,
      workspaceDir,
      configStore,
      initialNow: now(),
    });
    const status = await runtime.hubSpotConnection.connect("pat-na1-fake-journey-token");
    expect(status.state).toBe("connected");
    const check = await runtime.hubSpotConnection.verifySetup();
    expect(check.state).toBe("healthy");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("without that seam the default probe calls HubSpot — bounded contacts GET, bearer token", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const conn = new HubSpotConnection(configStore, undefined, now);
    const status = await conn.connect("pat-na1-production-token");
    expect(status.state).toBe("connected");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("https://api.hubapi.com/crm/v3/objects/contacts");
    expect(url).toContain("limit=1");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer pat-na1-production-token",
    );
  });

  it("without that seam a rejected token fails the real probe — nothing stored, fixture prefix is not special", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ category: "INVALID_AUTHENTICATION", message: "bad token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const conn = new HubSpotConnection(configStore, undefined, now);
    await expect(conn.connect("pat-na1-fake-journey-token")).rejects.toThrow(/bad token/i);
    expect(configStore.get().modules["meeting-brief-generator"].hubspot.token).toBe("");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
