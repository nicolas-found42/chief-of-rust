import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunMeta, RunPage } from "@chief-of-staff-demo/shared";
import { registerApi, type ApiContext } from "../../../apps/server/src/api/router";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { OwnerOnboarding } from "../../../apps/server/src/onboarding/owner";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { ConfigStore } from "../../../apps/server/src/config";
import { openRuns } from "../../../apps/server/src/runs";

/**
 * The Runs list as an HTTP contract: one endpoint with a Module filter, a page
 * size and a cursor. Runs are written straight to the workspace with chosen ids
 * so the order under test is the order asserted — a run id carries its own
 * timestamp to the second, and Runs made in the same second by the same test
 * would order by their random tail.
 */
const PORT = 4317;

let app: FastifyInstance;
let workspaceDir: string;
let people: WorkspacePersonProfiles;

function seedRun(id: string, meta: Partial<RunMeta>): void {
  const dir = join(workspaceDir, "runs", id);
  mkdirSync(dir, { recursive: true });
  const full: RunMeta = {
    id,
    createdAt: `2026-01-0${id.slice(11, 12)}T00:00:00.000Z`,
    module: "transcript",
    moduleVersion: 1,
    intake: "drive",
    sourceUrl: null,
    externalId: null,
    status: "done",
    attempts: 1,
    failedStage: null,
    skipReason: null,
    failureHint: null,
    summary: null,
    ...meta,
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(full, null, 2), "utf8");
}

/** `run_2026010N-000000_0000000N`, so the ids sort in the order they are named. */
function idFor(day: number): string {
  return `run_2026010${day}-000000_0000000${day}`;
}

async function list(query = ""): Promise<RunPage> {
  const response = await app.inject({ method: "GET", url: `/api/runs${query}` });
  expect(response.statusCode).toBe(200);
  return response.json();
}

beforeEach(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-runs-list-"));
  mkdirSync(join(workspaceDir, "runs"), { recursive: true });
  const configStore = new ConfigStore(join(workspaceDir, "config.json"));
  configStore.load();

  app = fastify({ logger: false });
  people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    lifecycle: [],
  });
  const ownerOnboarding = new OwnerOnboarding({ people, workspaceDir });
  await registerApi(
    app,
    fromPartial<ApiContext>({
      runs: openRuns(workspaceDir),
      port: PORT,
      configStore,
      modules: [],
      google: { state: async () => ({ state: "unconfigured" }) },
      people,
      onboarding: ownerOnboarding,
      onConfigChanged: () => {},
    }),
  );
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("GET /api/runs", () => {
  it("lists every Module's Runs, newest first, and names the Module on each", async () => {
    seedRun(idFor(1), { module: "transcript", summary: "2 tasks, 1 draft" });
    seedRun(idFor(2), { module: "youtube-trends", summary: "3 channels, 214 videos" });
    seedRun(idFor(3), { module: "transcript", summary: "Nothing created" });

    const page = await list();
    expect(page.runs.map((run) => [run.module, run.summary])).toEqual([
      ["transcript", "Nothing created"],
      ["youtube-trends", "3 channels, 214 videos"],
      ["transcript", "2 tasks, 1 draft"],
    ]);
  });

  it("returns only one Module's Runs when asked, so a Module's page cannot show another's", async () => {
    seedRun(idFor(1), { module: "transcript" });
    seedRun(idFor(2), { module: "youtube-trends" });
    seedRun(idFor(3), { module: "youtube-trends" });

    const mine = await list("?module=youtube-trends");
    expect(mine.runs.map((run) => run.id)).toEqual([idFor(3), idFor(2)]);

    const theirs = await list("?module=transcript");
    expect(theirs.runs.map((run) => run.id)).toEqual([idFor(1)]);
  });

  it("renders the line the Module wrote, and computes none of its own", async () => {
    /* A done Run whose Module wrote nothing says nothing: the Shell has no
       fallback to derive, because it does not read inside a result. */
    seedRun(idFor(1), { summary: null });
    seedRun(idFor(2), { summary: "2 tasks, 1 draft" });

    const page = await list();
    expect(page.runs.map((run) => run.summary)).toEqual(["2 tasks, 1 draft", null]);
    /* And nothing about a Module's result reaches the row. */
    expect(Object.keys(page.runs[0])).not.toContain("taskCount");
    expect(Object.keys(page.runs[0])).not.toContain("result");
  });

  it("pages newest-first, and a cursor walks backwards without repeating or skipping", async () => {
    for (const day of [1, 2, 3, 4, 5]) {
      seedRun(idFor(day), {});
    }

    const first = await list("?limit=2");
    expect(first.runs.map((run) => run.id)).toEqual([idFor(5), idFor(4)]);
    expect(first.nextCursor).toBe(idFor(4));

    const second = await list(`?limit=2&cursor=${first.nextCursor}`);
    expect(second.runs.map((run) => run.id)).toEqual([idFor(3), idFor(2)]);

    const third = await list(`?limit=2&cursor=${second.nextCursor}`);
    expect(third.runs.map((run) => run.id)).toEqual([idFor(1)]);
    expect(third.nextCursor).toBeNull();
  });

  it("lists a Run whose Module this Shell no longer hosts", async () => {
    /* History does not silently vanish when a Module is removed: the row keeps
       its raw identifier, which the web app renders when no label claims it. */
    seedRun(idFor(1), { module: "long-gone" });
    const page = await list();
    expect(page.runs.map((run) => run.module)).toEqual(["long-gone"]);
  });
});

describe("GET /api/runs/:id opaque result", () => {
  it("returns a Meeting Brief result without interpreting its Person Profile links", async () => {
    const profile = people.create({ fullName: "Grace Hopper", role: "Rear Admiral" });
    const runId = idFor(1);
    seedRun(runId, { module: "meeting-brief-generator" });
    writeFileSync(
      join(workspaceDir, "runs", runId, "result.json"),
      JSON.stringify({
        version: 1,
        personProfileLinks: [
          {
            guestEmail: "grace@example.com",
            profileId: profile.id,
            profileRevision: 1,
          },
        ],
      }),
      "utf8",
    );
    people.correct(profile.id, { role: "Professor of Computer Science" });

    const response = await app.inject({ url: `/api/runs/${runId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.personProfileLinks[0]).toEqual({
      guestEmail: "grace@example.com",
      profileId: profile.id,
      profileRevision: 1,
    });
  });
});
