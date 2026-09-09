import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunMeta } from "@chief-of-staff-demo/shared";
import { registerApi, type ApiContext } from "../../../apps/server/src/api/router";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { OwnerOnboarding } from "../../../apps/server/src/onboarding/owner";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { ConfigStore } from "../../../apps/server/src/config";
import type { HostedModule } from "../../../apps/server/src/engine/host";
import { openRuns, type Runs } from "../../../apps/server/src/runs";

/**
 * The API holds a collection of Modules, not one of each thing. What that has
 * to buy is exactly this: two Modules' Runs and endpoints coexist, and every
 * route finds the Module from the Run rather than assuming which one it is.
 */
const PORT = 4317;

let app: FastifyInstance;
let workspaceDir: string;
let runs: Runs;
let retried: string[];

function fakeHost(id: string, path: string): HostedModule {
  return {
    id,
    version: 1,
    async retryRun(runId: string): Promise<RunMeta> {
      retried.push(`${id}:${runId}`);
      return runs.open(runId)!.reopen("only", "fake_host_selected_only_stage");
    },
    routes(instance) {
      instance.get(path, async () => ({ mine: id }));
    },
  };
}

function failedRun(module: string): string {
  const handle = runs.create({
    module,
    moduleVersion: 1,
    intake: "manual",
    sourceUrl: null,
    externalId: null,
  });
  handle.started("only");
  handle.failed("only", "boom", "It broke.");
  return handle.id;
}

beforeEach(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-modules-"));
  mkdirSync(join(workspaceDir, "runs"), { recursive: true });
  runs = openRuns(workspaceDir);
  retried = [];
  const configStore = new ConfigStore(join(workspaceDir, "config.json"));
  configStore.load();

  app = fastify({ logger: false });
  const peopleProfiles = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    lifecycle: [],
  });
  const ownerOnboarding = new OwnerOnboarding({ people: peopleProfiles, workspaceDir });
  await registerApi(
    app,
    fromPartial<ApiContext>({
      runs,
      port: PORT,
      configStore,
      modules: [fakeHost("alpha", "/api/alpha/thing"), fakeHost("beta", "/api/beta/thing")],
      google: { state: async () => ({ state: "unconfigured" }) },
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

describe("two Modules under one Shell", () => {
  it("retries a Run through the Module that made it", async () => {
    const alpha = failedRun("alpha");
    const beta = failedRun("beta");

    const first = await app.inject({ method: "POST", url: `/api/runs/${beta}/retry` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ status: "pending" });

    const second = await app.inject({ method: "POST", url: `/api/runs/${alpha}/retry` });
    expect(second.statusCode).toBe(200);

    expect(retried).toEqual([`beta:${beta}`, `alpha:${alpha}`]);
  });

  it("mounts each Module's own endpoints", async () => {
    expect((await app.inject({ method: "GET", url: "/api/alpha/thing" })).json()).toEqual({
      mine: "alpha",
    });
    expect((await app.inject({ method: "GET", url: "/api/beta/thing" })).json()).toEqual({
      mine: "beta",
    });
  });

  it("refuses to retry a Run whose Module this Shell does not host", async () => {
    /* History does not vanish when a Module is removed, but nobody is left who
       knows what re-running its Run would mean. */
    const orphan = failedRun("gamma");
    const response = await app.inject({ method: "POST", url: `/api/runs/${orphan}/retry` });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: `Run is not retryable because its Module gamma is not hosted: ${orphan}`,
    });
    expect(runs.detail(orphan)!.events.at(-1)).toMatchObject({
      type: "retry_refused",
      detail: { condition: "module_not_hosted", module: "gamma" },
    });
    expect(retried).toEqual([]);
  });

  it("still answers 404 for a Run that is not there", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/runs/run_20260101-000000_deadbeef/retry",
    });
    expect(response.statusCode).toBe(404);
  });
});
