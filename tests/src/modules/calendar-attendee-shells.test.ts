import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import type { MeetingBriefEvent, PersonProfile } from "@chief-of-staff-demo/shared";
import { PERSON_PROFILE_CALENDAR_SOURCE } from "@chief-of-staff-demo/shared";
import { StageFailure } from "../../../apps/server/src/engine/module";
import { identifier } from "../../../apps/server/src/person-profile/resolver";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import {
  PersonProfileValidationError,
  WorkspacePersonProfiles,
} from "../../../apps/server/src/person-profile/profiles";
import type { HubSpotApi } from "../../../apps/server/src/modules/meeting-brief-generator/hubspot/client";
import { FakeGmailProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/gmail";
import { FakeCalendarHistoryProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/calendarHistory";
import { FakeDriveProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/drive";
import { FakePublicIntelligenceProvider } from "../../../apps/server/src/modules/meeting-brief-generator/enrichment/publicIntelligence";
import { enrichUnified } from "../../../apps/server/src/modules/meeting-brief-generator/enrichment/enrich";

/**
 * The Calendar attendee identity path (issue #124, spec #117 creation and
 * matching policy): the exact Calendar email is an authoritative anchor, so
 * the shared Person Profiles interface reuses a non-conflicting Profile or
 * creates one idempotent minimal email-anchored shell with source provenance.
 * Conflicting stable identifiers fail visibly and never merge or overwrite.
 */
const NOW = new Date("2026-08-31T16:00:00.000Z");

function seededProfile(overrides: Partial<PersonProfile> = {}): PersonProfile {
  return {
    id: "person_existing",
    revision: 1,
    createdAt: "2026-08-30T08:00:00.000Z",
    updatedAt: "2026-08-30T08:00:00.000Z",
    fullName: "Existing Person",
    primaryEmail: "existing@example.com",
    emails: ["existing@example.com"],
    handles: {},
    profileUrls: [],
    employerHints: [],
    role: "Engineer",
    background: null,
    currentEmployer: null,
    socialProfiles: [],
    websites: [],
    feeds: [],
    publications: [],
    mentions: [],
    evidence: [],
    sourceDiagnostics: [],
    archivedAt: null,
    ...overrides,
  };
}

function shellId(email: string): string {
  return identifier({
    emails: [email.toLowerCase()],
    fullNames: [],
    handles: {},
    profileUrls: [],
    employerHints: [],
  });
}

let workspaceDir: string;
let store: PersonProfileStore;
let profiles: WorkspacePersonProfiles;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "calendar-shells-"));
  store = new PersonProfileStore(workspaceDir);
  profiles = new WorkspacePersonProfiles({ store, now: () => NOW, lifecycle: [] });
});

describe("WorkspacePersonProfiles.ensureCalendarAttendeeProfile — reuse", () => {
  it("reuses an existing Profile on a non-conflicting exact email match", () => {
    const existing = profiles.create({
      fullName: "Dana Existing",
      primaryEmail: "dana@example.com",
    });

    const result = profiles.ensureCalendarAttendeeProfile({
      email: "dana@example.com",
      provenance: "occurrence evt_1::2026-09-01T15:00:00Z version v2",
    });

    expect(result.created).toBe(false);
    expect(result.profile).toEqual(existing);
    // Reuse never rewrites the Profile: no new revision, no provenance churn.
    expect(store.get(existing.id)).toEqual(existing);
  });

  it("matches the attendee email case-insensitively", () => {
    const existing = profiles.create({
      fullName: "Dana Existing",
      primaryEmail: "dana@example.com",
    });

    const result = profiles.ensureCalendarAttendeeProfile({ email: "Dana@Example.COM" });

    expect(result.created).toBe(false);
    expect(result.profile.id).toBe(existing.id);
  });

  it("reuses a Profile whose stored email differs only in case", () => {
    store.save(seededProfile({ emails: ["Mixed@Example.com"], primaryEmail: "Mixed@Example.com" }));

    const result = profiles.ensureCalendarAttendeeProfile({ email: "mixed@example.com" });

    expect(result.created).toBe(false);
    expect(result.profile.id).toBe("person_existing");
  });
});

