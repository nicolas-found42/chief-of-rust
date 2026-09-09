import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerOnboardingApi } from "../../../apps/server/src/api/onboarding";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { OwnerOnboarding } from "../../../apps/server/src/onboarding/owner";

/**
 * The onboarding product namespace (issue #123): the owner reads the
 * proposal and confirms the canonical owner Profile over a real server on a
 * temporary Workspace. The Google identity is a fake fixture — an email
 * string — and no provider is reachable here.
 */
let app: FastifyInstance;
let workspaceDir: string;
let profiles: WorkspacePersonProfiles;
let onboarding: OwnerOnboarding;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-onboarding-routes-"));
  profiles = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    lifecycle: [],
  });
  onboarding = new OwnerOnboarding({ people: profiles, workspaceDir });
  app = fastify();
  registerOnboardingApi(app, { onboarding });
  return app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("GET /api/onboarding/owner", () => {
  it("reports no identity, proposal, or confirmation while disconnected", async () => {
    const response = await app.inject({ method: "GET", url: "/api/onboarding/owner" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      proposal: null,
      confirmed: null,
    });
  });

  it("reports the proposal without a confirmation once the identity is held", async () => {
    const profile = profiles.create({
      fullName: "Ada Lovelace",
      primaryEmail: "ada@example.com",
    });
    onboarding.setConnectedIdentity("ada@example.com");

    const response = await app.inject({ method: "GET", url: "/api/onboarding/owner" });

    expect(response.json()).toEqual({
      proposal: {
        googleEmail: "ada@example.com",
        matchedProfileId: profile.id,
        matchedProfileRevision: profile.revision,
      },
      confirmed: null,
    });
  });

  it("reports the confirmed reference after confirmation", async () => {
    const profile = profiles.create({
      fullName: "Ada Lovelace",
      primaryEmail: "ada@example.com",
    });
    onboarding.setConnectedIdentity("ada@example.com");
    onboarding.confirm(profile.id);

    const response = await app.inject({ method: "GET", url: "/api/onboarding/owner" });

    expect(response.json().confirmed).toMatchObject({
      profileId: profile.id,
      profileRevision: profile.revision,
      confirmedForGoogleEmail: "ada@example.com",
    });
  });
});

describe("POST /api/onboarding/owner/confirm", () => {
  beforeEach(() => {
    onboarding.setConnectedIdentity("ada@example.com");
  });

  it("confirms an existing Profile and returns the pinned reference", async () => {
    const profile = profiles.create({
      fullName: "Ada Lovelace",
      primaryEmail: "ada@example.com",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/owner/confirm",
      payload: { profileId: profile.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      profileId: profile.id,
      profileRevision: profile.revision,
    });
    expect(onboarding.confirmed()).toMatchObject({ profileId: profile.id });
  });

  it("classifies an unknown Profile as 404", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/owner/confirm",
      payload: { profileId: "missing" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "unknown-profile" });
  });

  it("classifies a body without a profileId as 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/owner/confirm",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid-request" });
  });

  it("classifies confirming without a connected identity as 409", async () => {
    onboarding.setConnectedIdentity(null);
    const profile = profiles.create({ primaryEmail: "ada@example.com" });

    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/owner/confirm",
      payload: { profileId: profile.id },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "no-connected-identity" });
  });
});
