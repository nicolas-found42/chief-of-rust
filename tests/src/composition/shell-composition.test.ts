import type { PersonProfile } from "@chief-of-staff-demo/shared";
import { openRuns } from "../../../apps/server/src/runs";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSource } from "../source-ast.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeShell, type Shell } from "../../../apps/server/src/composition/shell";

/**
 * The composition root, composed for real — the gap behind three defects.
 *
 * The Transcript Catalog (#125) passed a full suite while production
 * constructed it nowhere: every spec built the Catalog itself, so passing was
 * compatible with the app never touching it. #144 was the same shape one level
 * down — the runs directory and the V1 watchlist were created on the boot path
 * but not by the in-process cutover the gate performs, so a Workspace migrated
 * without a restart came up missing both. Neither was reachable from a test,
 * because `main.ts` was a top-level-await script that bound a port: importing it
 * was starting the server, and the only wiring a test could examine was its
 * source text.
 *
 * `composeShell` is that script as a function. It builds the whole graph and
 * registers every route without listening, so a Shell composes over a temporary
 * Workspace in about a tenth of a second and answers through `app.inject`. Every
 * assertion below is on what the composition did, not on what it looks like.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SERVER_SRC = join(REPO_ROOT, "apps/server/src");

/* The address docker-compose declares. The Shell seeds relay.json from it on a
   Workspace with none stored, which is a startup write like any other — and the
   one that was still happening outside the boot sequence. */
const DEPLOYMENT_RELAY_BASE_URL = "http://relay:4318";

const shells: Shell[] = [];
let priorRelayBaseUrl: string | undefined;

beforeEach(() => {
  /* Set for the whole test, not just the compose: the boot sequence reads it
     when it runs, which is the point — a deployment variable that only takes
     effect at startup is one the gate has to be able to withhold. */
  priorRelayBaseUrl = process.env.RELAY_BASE_URL;
  process.env.RELAY_BASE_URL = DEPLOYMENT_RELAY_BASE_URL;
});

afterEach(() => {
  /* Started Modules hold schedulers. Nothing here may outlive its own test. */
  while (shells.length > 0) shells.pop()?.stop();
  if (priorRelayBaseUrl === undefined) delete process.env.RELAY_BASE_URL;
  else process.env.RELAY_BASE_URL = priorRelayBaseUrl;
});

async function compose(workspaceDir: string): Promise<Shell> {
  const shell = await composeShell({ workspaceDir, port: 4999 });
  shells.push(shell);
  return shell;
}

/**
 * A Workspace with product state and no migration marker, so the gate holds it.
 * The Content Scout clock is parked just short of its due times for the same
 * reason the browser suite parks it: a scheduler tick that fired mid-test would
 * write a Run, and these assertions are about what startup writes.
 */
