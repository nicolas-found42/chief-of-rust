import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { OwnerOnboarding } from "../../../apps/server/src/onboarding/owner";
import { ConfigStore } from "../../../apps/server/src/config";
import { openGoogleConnection } from "../../../apps/server/src/google/connection";
import type {
  ConfirmedOwnerReference,
  PersonProfileCreateInput,
} from "@chief-of-staff-demo/shared";

/**
 * Owner onboarding (issue #123): the preserved connected-Google identity
 * proposes the Workspace owner's canonical Profile, and only an explicit
 * confirmation pins `{profileId, profileRevision}` as the owner reference.
 * The Google identity is a fake fixture — an email string — and no provider
 * is reachable from here.
 */
let workspaceDir: string;
let store: PersonProfileStore;
let profiles: WorkspacePersonProfiles;
let onboarding: OwnerOnboarding;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-owner-onboarding-"));
  store = new PersonProfileStore(workspaceDir);
  profiles = new WorkspacePersonProfiles({ store, lifecycle: [] });
  onboarding = new OwnerOnboarding({ people: profiles, workspaceDir });
});

function createProfile(overrides: Partial<PersonProfileCreateInput> = {}) {
  return profiles.create({
    fullName: "Ada Lovelace",
    primaryEmail: "ada@example.com",
    ...overrides,
  });
}

describe("proposal", () => {
  it("proposes the Profile matching the connected identity without confirming it", () => {
    const profile = createProfile();
    onboarding.setConnectedIdentity("ada@example.com");

    expect(onboarding.proposal()).toEqual({
      googleEmail: "ada@example.com",
      matchedProfileId: profile.id,
      matchedProfileRevision: profile.revision,
    });
    expect(onboarding.confirmed()).toBeNull();
  });

  it("proposes no match when no Profile carries the connected email", () => {
    onboarding.setConnectedIdentity("nobody@example.com");
    createProfile();

    expect(onboarding.proposal()).toEqual({
      googleEmail: "nobody@example.com",
      matchedProfileId: null,
      matchedProfileRevision: null,
    });
    expect(onboarding.confirmed()).toBeNull();
  });

  it("proposes nothing while no Google identity is connected", () => {
    onboarding.setConnectedIdentity(null);

    expect(onboarding.proposal()).toBeNull();
    expect(onboarding.confirmed()).toBeNull();
  });

  it("never creates or enriches a Profile as a side effect of proposing", () => {
    onboarding.setConnectedIdentity("newperson@example.com");

    onboarding.proposal();

    expect(profiles.search()).toEqual([]);
  });
});

describe("confirm", () => {
  it("pins the exact Profile ID and revision of an existing Profile", () => {
    const profile = createProfile();
    onboarding.setConnectedIdentity("ada@example.com");

    const confirmed = onboarding.confirm(profile.id);

    expect(confirmed).toEqual({
      profileId: profile.id,
      profileRevision: profile.revision,
      confirmedAt: expect.any(String),
      confirmedForGoogleEmail: "ada@example.com",
    });
    expect(onboarding.confirmed()).toEqual(confirmed);
  });

  it("lets the owner confirm a Profile the identity does not match — a deliberate correction", () => {
    const profile = createProfile({ primaryEmail: "corrected@example.com" });
    onboarding.setConnectedIdentity("ada@example.com");

    expect(onboarding.confirm(profile.id).profileId).toBe(profile.id);
  });

  it("refuses to confirm a Profile that does not exist", () => {
    onboarding.setConnectedIdentity("ada@example.com");

    expect(() => onboarding.confirm("missing")).toThrowError(/no Person Profile/i);
    expect(onboarding.confirmed()).toBeNull();
  });

  it("refuses to confirm while no Google identity is held", () => {
    const profile = createProfile();

    expect(() => onboarding.confirm(profile.id)).toThrowError(/connect a Google identity/i);
    expect(onboarding.confirmed()).toBeNull();
  });

  it("keeps the confirmed reference pinned to the exact revision", () => {
    onboarding.setConnectedIdentity("ada@example.com");
    const profile = createProfile();
    onboarding.confirm(profile.id);

    store.save({ ...profile, revision: 2, role: "Analytical Engine programmer" });

    expect(onboarding.confirmed()).toMatchObject({
      profileId: profile.id,
      profileRevision: 1,
    });
  });
});

