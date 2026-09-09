import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import type { MeetingBriefEvent } from "@chief-of-staff-demo/shared";
import { StageFailure } from "../../../apps/server/src/engine/module";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import type { HubSpotApi } from "../../../apps/server/src/modules/meeting-brief-generator/hubspot/client";
import { FakeGmailProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/gmail";
import { FakeCalendarHistoryProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/calendarHistory";
import { FakeDriveProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/drive";
import { FakePublicIntelligenceProvider } from "../../../apps/server/src/modules/meeting-brief-generator/enrichment/publicIntelligence";
import {
  MEETING_BRIEF_BUNDLES_VERSION,
  attendeeBundleFor,
} from "../../../apps/server/src/modules/meeting-brief-generator/bundles";
import { enrichUnified } from "../../../apps/server/src/modules/meeting-brief-generator/enrichment/enrich";

/**
 * Versioned provider bundle policy (issue://136, spec Implementation Decision
 * 18): internal and external attendees are enriched from different bundles,
 * classified by the configured Internal Domains.
 */
describe("Meeting Brief provider bundle policy", () => {
  it("an internal attendee selects the internal bundle v1", () => {
    const bundle = attendeeBundleFor("bob@found42.dev", ["found42.dev"]);
    expect(bundle).toEqual({
      kind: "internal",
      version: MEETING_BRIEF_BUNDLES_VERSION,
      providers: ["person-profile", "gmail-relationship", "calendar-history", "drive-workspace"],
    });
  });

  it("an external attendee selects the full external bundle v1", () => {
    const bundle = attendeeBundleFor("alice@external.co", ["found42.dev"]);
    expect(bundle).toEqual({
      kind: "external",
      version: MEETING_BRIEF_BUNDLES_VERSION,
      providers: [
        "person-profile",
        "gmail-relationship",
        "gmail-company-domain",
        "calendar-history",
        "drive-workspace",
        "crm",
        "employer-proposal",
        "public-intelligence",
      ],
    });
  });

  it("a Consumer Domain attendee remains external", () => {
    expect(attendeeBundleFor("alice@gmail.com", ["found42.dev"]).kind).toBe("external");
  });

  it("classification is case-insensitive over the domain", () => {
    expect(attendeeBundleFor("BOB@FOUND42.DEV", ["found42.dev"]).kind).toBe("internal");
    expect(attendeeBundleFor("bob@found42.dev", ["FOUND42.DEV"]).kind).toBe("internal");
  });
});

// ---------------------------------------------------------------------------
// enrichUnified drives enrichment from the selected bundle per attendee
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-01T12:00:00.000Z");

function bundleEvent(overrides: Partial<MeetingBriefEvent> = {}): MeetingBriefEvent {
  return {
    calendarId: "primary",
    eventId: "evt_bundles_1",
    occurrenceId: "2026-09-01T15:00:00Z",
    version: "v1",
    summary: "Bundle Sync",
    startAt: new Date("2026-09-01T15:00:00.000Z").toISOString(),
    endAt: new Date("2026-09-01T16:00:00.000Z").toISOString(),
    organizer: { email: "owner@found42.dev", displayName: "Owner" },
    attendees: [
      { email: "owner@found42.dev", displayName: "Owner", responseStatus: "accepted" },
      { email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" },
    ],
    status: "confirmed",
    ...overrides,
  };
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

function makeProfiles(): WorkspacePersonProfiles {
  const workspaceDir = mkdtempSync(join(tmpdir(), "bundles-"));
  return new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    now: () => NOW,
    lifecycle: [],
  });
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    providers: {
      attendeeProfiles: makeProfiles(),
      gmailProvider: new FakeGmailProvider(),
      calendarHistoryProvider: new FakeCalendarHistoryProvider(),
      driveProvider: new FakeDriveProvider(),
      getHubSpotApi: () => stubHubSpotApi(),
      publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
      ...overrides,
    },
    internalDomains: ["found42.dev"],
  };
}

function makeCtx() {
  const files = new Map<string, string>();
  const events: Array<{ name: string; data?: unknown }> = [];
  return {
    files,
    events,
    ctx: fromPartial<Parameters<typeof enrichUnified>[1]>({
      readFile: (name: string) => files.get(name) ?? null,
      writeFile: (name: string, value: string) => void files.set(name, value),
      event: (name: string, data?: unknown) => void events.push({ name, data }),
    }),
  };
}

describe("enrichUnified enriches each attendee from its bundle", () => {
  it("an internal attendee receives Workspace-owned evidence, never CRM or public intelligence", async () => {
    const deps = makeDeps();
    const { ctx } = makeCtx();
    const result = await enrichUnified(bundleEvent(), ctx, deps);

    const internalSections = result.sections.filter((s) => s.guest === "owner@found42.dev");
    const sources = new Set(internalSections.map((s) => s.source));
    // The internal bundle's Workspace-owned evidence classes are all present.
    expect(sources.has("person-profile")).toBe(true);
    expect(sources.has("gmail-exact")).toBe(true);
    expect(sources.has("calendar-history")).toBe(true);
    expect(sources.has("drive-docs")).toBe(true);
    // The external-only classes never run for an internal attendee.
    expect(sources.has("gmail-company-domain")).toBe(false);
    expect([...sources].some((s) => s.startsWith("hubspot-"))).toBe(false);
    expect(sources.has("company-news")).toBe(false);
    expect(sources.has("industry-news")).toBe(false);
    expect(sources.has("employer-match")).toBe(false);
    // The internal attendee's Profile pin is a recorded consumer link.
    expect(result.personProfileLinks).toContainEqual(
      expect.objectContaining({ guestEmail: "owner@found42.dev" }),
    );
  });

  it("an external attendee still receives the full bundle", async () => {
    const deps = makeDeps();
    const { ctx } = makeCtx();
    const result = await enrichUnified(bundleEvent(), ctx, deps);

    const externalSections = result.sections.filter((s) => s.guest === "alice@external.co");
    const sources = new Set(externalSections.map((s) => s.source));
    expect(sources.has("person-profile")).toBe(true);
    expect(sources.has("gmail-exact")).toBe(true);
    expect(sources.has("calendar-history")).toBe(true);
    expect(sources.has("drive-docs")).toBe(true);
    expect(result.personProfileLinks).toContainEqual(
      expect.objectContaining({ guestEmail: "alice@external.co" }),
    );
  });

  it("a Brief with an internal attendee composes without CRM configured", async () => {
    const deps = makeDeps({ getHubSpotApi: () => null });
    const { ctx } = makeCtx();
    const internalOnly = bundleEvent({
      attendees: [{ email: "bob@found42.dev", displayName: "Bob", responseStatus: "accepted" }],
    });
    const result = await enrichUnified(internalOnly, ctx, deps);
    expect(result.sections.length).toBeGreaterThan(0);
  });

  it("a Brief with an external attendee still fails visibly when a bundle provider is missing", async () => {
    const deps = makeDeps({ getHubSpotApi: () => null });
    const { ctx } = makeCtx();
    const error = await enrichUnified(bundleEvent(), ctx, deps).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(StageFailure);
    expect((error as StageFailure).hint).toContain("missing_configuration");
  });
});
