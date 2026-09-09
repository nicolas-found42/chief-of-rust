import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerApi } from "../../../apps/server/src/api/router";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { PersonProfileResolver } from "../../../apps/server/src/person-profile/resolver";
import { OwnerOnboarding } from "../../../apps/server/src/onboarding/owner";
import { WorkspaceMeetings } from "../../../apps/server/src/meetings/store.js";
import { WorkspaceMeetingJoin } from "../../../apps/server/src/meetings/join.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { ConfigStore } from "../../../apps/server/src/config";
import { openGoogleConnection } from "../../../apps/server/src/google/connection";

const PORT = 4317;

let app: FastifyInstance;
let configStore: ConfigStore;
let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-drive-config-"));
  mkdirSync(join(workspaceDir, "runs"), { recursive: true });
  configStore = new ConfigStore(join(workspaceDir, "config.json"));
  configStore.load();

  app = fastify({ logger: false });
  const peopleStore = new PersonProfileStore(workspaceDir);
  const peopleProfiles = new WorkspacePersonProfiles({
    store: peopleStore,
    lifecycle: [],
  });
  const ownerOnboarding = new OwnerOnboarding({ people: peopleProfiles, workspaceDir });
  const meetings = new WorkspaceMeetings(workspaceDir);
  const dummyRuns = {
    list: () => [],
    detail: () => null,
    create: () => null,
    open: () => null,
  };
  await registerApi(app, {
    runs: fromAny(dummyRuns),
    port: PORT,
    configStore,
    modules: [],
    google: openGoogleConnection(configStore, PORT, {
      probe: async () => {
        throw new Error("no probe");
      },
    }),
    people: peopleProfiles,
    peopleResolver: new PersonProfileResolver({ store: peopleStore, sources: [] }),
    meetings,
    meetingJoin: new WorkspaceMeetingJoin({
      meetings,
      listTranscripts: () => [],
      attachMeeting: async () => undefined,
    }),
    onboarding: ownerOnboarding,
    /* No Content Engine or Tasks route is exercised here, so the interfaces
       behind them are never reached. */
    contentProjects: fromPartial({}),
    tasks: fromPartial({}),
    actionItems: fromPartial({}),
    taskLinking: fromPartial({}),
    asanaLinking: fromPartial({}),
    /* No mock is admitted here: these tests exercise config persistence under
       the production posture (issue #198). */
    mockProviderAvailable: false,
    onConfigChanged: () => {},
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("PUT /api/config — Drive config persistence", () => {
  it("round-trips drive.enabled, folderId, folderName, pollIntervalMinutes", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: {
        drive: {
          enabled: true,
          folderId: "abc123",
          folderName: "My Folder",
          pollIntervalMinutes: 5,
        },
      },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json();
    expect(body.config.drive).toEqual({
      enabled: true,
      folderId: "abc123",
      folderName: "My Folder",
      pollIntervalMinutes: 5,
    });

    const get = await app.inject({ method: "GET", url: "/api/config" });
    expect(get.statusCode).toBe(200);
    const fetched = get.json();
    expect(fetched.config.drive).toEqual({
      enabled: true,
      folderId: "abc123",
      folderName: "My Folder",
      pollIntervalMinutes: 5,
    });

    // Persisted on disk
    const stored = JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf8")) as {
      drive: typeof body.config.drive;
    };
    expect(stored.drive).toEqual({
      enabled: true,
      folderId: "abc123",
      folderName: "My Folder",
      pollIntervalMinutes: 5,
    });
  });

  it("redacts drive without secret hint — values returned verbatim", async () => {
    configStore.update({
      drive: { enabled: true, folderId: "fid", folderName: "Name", pollIntervalMinutes: 2 },
    });
    const get = await app.inject({ method: "GET", url: "/api/config" });
    const body = get.json();
    expect(body.config.drive.folderId).toBe("fid");
    expect(body.config.drive.folderName).toBe("Name");
    // Drive is not a secret: no { set, hint } shape
    expect(body.config.drive).not.toHaveProperty("hint");
    expect(typeof body.config.drive.folderId).toBe("string");
  });

  it("defaults drive config on fresh workspace", async () => {
    const get = await app.inject({ method: "GET", url: "/api/config" });
    const body = get.json();
    expect(body.config.drive).toEqual({
      enabled: false,
      folderId: "",
      folderName: "",
      pollIntervalMinutes: 2,
    });
  });

  it("allows updating only folderId while keeping other drive fields", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: {
        drive: { enabled: true, folderId: "first", folderName: "First", pollIntervalMinutes: 2 },
      },
    });
    const put = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { drive: { folderId: "second" } },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json();
    expect(body.config.drive.folderId).toBe("second");
    expect(body.config.drive.enabled).toBe(true);
    expect(body.config.drive.folderName).toBe("First");
  });
});

describe("PUT /api/config — invalid poll intervals", () => {
  it("rejects pollIntervalMinutes=0 with 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { drive: { pollIntervalMinutes: 0 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects negative pollIntervalMinutes", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { drive: { pollIntervalMinutes: -1 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-integer pollIntervalMinutes", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { drive: { pollIntervalMinutes: 1.5 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-numeric pollIntervalMinutes", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { drive: { pollIntervalMinutes: "two" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts pollIntervalMinutes=1 (minimum valid)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { drive: { pollIntervalMinutes: 1 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().config.drive.pollIntervalMinutes).toBe(1);
  });
});
