import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const startServerPath = fileURLToPath(new URL("./start-server.mjs", import.meta.url));
const repoRoot = resolve(dirname(startServerPath), "../..");

/**
 * Boot one hermetic app instance (fresh temp Workspace, mock provider, test
 * seed seam) on `port` by running the same bootstrap the shared suite used.
 */
export async function startHermeticServer(port: number): Promise<{ stop(): Promise<void> }> {
  const child = spawn(process.execPath, [startServerPath], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  await waitForHealth(port, child);
  return {
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      child.kill("SIGTERM");
      await promise;
    },
  };
}

/** Poll /api/health until the server answers, dying early if the process does. */
async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  const url = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`hermetic server on port ${port} exited before becoming healthy`);
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`hermetic server on port ${port} never became healthy: ${url}`);
    }
    const response = await fetch(url).catch(() => undefined);
    if (response?.ok) return;
    const { promise: slept, resolve: wake } = Promise.withResolvers<void>();
    setTimeout(wake, 250);
    await slept;
  }
}
