import { resolve } from "node:path";
import { DEFAULT_MODELS } from "@chief-of-staff-demo/shared";
import { composeShell } from "./composition/shell.js";

/**
 * The entry point, and nothing more: read the deployment's environment, compose
 * the Shell, bind the port, and run the boot sequence unless the migration gate
 * is holding a pre-cutover Workspace.
 *
 * Everything that was here is in `composition/shell.ts`, where a test can reach
 * it. What is left has no branch worth testing and no Workspace write of its
 * own — the boot sequence is `shell.start`, and the gate's in-process cutover
 * calls the same function.
 */
const port = Number(process.env.PORT ?? 4317);
/* Loopback by default (ADR-0001). A container sets HOST=0.0.0.0 because the
   loopback interface inside a container is not reachable from the host; the
   published port is still bound to 127.0.0.1 on the host side. */
const host = process.env.HOST ?? "127.0.0.1";
const workspaceDir = process.env.WORKSPACE_DIR ?? "./workspace";

const shell = await composeShell({ workspaceDir, port });

await shell.app.listen({ port, host });
const { config } = shell;
console.log(
  `chief-of-staff-demo listening on http://localhost:${port} (workspace: ${resolve(workspaceDir)}, provider: ${config.provider}, model: ${config.model || DEFAULT_MODELS[config.provider]})`,
);

/* The gate skips the boot-time startup over an un-migrated Workspace; a
   completed Workspace boots exactly as before the gate existed. */
if (!shell.gate.isActive()) {
  await shell.start();
}
