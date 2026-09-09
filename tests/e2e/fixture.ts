import { test as base, expect } from "@playwright/test";
import { startHermeticServer } from "./hermetic-server";

/* oxlint-disable no-empty-pattern -- Playwright validates at runtime that every
   fixture callback's first argument is a destructuring pattern; these fixtures
   need nothing from it. */

/* Playwright distributes spec files across workers; every spec file runs
   against its own hermetic app instance — a fresh temp Workspace with no
   leftovers from the files that ran earlier on this worker. Ports fan out
   from 4320 so worker servers never collide with each other, the migration
   journey's second instance (4410), or anything docker-compose owns. Files
   within a worker run sequentially, so they reuse the worker's port one at
   a time. TEST_WORKER_INDEX is set in the worker process before any spec
   module loads. */
const workerIndex = Number(process.env.TEST_WORKER_INDEX ?? "0");
export const serverPort = 4320 + workerIndex;
export const serverOrigin = `http://127.0.0.1:${serverPort}`;

type HermeticServer = { stop(): Promise<void> };

/* One server per spec file: the first test of a file stops whatever the
   previous file on this worker left running, then boots a fresh instance.
   A worker-scoped fixture performs the final stop so no server outlives its
   worker. */
let current: { file: string; server: HermeticServer } | null = null;

export const test = base.extend<
  { baseURL: string; hermeticServer: HermeticServer },
  { hermeticServerTeardown: void }
>({
  /* Every spec gets this worker's origin without touching @playwright/test. */
  baseURL: serverOrigin,
  hermeticServerTeardown: [
    async ({}, use) => {
      await use(undefined);
      if (current) {
        await current.server.stop();
        current = null;
      }
    },
    { scope: "worker", auto: true },
  ],
  hermeticServer: [
    async ({}, use, testInfo) => {
      if (current && current.file !== testInfo.file) {
        await current.server.stop();
        current = null;
      }
      if (!current) {
        current = { file: testInfo.file, server: await startHermeticServer(serverPort) };
      }
      await use(current.server);
    },
    { auto: true },
  ],
});
export { expect };
