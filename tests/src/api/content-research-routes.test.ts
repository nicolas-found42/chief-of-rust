import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NamedPerson } from "@chief-of-staff-demo/shared";
import { ContentResearchHost } from "../../../apps/server/src/modules/content-research/host";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { openRuns } from "../../../apps/server/src/runs";

/**
 * The Module's own endpoints, over a real server instance and a temporary
 * Workspace. What matters here is that a watchlist the operator can add to is
 * also one they can take someone off — a Named Person added by mistake was
 * otherwise only removable by editing Workspace JSON by hand — and that every
 * watch route is gated on a confirmed Profile id (#134).
 */
let app: FastifyInstance;
let host: ContentResearchHost;
let people: WorkspacePersonProfiles;
let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-content-research-routes-"));
  const now = () => new Date("2026-08-30T08:00:00.000Z");
  people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    lifecycle: [],
    now,
  });
  /* No Run executes here, so the collaborators a Run would reach are never
     called — only the watchlist routes are under test. */
  host = new ContentResearchHost(
    fromPartial({
      runs: openRuns(workspaceDir),
      workspaceDir,
      adapters: [],
      profileProjection: (profileId: string) => people.project("public-safe", profileId),
      discoverFeeds: async () => [],
      now,
      log: () => {},
    }),
  );
  app = fastify();
  host.routes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function watchedNames(): Promise<string[]> {
  const response = await app.inject({ method: "GET", url: "/api/content-research/people" });
  return response.json<NamedPerson[]>().map((person) => person.name);
}

async function watchAda(): Promise<NamedPerson> {
  const profile = people.create({
    fullName: "Ada Lovelace",
    primaryEmail: "ada@example.com",
  });
  const added = await app.inject({
    method: "POST",
    url: "/api/content-research/people",
    payload: { profileId: profile.id },
  });
  expect(added.statusCode).toBe(200);
  return added.json<NamedPerson>();
}

describe("Content Research people routes", () => {
  it("stops watching a Named Person, and leaves the rest of the watchlist alone", async () => {
    const added = await watchAda();
    const graceProfile = people.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
    });
    await app.inject({
      method: "POST",
      url: "/api/content-research/people",
      payload: { profileId: graceProfile.id },
    });
    expect(await watchedNames()).toEqual(["Ada Lovelace", "Grace Hopper"]);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/content-research/people/${added.id}`,
    });

    expect(removed.statusCode).toBe(200);
    expect(await watchedNames()).toEqual(["Grace Hopper"]);
  });

  it("reports an unknown Named Person rather than reporting a removal that did not happen", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/content-research/people/person_does_not_exist",
    });

    expect(response.statusCode).toBe(404);
  });

  it("refuses to watch a bare name, or a Profile that is not active (#134)", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/api/content-research/people",
      payload: { name: "Ada Lovelace" },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: "profile-required" });

    const unknown = await app.inject({
      method: "POST",
      url: "/api/content-research/people",
      payload: { profileId: "person_does_not_exist" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: "profile-not-found" });

    /* An archived Profile is not an active one. */
    const profile = people.create({ fullName: "Ada Lovelace", primaryEmail: "ada@example.com" });
    people.archive(profile.id);
    const archived = await app.inject({
      method: "POST",
      url: "/api/content-research/people",
      payload: { profileId: profile.id },
    });
    expect(archived.statusCode).toBe(404);
    expect(await watchedNames()).toEqual([]);
  });

  it("pauses and resumes a watch over the routes, and refuses to resume a watch whose Profile is gone", async () => {
    const person = await watchAda();

    const paused = await app.inject({
      method: "POST",
      url: `/api/content-research/people/${person.id}/pause`,
    });
    expect(paused.statusCode).toBe(200);
    expect(await watchedNames()).toEqual([]);

    const resumed = await app.inject({
      method: "POST",
      url: `/api/content-research/people/${person.id}/resume`,
    });
    expect(resumed.statusCode).toBe(200);
    expect(await watchedNames()).toEqual(["Ada Lovelace"]);

    people.archive(person.profileId);
    const refused = await app.inject({
      method: "POST",
      url: `/api/content-research/people/${person.id}/resume`,
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toMatchObject({ error: "profile-not-found" });
  });

  it("refuses a suggestion approval that names no Profile, before touching the suggestion", async () => {
    const refused = await app.inject({
      method: "POST",
      url: "/api/content-research/discovery/suggestion_x/approve",
      payload: {},
    });
    /* The Profile gate fires before the suggestion is even resolved. */
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: "profile-required" });
  });
});
