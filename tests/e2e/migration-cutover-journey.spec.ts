import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, serverOrigin, test } from "./fixture";

/**
 * The one-time Workspace migration at the browser level (issue #144, spec
 * § Migration and Cutover and its cutover acceptance criteria): the gate
 * holds every normal API surface, the Shell renders the gate instead of the
 * product navs, the preview is content-free, cancelling is a client no-op
 * that the Workspace survives byte-for-byte across a full gated boot, the
 * typed phrase performs the in-process cutover, onboarding receives the
 * user with the seven exact steps, and Home is the product's front door
 * again once onboarding is under way.
 *
 * Two hermetic servers are in play:
 * - This worker's own server (e2e/fixture.ts, port derived from the worker
 *   index) boots post-cutover; this journey arms its gate through
 *   /api/test/migration/arm, drives the whole confirm path, and disarms
 *   through /api/test/migration/disarm — in the test AND unconditionally in
 *   afterAll, so a mid-journey failure can never leave the server holding the
 *   gate for the files that follow it on this worker.
 * - A second instance (port 4410) boots a pre-cutover Workspace with NO
 *   migration marker, spawned from e2e/start-server.mjs with
 *   MIGRATION_TEST_WORKSPACE_DIR. On it, the Cancel proof spans the gated
 *   boot itself: a sha256 snapshot taken before the process exists must
 *   still deep-equal a snapshot taken after the boot, the status and
 *   inventory reads, and the Cancel — byte-for-byte, exactly as the gate
 *   page's own copy promises.
 *
 * The banner-disappearance half of the Home banner contract is not driven
 * here: completing every onboarding step needs a real connected Google
 * grant (provider-enablement reads google.state === "connected"), and no
 * hermetic seam can produce one — the same limit that keeps the connected
 * banner states unit-tested in tests/src/unit/connection-notice.test.ts.
 * The journey asserts the banner present while onboarding is incomplete;
 * "complete" (every step's done read from the real stores) is the status
 * aggregator's contract, covered in tests/src/api/migration-routes.test.ts.
 */

/* The exact phrase the reset demands. Kept as a literal mirror of
   MIGRATION_CONFIRMATION_PHRASE (apps/server/src/migration/workspace.ts): the
   suite imports no app module, so the constant's stability is asserted by the
   journey's own success — a renamed phrase fails the confirm step loudly. */
const SHARED_ORIGIN = serverOrigin;
const SECOND_PORT = 4410;
const SECOND_ORIGIN = `http://127.0.0.1:${SECOND_PORT}`;

const PRODUCT_AREAS = [
  ["Content Engine", "/content-scout"],
  ["Content Research", "/content-research"],
  ["Person Profiles", "/people"],
  ["Meeting Wizard", "/meetings"],
  ["Tasks", "/tasks"],
] as const;

let secondServer: ChildProcess | null = null;
let secondWorkspace: string | null = null;

/** Recursive relative-path + sha256 lines, sorted — the Workspace's bytes, content-free to this suite. */
function snapshotWorkspace(dir: string): string[] {
  const lines: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(child);
      } else {
        const hash = createHash("sha256")
          .update(readFileSync(join(dir, child)))
          .digest("hex");
        lines.push(`${hash} ${child}`);
      }
    }
  };
  walk("");
  return lines.sort();
}

/** A pre-cutover Workspace: hermetic defaults plus product state in every directory category. */
function buildPreCutoverWorkspace(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "runs", "run_legacy"), { recursive: true });
  mkdirSync(join(dir, "person-profiles", "person_legacy"), { recursive: true });
  mkdirSync(join(dir, "content-scout"), { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      provider: "mock",
      model: "",
      apiKey: "",
      tasklistName: "Legacy Meeting Followups",
      google: {
        clientId: "legacy-client-id.apps.googleusercontent.com",
        clientSecret: "legacy-client-secret",
        refreshToken: "legacy-refresh-token",
        lastConnectedAt: "2026-08-01T00:00:00.000Z",
        hasExpiredBefore: true,
      },
      drive: {
        enabled: true,
        folderId: "legacy-folder-id",
        folderName: "Transcripts",
        pollIntervalMinutes: 2,
      },
      ollama: { baseUrl: "http://127.0.0.1:11434" },
      modules: {
        "content-scout": {
          dailyTime: "08:00",
          weeklyDiscoveryDay: 1,
          weeklyDiscoveryTime: "09:00",
        },
        "youtube-trends": {
          channels: [
            {
              id: "UClegacy0000000000000000",
              handle: "@legacy",
              title: "Legacy Channel",
              uploadsPlaylistId: "UUlegacy0000000000000000",
              addedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
          spreadsheetId: "legacy-sheet",
          spreadsheetUrl: "",
        },
      },
    }),
  );
  writeFileSync(join(dir, "runs", "run_legacy", "transcript.txt"), "legacy transcript body");
  writeFileSync(join(dir, "person-profiles", "person_legacy", "current.json"), "{}");
  writeFileSync(join(dir, "content-scout", "state.json"), "{}");
  writeFileSync(join(dir, "mock-result.json"), "{}");
}

/** Waits for a spawned server's health endpoint, failing with the last error if it never answers. */
async function waitForHealth(url: string, deadlineMs = 20_000): Promise<void> {
  const started = Date.now();
  let last: unknown = null;
  while (Date.now() - started < deadlineMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = new Error(`health answered ${res.status}`);
    } catch (err) {
      last = err;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 250);
    await promise;
  }
  throw new Error(`server at ${url} never became healthy: ${String(last)}`);
}