describe("WorkspacePersonProfiles.ensureCalendarAttendeeProfile — minimal shell", () => {
  it("creates one idempotent minimal shell anchored to the Calendar email", () => {
    const result = profiles.ensureCalendarAttendeeProfile({
      email: "new@external.co",
      provenance: "occurrence evt_1::2026-09-01T15:00:00Z version v1",
    });

    expect(result.created).toBe(true);
    const shell = result.profile;
    expect(shell.id).toBe(shellId("new@external.co"));
    expect(shell.revision).toBe(1);
    expect(shell.primaryEmail).toBe("new@external.co");
    expect(shell.emails).toEqual(["new@external.co"]);
    // Minimal: nothing but the authoritative email anchor is canonical.
    expect(shell.fullName).toBeNull();
    expect(shell.role).toBeNull();
    expect(shell.background).toBeNull();
    expect(shell.currentEmployer).toBeNull();
    expect(shell.handles).toEqual({});
    expect(shell.profileUrls).toEqual([]);
    expect(shell.employerHints).toEqual([]);
    expect(shell.socialProfiles).toEqual([]);
    expect(shell.websites).toEqual([]);
    expect(shell.feeds).toEqual([]);
    expect(shell.publications).toEqual([]);
    expect(shell.mentions).toEqual([]);
    expect(shell.evidence).toEqual([]);
    expect(shell.sourceDiagnostics).toEqual([
      {
        source: "calendar",
        status: "completed",
        detail: "Calendar attendee shell — occurrence evt_1::2026-09-01T15:00:00Z version v1",
      },
    ]);
    expect(shell.createdAt).toBe(NOW.toISOString());
    expect(store.get(shell.id)).toEqual(shell);
  });

  it("returns the same shell for a repeated event revision or sibling occurrence", () => {
    const first = profiles.ensureCalendarAttendeeProfile({
      email: "new@external.co",
      provenance: "occurrence evt_1::r1 version v1",
    });
    const revision = profiles.ensureCalendarAttendeeProfile({
      email: "new@external.co",
      provenance: "occurrence evt_1::r1 version v2",
    });
    const sibling = profiles.ensureCalendarAttendeeProfile({
      email: "new@external.co",
      provenance: "occurrence evt_1::r2 version v1",
    });

    expect(revision.created).toBe(false);
    expect(sibling.created).toBe(false);
    expect(revision.profile).toEqual(first.profile);
    expect(sibling.profile).toEqual(first.profile);
    expect(store.list()).toHaveLength(1);
  });
});

