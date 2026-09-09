import { mkdirSync, mkdtempSync } from "node:fs";
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

/**
 * Model-provider onboarding (issue #198): what a fresh customer configuration
 * recommends, how the BYO key crosses the credential boundary, and where the
 * mock provider may exist at all. The seam is the assembled config API over a
 * real temporary Workspace.
 */

const PORT = 4317;

let app: FastifyInstance;
let configStore: ConfigStore;
let workspaceDir: string;

async function buildApp(mockProviderAvailable: boolean): Promise<void> {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-model-provider-"));
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
    onConfigChanged: () => {},
    /* The mock posture is the composition's decision; these routes only
       enforce it, so the tests decide it here the same way the Shell does. */
    mockProviderAvailable,
  });
  await app.ready();
}

beforeEach(async () => {
  await buildApp(false);
});

afterEach(async () => {
  await app.close();
});

describe("GET /api/config — the fresh customer recommendation", () => {
  it("recommends OpenRouter and prefills the GLM 5.3 Flash model on a fresh Workspace", async () => {
    const get = await app.inject({ method: "GET", url: "/api/config" });
    expect(get.statusCode).toBe(200);
    const body = get.json<{ config: { provider: string; model: string } }>();
    expect(body.config.provider).toBe("openrouter");
    expect(body.config.model).toBe("z-ai/glm-5.3-flash");
  });
});

describe("the BYO key across the credential boundary", () => {
  it("persists independent purpose models without duplicating or exposing the provider key", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: {
        apiKey: "private-openrouter-key",
        models: {
          openrouter: {
            personResearch: "research-model",
            evaluationJudge: "judge-model",
          },
        },
      },
    });
    expect(put.statusCode).toBe(200);
    const patch = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: {
        models: { openrouter: { evaluationJudge: "independent-judge" } },
      },
    });
    expect(patch.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/api/config" });
    expect(get.json().config).toMatchObject({
      models: {
        openrouter: {
          personResearch: "research-model",
          evaluationJudge: "independent-judge",
        },
      },
    });
    expect(get.body).not.toContain("private-openrouter-key");
    const restarted = new ConfigStore(join(workspaceDir, "config.json"));
    expect(restarted.load()).toMatchObject({
      models: {
        openrouter: {
          personResearch: "research-model",
          evaluationJudge: "independent-judge",
        },
      },
    });
    expect(restarted.getForPurpose("personResearch").model).toBe("research-model");
    expect(restarted.getForPurpose("evaluationJudge").model).toBe("independent-judge");
    expect(restarted.getForPurpose("meetingBrief").model).toBe("z-ai/glm-5.3-flash");
    restarted.update({ provider: "anthropic", model: "another-provider-model" });
    expect(restarted.getForPurpose("evaluationJudge").model).toBe("another-provider-model");
  });

  it("stores the key through the config store and never echoes it back", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: {
        provider: "openrouter",
        model: "inception/mercury-2.5-preview",
        apiKey: "sk-or-v1-abc123def4567890",
      },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({ method: "GET", url: "/api/config" });
    expect(get.statusCode).toBe(200);
    const body = get.json<Record<string, unknown>>();
    expect(body.config).toMatchObject({ apiKey: { set: true, hint: "…7890" } });
    /* The whole payload — defaults included — is swept, not just the key field:
       the criterion is that the key appears nowhere in what the UI receives. */
    expect(JSON.stringify(body)).not.toContain("sk-or-v1-abc123def4567890");
  });
});

describe("the mock provider's door", () => {
  it("announces whether mock exists at all, and this server composes without it", async () => {
    const get = await app.inject({ method: "GET", url: "/api/config" });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ mockAvailable: boolean }>().mockAvailable).toBe(false);
  });

  it("refuses to configure mock outside tests and explicit demo mode", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { provider: "mock", model: "" },
    });
    expect(put.statusCode).toBe(400);
    expect(put.json<{ error: string }>().error).toBe("mock-provider-unavailable");
    /* Refused, not stored: the Workspace keeps the provider it had. */
    const get = await app.inject({ method: "GET", url: "/api/config" });
    expect(get.json<{ config: { provider: string } }>().config.provider).toBe("openrouter");
  });

  it("lets a workspace that already runs mock keep saving under it", async () => {
    /* The gate keeps mock out of production; it does not strand a workspace
       that carries mock from an earlier test or demo run — the Settings card
       and Home show that state plainly (issue #198). */
    configStore.update({ provider: "mock", model: "" });
    const put = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { provider: "mock", tasklistName: "Renamed" },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json<{ config: { provider: string; tasklistName: string } }>();
    expect(body.config.provider).toBe("mock");
    expect(body.config.tasklistName).toBe("Renamed");
  });

  it("still admits mock where it belongs — a test or demo composition", async () => {
    await app.close();
    await buildApp(true);

    const put = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { provider: "mock", model: "" },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json<{ mockAvailable: boolean; config: { provider: string } }>();
    expect(body.mockAvailable).toBe(true);
    expect(body.config.provider).toBe("mock");
  });
});