function workspaceDirectory(migrated: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "cos-shell-"));
  writeFileSync(
    join(dir, "config.json"),
    `${JSON.stringify(
      {
        provider: "mock",
        model: "",
        apiKey: "",
        google: { clientId: "", clientSecret: "", refreshToken: null },
        drive: { enabled: false, folderId: "", folderName: "", pollIntervalMinutes: 2 },
        ollama: { baseUrl: "http://127.0.0.1:11434" },
        modules: {
          "content-research": {
            dailyTime: "23:59",
            weeklyDiscoveryDay: 7,
            weeklyDiscoveryTime: "23:59",
          },
          "content-scout": {
            dailyTime: "23:59",
            weeklyDiscoveryDay: 7,
            weeklyDiscoveryTime: "23:59",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (migrated) {
    mkdirSync(join(dir, "migration"), { recursive: true });
    writeFileSync(
      join(dir, "migration", "completed.json"),
      `${JSON.stringify({ migratedAt: "2026-08-31T12:00:00.000Z" })}\n`,
      "utf8",
    );
  }
  return dir;
}

/** Relative paths, sorted. */
function paths(dir: string, base = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(`${rel}/`, ...paths(dir, rel));
    else found.push(rel);
  }
  return found.sort();
}

/** Relative path plus content hash, sorted — the Workspace's bytes. */
function snapshot(dir: string): string[] {
  return paths(dir)
    .map((rel) =>
      rel.endsWith("/")
        ? rel
        : `${rel} ${createHash("sha256")
            .update(readFileSync(join(dir, rel)))
            .digest("hex")}`,
    )
    .sort();
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}
describe("the mock provider follows the process posture, not the config (#198)", () => {
  /* Both switches the posture reads are pinned, so an operator's exported
     DEMO_MODE cannot flip these assertions. */
  async function withPosture(
    posture: { test?: "1"; demo?: "1" },
    run: () => Promise<void>,
  ): Promise<void> {
    const prior = { test: process.env.ENABLE_TEST_SEED, demo: process.env.DEMO_MODE };
    delete process.env.ENABLE_TEST_SEED;
    delete process.env.DEMO_MODE;
    if (posture.test !== undefined) process.env.ENABLE_TEST_SEED = posture.test;
    if (posture.demo !== undefined) process.env.DEMO_MODE = posture.demo;
    try {
      await run();
    } finally {
      if (prior.test === undefined) delete process.env.ENABLE_TEST_SEED;
      else process.env.ENABLE_TEST_SEED = prior.test;
      if (prior.demo === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = prior.demo;
    }
  }

  it("keeps mock out of a production-composed Shell", async () => {
    await withPosture({}, async () => {
      const shell = await compose(workspaceDirectory(true));
      const get = await shell.app.inject({ method: "GET", url: "/api/config" });
      expect(get.json<{ mockAvailable: boolean }>().mockAvailable).toBe(false);
    });
  });

  it("admits mock where the process runs as a test", async () => {
    await withPosture({ test: "1" }, async () => {
      const shell = await compose(workspaceDirectory(true));
      const get = await shell.app.inject({ method: "GET", url: "/api/config" });
      expect(get.json<{ mockAvailable: boolean }>().mockAvailable).toBe(true);
    });
  });

  it("admits mock where the process itself declares an explicit demo", async () => {
    await withPosture({ demo: "1" }, async () => {
      const shell = await compose(workspaceDirectory(true));
      const get = await shell.app.inject({ method: "GET", url: "/api/config" });
      expect(get.json<{ mockAvailable: boolean }>().mockAvailable).toBe(true);
    });
  });
});

describe("composition writes nothing while the gate holds a pre-cutover Workspace (#144)", () => {
  it("leaves the Workspace byte-for-byte unchanged, under the deployment's own environment", async () => {
    const dir = workspaceDirectory(false);
    const before = snapshot(dir);

    const shell = await compose(dir);

    expect(shell.gate.isActive()).toBe(true);
    expect(
      snapshot(dir),
      "composing a gated Shell must not touch the Workspace the person has not yet agreed to reset",
    ).toEqual(before);
  });

  it("holds historical receipts with Google disabled and preserves every byte until exact cutover", async () => {
    const dir = workspaceDirectory(true);
    const run = openRuns(dir).create({
      module: "meeting-debrief",
      moduleVersion: 1,
      intake: "transcript",
      sourceUrl: null,
      externalId: null,
    });
    run.writeArtifact(
      "result.json",
      JSON.stringify({
        transcriptId: "historical",
        debrief: {
          actionItems: [
            {
              title: "Historical commitment",
              owner: null,
              ownerProfileId: null,
              ownerMentionId: null,
              dueDate: null,
            },
          ],
        },
      }),
    );
    run.writeArtifact(
      "tasks.json",
      JSON.stringify({
        tasks: [{ index: 0, taskId: "remote-existing", taskListId: "historical-list" }],
      }),
    );
    const before = snapshot(dir);
    const shell = await compose(dir);
    expect(shell.gate.isActive()).toBe(true);
    const response = await shell.app.inject({ method: "GET", url: "/api/migration/inventory" });
    expect(response.statusCode).toBe(200);
    expect(response.json().counts).toMatchObject({ receipts: 1, tasks: 1, actionItems: 1 });
    expect(snapshot(dir)).toEqual(before);
    expect((await shell.app.inject({ method: "GET", url: "/api/tasks" })).statusCode).toBe(503);
  });

  it("holds the product API and answers the migration surface", async () => {
    const shell = await compose(workspaceDirectory(false));

    const runs = await shell.app.inject({ method: "GET", url: "/api/runs" });
    expect(runs.statusCode).toBe(503);
    const status = await shell.app.inject({ method: "GET", url: "/api/migration/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json<{ state: string }>().state).toBe("required");
  });
});

describe("the in-process cutover reaches the Workspace a restart would (#144)", () => {
  it("creates exactly what the boot sequence creates", async () => {
    /* The defect this reproduces: the runs directory, the V1 watchlist and the
       relay address were written on the boot path but not by the gate's own
       cutover, so confirming without a restart left a Workspace short of all
       three. Both sides run the same startup — one through the gate, one
       through boot — and the comparison is what each newly created. */
    const cutoverDir = workspaceDirectory(false);
    const cutoverBefore = paths(cutoverDir);
    const cutover = await compose(cutoverDir);
    expect(cutover.gate.isActive()).toBe(true);
    cutover.gate.complete();
    await waitFor(() => paths(cutoverDir).includes("runs/"), "the cutover to start the Modules");

    const bootDir = workspaceDirectory(true);
    const bootBefore = paths(bootDir);
    const boot = await compose(bootDir);
    expect(boot.gate.isActive()).toBe(false);
    await boot.start();

    /* The runs directory is compared, its contents are not: what a started
       engine enqueues is scheduler timing, and this is about what the startup
       sequence creates. Everything else — the V1 watchlist, the Profile it
       writes, the seeded relay address — is compared exactly. */
    const created = (after: string[], before: string[]) =>
      after.filter((path) => !before.includes(path) && !path.startsWith("runs/run"));
    const byBoot = created(paths(bootDir), bootBefore);

    /* Non-vacuous, and named rather than counted: these three are the writes
       that actually went missing. */
    expect(byBoot).toContain("runs/");
    expect(byBoot).toContain("relay.json");
    expect(byBoot.some((p) => p.startsWith("content-research/"))).toBe(true);

    expect(
      created(paths(cutoverDir), cutoverBefore),
      "a Workspace migrated in-process must hold what one migrated by restart holds",
    ).toEqual(byBoot);
  });
});

/**
 * Every exported `…Store`: the classes that own a piece of durable Workspace
 * state. Read from the source tree rather than listed here, because a list is
 * another hand-written fixture and drifts the way `CONFIG_KEYS` drifted — a
 * store added tomorrow joins this expectation by existing.
 */
function declaredStores(dir = SERVER_SRC, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      declaredStores(path, found);
      continue;
    }
    if (!path.endsWith(".ts")) continue;
    const source = parseSource(path);
    for (const statement of source.body) {
      if (
        statement.type !== "ExportNamedDeclaration" &&
        statement.type !== "ExportDefaultDeclaration"
      )
        continue;
      const declaration = statement.declaration;
      if (declaration?.type === "ClassDeclaration" && declaration.id?.name.endsWith("Store")) {
        found.push(declaration.id.name);
      }
    }
  }
  return found.sort();
}

/** Constructor names of every object the given roots actually hold. */
function heldClasses(roots: unknown): Set<string> {
  const names = new Set<string>();
  const visited = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || typeof value !== "object" || value === null) return;
    if (visited.has(value)) return;
    visited.add(value);
    names.add(value.constructor.name);
    for (const key of Object.keys(value)) {
      visit((value as Record<string, unknown>)[key], depth + 1);
    }
  };
  visit(roots, 0);
  return names;
}

/**
 * Opened per call over `relay.json` and held by nobody — the relay's state is
 * the file, and every reader constructs a reader for the one operation. There is
 * nothing on the graph to find, and nothing #125 could have hidden in it.
 */
const NOT_HELD = new Set(["RelayStateStore"]);

describe("the five product areas and the Task runtimes compose in production (#200)", () => {
  it("automatically researches manual, typed, Calendar, Transcript and legacy entries through the production queue", async () => {
    const previous = process.env.ENABLE_TEST_SEED;
    process.env.ENABLE_TEST_SEED = "1";
    let runningShell: Shell | undefined;
    try {
      const dir = workspaceDirectory(true);
      const shell = await compose(dir);
      runningShell = shell;
      const call = async <T = unknown>(method: "POST" | "PATCH", url: string, payload: object) => {
        const result = await shell.app.inject({ method, url, payload });
        expect(result.statusCode).toBeLessThan(300);
        return result.json<T>();
      };
      const manual = await call<PersonProfile>("POST", "/api/people", {
        primaryEmail: "manual@entries.example",
      });
      const typed = (
        await call<{ profile: PersonProfile }>("POST", "/api/people/lookup/accept", {
          identifier: "typed@entries.example",
        })
      ).profile;
      const calendar = shell.workspace.profiles.ensureCalendarAttendeeProfile({
        email: "calendar@entries.example",
        provenance: "calendar:acceptance",
      }).profile;
      const legacy = shell.workspace.profiles.create({
        primaryEmail: "legacy@entries.example",
        role: "Owner correction",
      });
      shell.workspace.transcripts.saveTranscript({
        id: "drive_entry_r1",
        source: {
          sourceSystem: "drive",
          externalFileId: "entry",
          fileName: "Entry.md",
          sourceUrl: null,
          checksum: "entry",
          observedRevision: 1,
          modifiedAt: null,
        },
        ingestedAt: "2026-09-05T00:00:00Z",
        extractorVersion: 1,
        normalizedText: "Email transcript@entries.example before the review.",
        meetingDate: "2026-09-05",
        occurrence: null,
        speakers: [],
        speakerIdentityMappings: [],
        roster: [],
        meetingId: null,
      });
      const attach = () =>
        shell.workspace.transcriptCatalog.catalog.attachMeeting("drive_entry_r1", {
          id: "meeting-entry",
          occurrenceKey: null,
          calendarEventId: null,
        });
      await attach();
      await attach();
      const transcript = shell.workspace.profiles
        .search()
        .filter((profile) => profile.primaryEmail === "transcript@entries.example");
      expect(transcript).toHaveLength(1);
      const profiles = [manual, typed, calendar, legacy, transcript[0]];
      for (const profile of profiles)
        await call("POST", "/api/test/person-dossier-source", {
          url: `https://entries.example/${profile.id}`,
          text: `${profile.primaryEmail} has retained evidence.`,
          extraction: {
            fullName: null,
            employer: null,
            sourceClass: "primary-artifact",
            author: null,
            publishedAt: null,
            claims: [],
            works: [],
            expertise: [],
            connections: [],
            sections: [],
          },
        });
      await call("PATCH", "/api/people/research/settings", {
        concurrency: 3,
        profileCalls: 4,
      });
      await shell.start();
      await expect
        .poll(
          async () => {
            const responses = await Promise.all(
              profiles.map((profile) =>
                shell.app.inject({ method: "GET", url: `/api/people/${profile.id}/dossier` }),
              ),
            );
            return responses.every((response) => response.json().dossier?.sourceIds.length > 0);
          },
          { timeout: 12000 },
        )
        .toBe(true);
      expect(shell.workspace.profiles.get(legacy.id)?.role).toBe("Owner correction");
      expect(
        shell.workspace.profiles.ensureCalendarAttendeeProfile({
          email: "calendar@entries.example",
        }).created,
      ).toBe(false);
    } finally {
      if (runningShell) {
        await runningShell.app.inject({ method: "POST", url: "/api/test/migration/arm" });
        await runningShell.app.close();
      }
      if (previous === undefined) delete process.env.ENABLE_TEST_SEED;
      else process.env.ENABLE_TEST_SEED = previous;
    }
  }, 15000);

  it("answers every product area's own surface with no test-only wiring", async () => {
    const shell = await compose(workspaceDirectory(true));

    /* One read per top-level product area, plus the two Tasks surfaces the
       Meeting Wizard and Home draw from. A route that answers here answers
       through the real composition root — this Shell composes no test seam. */
    for (const url of [
      "/api/content-scout",
      "/api/content-engine/projects",
      "/api/content-research/people",
      "/api/people",
      "/api/meetings/list",
      "/api/tasks",
      "/api/tasks/overview",
      "/api/task-lists",
      "/api/action-items",
      "/api/action-item-policy",
      "/api/meeting-brief/daily",
      "/api/meetings/weekly/deterministic",
    ]) {
      const response = await shell.app.inject({ method: "GET", url });
      expect(response.statusCode, `${url} did not answer from the composed Shell`).toBe(200);
    }
  });

  it("holds the Task and Weekly runtimes the boot sequence has to schedule", async () => {
    const shell = await compose(workspaceDirectory(true));

    /* The handles the boot sequence starts and stops. Naming them on the root
       is what makes the schedulers reachable at all: a runtime the Shell
       constructs and then holds nowhere is one nothing can be seen to start. */
    expect(shell.workspace.taskLinking).toBeDefined();
    expect(shell.workspace.weeklyWorkspace).toBeDefined();

    /* Idempotent, like the boot sequence that calls them. */
    await shell.start();
    await shell.start();
    shell.stop();
  });

  it("keeps the Debrief out of the Tasks the owner accepts", async () => {
    const shell = await compose(workspaceDirectory(true));

    /* Meeting Debrief produces Action Items and drafts; the Tasks product owns
       what those become. The retired positional routes prove the boundary from
       the other side (issue #199). */
    const rollup = await shell.app.inject({
      method: "GET",
      url: "/api/meeting-debrief/action-items",
    });

    expect(rollup.statusCode).toBe(404);
    expect((await shell.app.inject({ method: "GET", url: "/api/tasks" })).statusCode).toBe(200);
  });
});