describe("WorkspacePersonProfiles.ensureCalendarAttendeeProfile — visible conflicts", () => {
  it("fails visibly when two Profiles already hold the attendee email, without merging", () => {
    const left = seededProfile({
      id: "person_left",
      emails: ["clash@example.com"],
      primaryEmail: "clash@example.com",
    });
    const right = seededProfile({
      id: "person_right",
      emails: ["clash@example.com"],
      primaryEmail: "clash@example.com",
    });
    store.save(left);
    store.save(right);

    expect(() =>
      profiles.ensureCalendarAttendeeProfile({ email: "clash@example.com" }),
    ).toThrowError(
      new PersonProfileValidationError(
        "conflicting-identity",
        "Two or more Person Profiles already hold the Calendar attendee email clash@example.com; resolve the duplicate explicitly instead of merging automatically.",
      ),
    );
    expect(store.get("person_left")).toEqual(left);
    expect(store.get("person_right")).toEqual(right);
  });

  it("fails visibly when the email-anchored id already belongs to a different Profile", () => {
    const squatter = seededProfile({
      id: shellId("carol@example.com"),
      emails: ["other@example.com"],
      primaryEmail: "other@example.com",
    });
    store.save(squatter);

    expect(() =>
      profiles.ensureCalendarAttendeeProfile({ email: "carol@example.com" }),
    ).toThrowError(
      new PersonProfileValidationError(
        "conflicting-identity",
        `The canonical id derived from the Calendar attendee email carol@example.com already belongs to Person Profile ${shellId("carol@example.com")}; resolve the conflict explicitly instead of overwriting it.`,
      ),
    );
    expect(store.get(squatter.id)).toEqual(squatter);
  });

  it("fails visibly when an archived Profile holds the attendee email", () => {
    const archived = seededProfile({ archivedAt: "2026-08-30T09:00:00.000Z" });
    store.save(archived);

    expect(() =>
      profiles.ensureCalendarAttendeeProfile({ email: "existing@example.com" }),
    ).toThrowError(
      new PersonProfileValidationError(
        "conflicting-identity",
        "An archived Person Profile holds the Calendar attendee email existing@example.com; restore or resolve it explicitly before Calendar reuses it.",
      ),
    );
    expect(store.get("person_existing")).toEqual(archived);
  });
});

