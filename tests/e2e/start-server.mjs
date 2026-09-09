import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

/* A second hermetic instance (the migration journey's gated-boot proof, issue
   #144) supplies its own pre-cutover Workspace — every product file present,
   deliberately no migration marker — so the boot itself can be proved to
   write nothing. The default browser-suite boot is unchanged. */
const workspace = process.env.MIGRATION_TEST_WORKSPACE_DIR
  ? resolve(process.env.MIGRATION_TEST_WORKSPACE_DIR)
  : mkdtempSync(join(tmpdir(), "tf-e2e-"));
if (!process.env.MIGRATION_TEST_WORKSPACE_DIR) {
  mkdirSync(join(workspace, "runs"), { recursive: true });
  writeFileSync(
    join(workspace, "config.json"),
    JSON.stringify(
      {
        provider: "mock",
        model: "",
        apiKey: "",
        tasklistName: "Meeting Followups",
        google: {
          clientId: "",
          clientSecret: "",
          refreshToken: null,
          lastConnectedAt: null,
          hasExpiredBefore: false,
        },
        drive: { enabled: false, folderId: "", folderName: "", pollIntervalMinutes: 2 },
        ollama: { baseUrl: "http://127.0.0.1:11434" },
        /* The hermetic server holds the Content Scout clock just before its due
           times: a 30-second scheduler tick that fires a scheduled daily-intake
           Run (blocked forever until a decision) or a weekly Discovery Run would
           otherwise interleave scheduled Runs and Source Suggestions into any
           journey that takes longer than one tick after a Brand Profile and an
           active Source Target exist. Journeys drive Scout and Discovery
           explicitly, so the schedule stays production-defaulted in the app and
           parked here only. */
        modules: {
          "content-scout": {
            dailyTime: "23:59",
            weeklyDiscoveryDay: 7,
            weeklyDiscoveryTime: "23:59",
          },
          /* Same parking as the Scout clock: with the production-default
             schedule (08:00 UTC, Mondays) the 30-second scheduler tick fires a
             real public-web Research and People Discovery Run as soon as the
             Workspace holds people — network-bound, minutes-long, and racing
             the same APIs from every parallel worker. Journeys visit the
             Content Research pages but never depend on a scheduled Run. */
          "content-research": {
            dailyTime: "23:59",
            weeklyDiscoveryDay: 7,
            weeklyDiscoveryTime: "23:59",
          },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(workspace, "person-research.json"),
    JSON.stringify({
      schemaVersion: 1,
      settings: {
        paused: true,
        concurrency: 1,
        profileCalls: 8,
        profileMilliseconds: 120000,
        refreshHours: 168,
      },
      day: new Date().toISOString().slice(0, 10),
      usedCalls: 0,
      jobs: [],
    }),
  );
  copyFileSync(join(root, "tests/fixtures/mock-result.json"), join(workspace, "mock-result.json"));
  /* The hermetic server boots post-cutover: the one-time migration marker is
     present, so the gate is inactive and every existing journey runs ungated
     (issue #144). */
  mkdirSync(join(workspace, "migration"), { recursive: true });
  writeFileSync(
    join(workspace, "migration", "completed.json"),
    `${JSON.stringify({ migratedAt: new Date().toISOString() })}\n`,
  );
}

const child = spawn(process.execPath, [join(root, "apps/server/dist/main.js")], {
  cwd: root,
  env: {
    ...process.env,
    /* A second hermetic instance spawned by a journey passes its own port. */
    PORT: process.env.PORT ?? "4319",
    WORKSPACE_DIR: workspace,
    ENABLE_TEST_SEED: "1",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

const stop = () => {
  child.kill("SIGTERM");
};
process.on("SIGTERM", () => {
  stop();
  process.exit(0);
});
process.on("SIGINT", () => {
  stop();
  process.exit(0);
});
child.on("exit", (code) => {
  process.exit(code ?? 0);
});