describe("identity change", () => {
  function confirmOwner(): ConfirmedOwnerReference {
    const profile = createProfile();
    onboarding.setConnectedIdentity("ada@example.com");
    const confirmed = onboarding.confirm(profile.id);
    expect(confirmed).not.toBeNull();
    return confirmed;
  }

  it("voids the confirmation when a different Google identity connects", () => {
    confirmOwner();

    onboarding.setConnectedIdentity("someoneelse@example.com");

    expect(onboarding.confirmed()).toBeNull();
  });

  it("voids the confirmation when the connection is disconnected", () => {
    confirmOwner();

    onboarding.setConnectedIdentity(null);

    expect(onboarding.confirmed()).toBeNull();
  });

  it("does not resurrect the confirmation by reconnecting the same account", () => {
    confirmOwner();

    onboarding.setConnectedIdentity(null);
    onboarding.setConnectedIdentity("ada@example.com");

    expect(onboarding.confirmed()).toBeNull();
  });
});

describe("durability across restart", () => {
  it("keeps the confirmed reference for the same identity after a restart", () => {
    const profile = createProfile();
    onboarding.setConnectedIdentity("ada@example.com");
    const confirmed = onboarding.confirm(profile.id);

    /* A restart is a new instance over the same Workspace, with the Shell
       re-holding the same connected identity before the first Run. */
    const restarted = new OwnerOnboarding({ people: profiles, workspaceDir });
    restarted.setConnectedIdentity("ada@example.com");

    expect(restarted.confirmed()).toEqual(confirmed);
  });

  it("keeps the invalidation durable when the identity changed before the restart", () => {
    const profile = createProfile();
    onboarding.setConnectedIdentity("ada@example.com");
    onboarding.confirm(profile.id);
    onboarding.setConnectedIdentity("someoneelse@example.com");

    const restarted = new OwnerOnboarding({ people: profiles, workspaceDir });
    restarted.setConnectedIdentity("someoneelse@example.com");

    expect(restarted.confirmed()).toBeNull();
  });

  it("invalidates a stored confirmation when restart observes a disconnected identity", () => {
    const profile = createProfile();
    onboarding.setConnectedIdentity("ada@example.com");
    onboarding.confirm(profile.id);

    const restarted = new OwnerOnboarding({ people: profiles, workspaceDir });
    restarted.setConnectedIdentity(null);
    restarted.setConnectedIdentity("ada@example.com");

    expect(restarted.confirmed()).toBeNull();
  });

  it("stores no credential material in the confirmation record", () => {
    const profile = createProfile();
    onboarding.setConnectedIdentity("ada@example.com");
    onboarding.confirm(profile.id);

    const raw = readFileSync(join(workspaceDir, "onboarding", "owner-confirmation.json"), "utf8");
    const stored = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      "confirmedAt",
      "confirmedForGoogleEmail",
      "profileId",
      "profileRevision",
    ]);
    expect(raw.toLowerCase()).not.toMatch(/token|secret|credential|refresh/);
  });

  it("preserves the persisted owner when production Google wiring is indeterminate after restart", async () => {
    const profile = createProfile();
    onboarding.setConnectedIdentity("ada@example.com");
    const confirmed = onboarding.confirm(profile.id);
    const restarted = new OwnerOnboarding({ people: profiles, workspaceDir });
    const config = new ConfigStore(join(workspaceDir, "config.json"));
    config.load();
    config.update({ google: { clientId: "client-id", clientSecret: "client-secret" } });
    config.setGoogleRefreshToken("persisted-refresh-token");
    const google = openGoogleConnection(config, 4317, {
      probe: async () => {
        throw new Error("temporary Google outage");
      },
    });

    await restarted.refreshConnectedIdentity(() => google.state());

    expect(restarted.confirmed()).toEqual(confirmed);
    expect(restarted.outwardOwnerEmail()).toBe("ada@example.com");
  });

  it("preserves the persisted owner when Google identity lookup throws during restart", async () => {
    const profile = createProfile();
    onboarding.setConnectedIdentity("ada@example.com");
    const confirmed = onboarding.confirm(profile.id);
    const restarted = new OwnerOnboarding({ people: profiles, workspaceDir });

    await restarted.refreshConnectedIdentity(async () => {
      throw new Error("temporary Google outage");
    });

    expect(restarted.confirmed()).toEqual(confirmed);
  });

  it("invalidates the persisted owner when cleared Google configuration is observed after restart", async () => {
    const profile = createProfile();
    onboarding.setConnectedIdentity("ada@example.com");
    onboarding.confirm(profile.id);
    const config = new ConfigStore(join(workspaceDir, "config.json"));
    config.load();
    config.update({ google: { clientId: "client-id", clientSecret: "client-secret" } });
    config.setGoogleRefreshToken("persisted-refresh-token");
    config.update({ google: { clientId: "", clientSecret: "" } });
    const google = openGoogleConnection(config, 4317);
    const restarted = new OwnerOnboarding({ people: profiles, workspaceDir });

    await restarted.refreshConnectedIdentity(() => google.state());

    expect(restarted.confirmed()).toBeNull();
    const afterInvalidation = new OwnerOnboarding({ people: profiles, workspaceDir });
    afterInvalidation.setConnectedIdentity("ada@example.com");
    expect(afterInvalidation.confirmed()).toBeNull();
  });

  it.each(["disconnected", "expired"] as const)(
    "invalidates the persisted owner when Google is explicitly %s",
    async (state) => {
      const profile = createProfile();
      onboarding.setConnectedIdentity("ada@example.com");
      onboarding.confirm(profile.id);
      const restarted = new OwnerOnboarding({ people: profiles, workspaceDir });

      await restarted.refreshConnectedIdentity(async () => ({ state, email: null }));

      expect(restarted.confirmed()).toBeNull();
      const afterInvalidation = new OwnerOnboarding({ people: profiles, workspaceDir });
      afterInvalidation.setConnectedIdentity("ada@example.com");
      expect(afterInvalidation.confirmed()).toBeNull();
    },
  );

  it("invalidates the persisted owner after successfully observing a different email", async () => {
    const profile = createProfile();
    onboarding.setConnectedIdentity("ada@example.com");
    onboarding.confirm(profile.id);
    const restarted = new OwnerOnboarding({ people: profiles, workspaceDir });

    await restarted.refreshConnectedIdentity(async () => ({
      state: "connected",
      email: "grace@example.com",
    }));

    expect(restarted.confirmed()).toBeNull();
    const afterInvalidation = new OwnerOnboarding({ people: profiles, workspaceDir });
    afterInvalidation.setConnectedIdentity("ada@example.com");
    expect(afterInvalidation.confirmed()).toBeNull();
  });
});

describe("outward owner gate", () => {
  it("yields the connected email only once an owner Profile is confirmed", () => {
    onboarding.setConnectedIdentity("ada@example.com");

    expect(onboarding.outwardOwnerEmail()).toBeNull();

    onboarding.confirm(createProfile().id);

    expect(onboarding.outwardOwnerEmail()).toBe("ada@example.com");
  });

  it("yields nothing again once the confirmation is stale", () => {
    onboarding.setConnectedIdentity("ada@example.com");
    onboarding.confirm(createProfile().id);
    onboarding.setConnectedIdentity("someoneelse@example.com");

    expect(onboarding.outwardOwnerEmail()).toBeNull();
  });
});