describe("WorkspacePersonProfiles.ensureCalendarAttendeeProfile — input validation", () => {
  it("requires the attendee email", () => {
    expect(() => profiles.ensureCalendarAttendeeProfile({ email: "  " })).toThrowError(
      new PersonProfileValidationError(
        "missing-identity-input",
        "A Calendar attendee shell needs the attendee's email address.",
      ),
    );
  });

  it("rejects a value that is not an email address", () => {
    expect(() => profiles.ensureCalendarAttendeeProfile({ email: "not-an-email" })).toThrowError(
      new PersonProfileValidationError(
        "invalid-identity-input",
        "Not an email address: not-an-email",
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Calendar attendee identity through the Meeting Brief enrich path (issue #124)
// ---------------------------------------------------------------------------

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

function attendeeEvent(overrides: Partial<MeetingBriefEvent> = {}): MeetingBriefEvent {
  return {
    calendarId: "primary",
    eventId: "evt_shells_1",
    occurrenceId: "2026-09-01T15:00:00Z",
    version: "v1",
    summary: "Sync",
    startAt: new Date("2026-09-01T15:00:00.000Z").toISOString(),
    endAt: new Date("2026-09-01T16:00:00.000Z").toISOString(),
    organizer: { email: "owner@example.com", displayName: "Owner" },
    attendees: [
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: "accepted",
        organizer: true,
      },
      { email: "alice@external.co", displayName: "Alice External", responseStatus: "accepted" },
      { email: "carol@external.co", displayName: "Carol Declined", responseStatus: "declined" },
      { email: "room@example.com", responseStatus: "accepted", resource: true },
    ],
    status: "confirmed",
    ...overrides,
  };
}

function makeEnrichDeps() {
  return {
    providers: {
      attendeeProfiles: profiles,
      gmailProvider: new FakeGmailProvider(),
      calendarHistoryProvider: new FakeCalendarHistoryProvider(),
      driveProvider: new FakeDriveProvider(),
      getHubSpotApi: () => stubHubSpotApi(),
      publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
    },
    internalDomains: ["example.com"],
  };
}

function makeEnrichCtx() {
  const files = new Map<string, string>();
  const events: Array<{ name: string; data?: unknown }> = [];
  const ctx = {
    readFile: (name: string) => files.get(name) ?? null,
    writeFile: (name: string, value: string) => void files.set(name, value),
    event: (name: string, data?: unknown) => void events.push({ name, data }),
  };
  return {
    files,
    events,
    ctx: fromPartial<Parameters<typeof enrichUnified>[1]>(ctx),
  };
}

describe("Meeting Brief enrich routes Calendar attendee identity through Person Profiles", () => {
  it("reuses existing Profiles, shells unknown attendees, and pins id + exact revision", async () => {
    const owner = profiles.create({ fullName: "Owner", primaryEmail: "owner@example.com" });
    const event = attendeeEvent();
    const deps = makeEnrichDeps();
    const { files, events, ctx } = makeEnrichCtx();

    await enrichUnified(event, ctx, deps);

    // Every attendee except the room resource resolves to a Profile; the
    // unknown internal and external attendees received minimal shells.
    const pins = JSON.parse(files.get("attendee-profiles.json")!) as Array<{
      email: string;
      profileId: string;
      profileRevision: number;
      origin: "reused" | "shell";
    }>;
    expect(pins).toEqual([
      { email: "owner@example.com", profileId: owner.id, profileRevision: 1, origin: "reused" },
      {
        email: "alice@external.co",
        profileId: shellId("alice@external.co"),
        profileRevision: 1,
        origin: "shell",
      },
      {
        email: "carol@external.co",
        profileId: shellId("carol@external.co"),
        profileRevision: 1,
        origin: "shell",
      },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ name: "attendee_profiles_pinned", data: expect.anything() }),
    );
    // Shells are minimal: no inferred employer, title, or biography.
    for (const pin of pins.filter((p) => p.origin === "shell")) {
      const shell = profiles.get(pin.profileId)!;
      expect(shell.role).toBeNull();
      expect(shell.currentEmployer).toBeNull();
      expect(shell.background).toBeNull();
      expect(shell.fullName).toBeNull();
      expect(shell.evidence).toEqual([]);
      expect(shell.sourceDiagnostics[0]?.source).toBe(PERSON_PROFILE_CALENDAR_SOURCE);
    }
    // Meeting consumers pin the shell Profile ID and exact revision: the
    // per-attendee artifact is the pinned meeting projection.
    const aliceArtifact = JSON.parse(files.get("person-profile-alice_external_co-v1.json")!) as {
      profileId: string;
      profileRevision: number;
      purpose: string;
    };
    expect(aliceArtifact.profileId).toBe(shellId("alice@external.co"));
    expect(aliceArtifact.profileRevision).toBe(1);
    expect(aliceArtifact.purpose).toBe("meeting");
    // Attendee person-profile sections exist for reused and shell identities.
    expect(
      store
        .list()
        .map((p) => p.id)
        .sort(),
    ).toEqual([owner.id, shellId("alice@external.co"), shellId("carol@external.co")].sort());
  });

  it("event revisions and sibling occurrences create no duplicate shells", async () => {
    const deps = makeEnrichDeps();
    const revision = { ...attendeeEvent(), version: "v2" };
    const sibling = attendeeEvent({
      eventId: "evt_shells_1",
      occurrenceId: "2026-09-08T15:00:00Z",
    });
    const first = makeEnrichCtx();
    const second = makeEnrichCtx();
    const third = makeEnrichCtx();

    await enrichUnified(attendeeEvent(), first.ctx, deps);
    await enrichUnified(revision, second.ctx, deps);
    await enrichUnified(sibling, third.ctx, deps);

    const storeEmails = store
      .list()
      .map((p) => p.primaryEmail)
      .sort();
    expect(storeEmails).toEqual(["alice@external.co", "carol@external.co", "owner@example.com"]);
    const revisionPins = JSON.parse(second.files.get("attendee-profiles.json")!) as Array<{
      origin: string;
    }>;
    expect(revisionPins.every((pin) => pin.origin === "reused")).toBe(true);
  });

  it("fails visibly on conflicting stable identifiers and never merges or overwrites", async () => {
    const clashA = seededProfile({
      id: "person_clash_a",
      emails: ["alice@external.co"],
      primaryEmail: "alice@external.co",
    });
    const clashB = seededProfile({
      id: "person_clash_b",
      emails: ["alice@external.co"],
      primaryEmail: "alice@external.co",
    });
    store.save(clashA);
    store.save(clashB);
    const deps = makeEnrichDeps();
    const { files, ctx } = makeEnrichCtx();

    const error = await enrichUnified(attendeeEvent(), ctx, deps).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(StageFailure);
    expect((error as StageFailure).hint).toBe(
      "conflicting_identity: Two or more Person Profiles already hold the Calendar attendee email alice@external.co; resolve the duplicate explicitly instead of merging automatically.",
    );
    expect(store.get("person_clash_a")).toEqual(clashA);
    expect(store.get("person_clash_b")).toEqual(clashB);
    expect(files.has("attendee-profiles.json")).toBe(false);
  });

  it("an archived Profile is never newly selected as an attendee (issue://136)", async () => {
    const holder = profiles.create({
      fullName: "Alice Archived",
      primaryEmail: "alice@external.co",
    });
    profiles.archive(holder.id);
    const deps = makeEnrichDeps();
    const { files, ctx } = makeEnrichCtx();

    const error = await enrichUnified(attendeeEvent(), ctx, deps).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(StageFailure);
    expect((error as StageFailure).hint).toContain("archived_profile:");
    expect((error as StageFailure).hint).toContain(holder.id);
    // No shell was created over the archived identity and nothing was pinned.
    expect(files.has("attendee-profiles.json")).toBe(false);
    expect(profiles.get(holder.id)?.archivedAt).not.toBeNull();
  });
});

describe("a newly shelled attendee is enriched from the public web before its revision is pinned", () => {
  it("enriches only new shells, and pins the enriched revision", async () => {
    const owner = profiles.create({ fullName: "Owner", primaryEmail: "owner@example.com" });
    const searched: string[] = [];
    const deps = {
      ...makeEnrichDeps(),
      providers: {
        ...makeEnrichDeps().providers,
        resolveNewAttendee: async (email: string) => {
          searched.push(email);
          /* Stand in for the resolver: a real one saves a further revision
             over the shell it just found. */
          const shell = profiles.get(shellId(email));
          if (shell) profiles.correct(shell.id, { role: "Researcher" });
          return null;
        },
      },
    };
    const { files, events, ctx } = makeEnrichCtx();

    await enrichUnified(attendeeEvent(), ctx, deps);

    // The reused owner Profile is not searched again; both new shells are.
    expect(searched.sort()).toEqual(["alice@external.co", "carol@external.co"]);
    expect(searched).not.toContain(owner.primaryEmail);

    const pins = JSON.parse(files.get("attendee-profiles.json")!) as Array<{
      email: string;
      profileRevision: number;
      origin: string;
    }>;
    // The enriched revision is what the Brief consumes, not the bare shell.
    const alice = pins.find((pin) => pin.email === "alice@external.co")!;
    expect(alice.origin).toBe("shell");
    expect(alice.profileRevision).toBe(2);
    expect(profiles.get(shellId("alice@external.co"))?.revision).toBe(2);
    expect(events.map((entry) => entry.name)).toContain("attendee_profile_enriched");
  });

  it("leaves the shell standing when the search fails, and never fails the Brief", async () => {
    profiles.create({ fullName: "Owner", primaryEmail: "owner@example.com" });
    const deps = {
      ...makeEnrichDeps(),
      providers: {
        ...makeEnrichDeps().providers,
        resolveNewAttendee: async () => {
          throw new Error("search unreachable");
        },
      },
    };
    const { files, events, ctx } = makeEnrichCtx();

    await enrichUnified(attendeeEvent(), ctx, deps);

    const pins = JSON.parse(files.get("attendee-profiles.json")!) as Array<{
      email: string;
      profileRevision: number;
    }>;
    expect(pins.find((pin) => pin.email === "alice@external.co")?.profileRevision).toBe(1);
    const failure = events.find((entry) => entry.name === "attendee_profile_enrichment_failed");
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure?.data)).toContain("search unreachable");
  });
});
