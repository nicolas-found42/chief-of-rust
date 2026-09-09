import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerApi, type ApiContext } from "../../../apps/server/src/api/router";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { OwnerOnboarding } from "../../../apps/server/src/onboarding/owner";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { openRuns } from "../../../apps/server/src/runs";
import { ConfigStore } from "../../../apps/server/src/config";

const PORT = 4317;

let app: FastifyInstance;
let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-artifacts-"));
  mkdirSync(join(workspaceDir, "runs"), { recursive: true });
  const configStore = new ConfigStore(join(workspaceDir, "config.json"));
  configStore.load();
  const runs = openRuns(workspaceDir);

  app = fastify({ logger: false });
  const peopleProfiles = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    lifecycle: [],
  });
  const ownerOnboarding = new OwnerOnboarding({ people: peopleProfiles, workspaceDir });
  const dummyGoogle = {
    state: async () => ({ state: "unconfigured" }),
    verifySetup: async () => ({}),
    authUrl: () => ({}),
    completeSignIn: async () => {},
    disconnect: () => {},
    pickerToken: async () => ({}),
  };
  await registerApi(
    app,
    fromPartial<ApiContext>({
      runs,
      port: PORT,
      configStore,
      modules: [],
      google: fromAny(dummyGoogle),
      people: peopleProfiles,
      onboarding: ownerOnboarding,
      onConfigChanged: () => {},
    }),
  );
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("GET /api/runs/:id/artifacts/:name", () => {
  it("returns artifact as text/plain, 404 for absent, 400 for invalid name", async () => {
    const runs = openRuns(workspaceDir);
    const handle = runs.create({
      module: "transcript",
      moduleVersion: 1,
      intake: "drive",
      fileName: "meeting.md",
      sourceUrl: null,
      externalId: null,
    });
    handle.writeArtifact("transcript.txt", "hello transcript");
    const id = handle.id;

    const hit = await app.inject({
      method: "GET",
      url: `/api/runs/${id}/artifacts/transcript.txt`,
    });
    expect(hit.statusCode).toBe(200);
    expect(hit.headers["content-type"]).toMatch(/text\/plain/);
    expect(hit.body).toBe("hello transcript");

    const missing = await app.inject({
      method: "GET",
      url: `/api/runs/${id}/artifacts/missing.txt`,
    });
    expect(missing.statusCode).toBe(404);

    const bad = await app.inject({ method: "GET", url: `/api/runs/${id}/artifacts/meta.json` });
    expect(bad.statusCode).toBe(400);

    const bad2 = await app.inject({ method: "GET", url: `/api/runs/${id}/artifacts/..%2Fevil` });
    // encoded slash becomes part of name? Fastify decodes; should be 400 due to validation (contains /)
    // If router treats as separate segment, may be 404; accept either 400 or 404 as invalid
    expect([400, 404]).toContain(bad2.statusCode);

    const noRun = await app.inject({
      method: "GET",
      url: `/api/runs/run_20260101-000000_deadbeef/artifacts/transcript.txt`,
    });
    expect(noRun.statusCode).toBe(404);
  });
});