describe("the composed graph holds every Workspace store the server declares (#125)", () => {
  it("holds each one, in the root's own graph or inside a Module", async () => {
    const shell = await compose(workspaceDirectory(true));
    const held = heldClasses({ workspace: shell.workspace, modules: shell.modules });
    const stores = declaredStores();

    /* Non-vacuous: the tree really was read, and the graph really was walked. */
    expect(stores.length).toBeGreaterThan(5);
    expect(held.size).toBeGreaterThan(20);

    expect(
      stores.filter((store) => !held.has(store) && !NOT_HELD.has(store)),
      "a Workspace store no composed object holds is state the product never reads — wire it into composeShell, or delete it",
    ).toEqual([]);
  });

  it("reports what the root holds, not what the repo contains", async () => {
    /* The mutation witness. Before this extraction the root returned nothing,
       and the transcript owners were reachable from no composed value at all —
       exactly the state #125 shipped in. Walking the Modules alone reproduces
       it: the check passes above because the root now names them, not because
       every declared class is found wherever you look. */
    const shell = await compose(workspaceDirectory(true));
    const withoutRootGraph = heldClasses({ modules: shell.modules });

    expect(withoutRootGraph.has("TranscriptCatalogStore")).toBe(false);
    expect(heldClasses({ workspace: shell.workspace }).has("TranscriptCatalogStore")).toBe(true);
  });
});