/** Restores the shared hermetic server after the journey, whatever happened to it. Idempotent. */
async function disarmSharedServer(): Promise<void> {
  const res = await fetch(`${SHARED_ORIGIN}/api/test/migration/disarm`, { method: "POST" });
  const body = (await res.json()) as { state?: string };
  expect(res.ok, `disarm failed: ${res.status} ${JSON.stringify(body)}`).toBe(true);
  expect(body.state).toBe("completed");
}

test.afterAll(async () => {
  if (secondServer) {
    secondServer.kill("SIGTERM");
    secondServer = null;
  }
  if (secondWorkspace) {
    rmSync(secondWorkspace, { recursive: true, force: true });
    secondWorkspace = null;
  }
  // The gate arm/disarm seam is exempt from the 503 preHandler exactly for
  // this call, so an armed mid-journey failure cannot poison the serial suite.
  await disarmSharedServer();
});

test("canonical Tasks cutover preserves work, requires exact authorization, and activates all five areas", async ({
  page,
}) => {
  const captured = await page.request.post("/api/tasks", {
    data: { title: "Preserved cutover work" },
  });
  expect(captured.ok()).toBe(true);
  const task = await captured.json();
  expect((await page.request.post("/api/test/migration/arm")).ok()).toBe(true);
  expect((await page.request.get("/api/tasks")).status()).toBe(503);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Workspace migration", exact: true }),
  ).toBeVisible();
  const preview = await (await page.request.get("/api/migration/inventory")).json();
  expect(preview.kind).toBe("canonical-tasks");
  expect(preview.authenticationPreserved).toBe(true);
  expect(preview.counts.tasks).toBeGreaterThan(0);
  await expect(page.locator("main")).not.toContainText("Preserved cutover work");
  const wrong = await page.request.post("/api/migration/confirm", {
    data: { ...preview, typedConfirmation: "RESET WORKSPACE" },
  });
  expect(wrong.status()).toBe(409);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Migration cancelled" })).toBeVisible();
  expect((await page.request.get("/api/migration/receipt")).status()).toBe(404);
  await page.getByRole("button", { name: "Review preview" }).click();
  await page
    .getByLabel("Type MIGRATE TASKS to authorize this Workspace cutover")
    .fill("MIGRATE TASKS");
  await page.getByRole("button", { name: "Migrate Tasks", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Migration complete" })).toBeVisible();
  await page.getByRole("button", { name: "Continue to Home" }).click();
  await expect(page.getByRole("navigation", { name: "Products" })).toBeVisible();
  for (const [name, href] of PRODUCT_AREAS)
    await expect(
      page.getByRole("navigation", { name: "Products" }).getByRole("link", { name }),
    ).toHaveAttribute("href", href);
  expect((await (await page.request.get(`/api/tasks/${task.id}`)).json()).title).toBe(
    "Preserved cutover work",
  );
  const receipt = await (await page.request.get("/api/migration/receipt")).json();
  expect(receipt.fingerprint).toBe(preview.fingerprint);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Products" })).toBeVisible();
});

test("a gated boot leaves the pre-cutover Workspace byte-for-byte unchanged through the Cancel", async ({
  page,
}) => {
  // A second hermetic instance on its own port, over a pre-cutover Workspace
  // with no migration marker. The snapshot is taken BEFORE the process exists,
  // so the proof spans the gated boot itself — not just the armed hold on the
  // already-running worker server.
  secondWorkspace = join(tmpdir(), `tf-migration-gated-${process.pid}`);
  buildPreCutoverWorkspace(secondWorkspace);
  const before = snapshotWorkspace(secondWorkspace);

  const startServerPath = fileURLToPath(new URL("./start-server.mjs", import.meta.url));
  const repoRoot = resolve(dirname(startServerPath), "../..");
  secondServer = spawn(process.execPath, [startServerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(SECOND_PORT),
      MIGRATION_TEST_WORKSPACE_DIR: secondWorkspace,
      /* The environment the app actually ships in: docker-compose declares this,
         and the Shell seeds relay.json from it on a Workspace that has no
         address stored. Without it here the byte-for-byte proof below ran under
         an environment no deployment uses, and missed a gated boot writing to
         the Workspace it was holding. */
      RELAY_BASE_URL: "http://relay:4318",
    },
    stdio: "ignore",
  });
  await waitForHealth(`${SECOND_ORIGIN}/api/health`);

  // The gated boot wrote nothing.
  expect(
    snapshotWorkspace(secondWorkspace),
    "a gated boot must leave the pre-cutover Workspace byte-for-byte unchanged",
  ).toEqual(before);

  // The gate holds this instance's API too.
  const status = await page.request.get(`${SECOND_ORIGIN}/api/migration/status`);
  expect((await status.json()) as { state: string }).toMatchObject({ state: "required" });
  const runsRefused = await page.request.get(`${SECOND_ORIGIN}/api/runs`);
  expect(runsRefused.status()).toBe(503);

  // Drive the gate page on this instance and Cancel: the no-request contract,
  // with the Workspace snapshot still deep-equal to the pre-boot bytes.
  await page.goto(`${SECOND_ORIGIN}/`);
  await expect(page.getByRole("heading", { level: 1, name: "Workspace migration" })).toBeVisible();
  await expect(page.locator("main#main")).toContainText("Canonical Tasks preview");
  const confirmRequests: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/migration/confirm")) confirmRequests.push(response.url());
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`:${SECOND_PORT}/$`));
  expect(confirmRequests, "Cancel must send no confirm request").toEqual([]);
  expect(
    snapshotWorkspace(secondWorkspace),
    "boot + status + inventory + Cancel must leave the Workspace byte-for-byte unchanged",
  ).toEqual(before);
});
