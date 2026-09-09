import type { TaskCutover } from "../tasks/cutover.js";
import type { FastifyInstance } from "fastify";
import {
  executeWorkspaceMigration,
  previewWorkspaceMigration,
  readMigrationReceipt,
  readMigrationState,
} from "../migration/workspace.js";
import { buildOnboardingStatus, type OnboardingStatusDeps } from "./onboarding.js";

/**
 * The one-time Workspace migration's API namespace (issue #144, spec
 * §Migration and Cutover). Mounted always: while the gate holds the Workspace
 * pre-cutover, this is the only API surface that stays reachable, and it is
 * the surface whose confirm performs the in-process cutover.
 */

/**
 * The in-memory gate behind the pre-cutover hold. `setActive` exists for the
 * hermetic test seed's arm/disarm seam — production reaches the gate only
 * through `isActive` and `complete`.
 */
export interface MigrationGate {
  isActive(): boolean;
  setActive(active: boolean): void;
  complete(): void;
}

export interface MigrationRouteDeps extends OnboardingStatusDeps {
  workspaceDir: string;
  taskCutover?: TaskCutover;
  gate: MigrationGate;
}

export function registerMigrationRoutes(app: FastifyInstance, deps: MigrationRouteDeps): void {
  /* Always mounted, never gated — the gate page reads it while every other
     namespace rejects with 503. */
  app.get("/api/migration/status", async () => ({
    state: deps.taskCutover
      ? deps.gate.isActive()
        ? "required"
        : deps.taskCutover.receipt()
          ? "completed"
          : "fresh"
      : readMigrationState(deps.workspaceDir),
    kind: deps.taskCutover ? "canonical-tasks" : "legacy-reset",
    onboarding: await buildOnboardingStatus(deps),
  }));

  app.get("/api/migration/inventory", async (_request, reply) => {
    if (deps.taskCutover) return deps.taskCutover.preview();
    if (readMigrationState(deps.workspaceDir) !== "required") {
      reply.code(409).send({ error: "not-required" });
      return;
    }
    return previewWorkspaceMigration(deps.workspaceDir);
  });

  app.post("/api/migration/confirm", async (request, reply) => {
    if (deps.taskCutover) {
      const body = request.body as Record<string, unknown> | null;
      if (
        typeof body?.workspace !== "string" ||
        typeof body.fingerprint !== "string" ||
        typeof body.typedConfirmation !== "string"
      )
        return reply.code(403).send({ error: "Exact Workspace authorization required" });
      try {
        const receipt = await deps.taskCutover.execute({
          workspace: body.workspace,
          fingerprint: body.fingerprint,
          typedConfirmation: body.typedConfirmation,
        });
        deps.gate.complete();
        return { receipt };
      } catch (error) {
        return reply
          .code(409)
          .send({ error: error instanceof Error ? error.message : "Cutover failed" });
      }
    }
    if (readMigrationState(deps.workspaceDir) !== "required") {
      reply.code(409).send({ error: "not-required" });
      return;
    }
    const body = (request.body ?? {}) as { typedConfirmation?: unknown };
    const typedConfirmation =
      typeof body.typedConfirmation === "string" ? body.typedConfirmation : "";
    /* The executor checks the phrase before it reads or writes anything and
       re-runs the fail-closed classifier, so this route only maps its one
       result onto the API's status codes. */
    const result = executeWorkspaceMigration(deps.workspaceDir, { typedConfirmation });
    switch (result.outcome) {
      case "completed":
        /* Load-bearing order: the reset above has written the receipt and the
           marker before returning, so only now may a Module start — a boot
           over this Workspace classifies it completed, never pre-cutover. */
        deps.gate.complete();
        return { receipt: result.receipt };
      case "confirmation-mismatch":
        reply.code(403).send({ error: "confirmation-mismatch" });
        return;
      case "unsafe-mixed-state":
        reply.code(409).send({ error: "unsafe-mixed-state" });
        return;
      case "already-completed":
        reply.code(409).send({ error: "not-required" });
        return;
    }
  });

  app.get("/api/migration/receipt", async (_request, reply) => {
    const receipt = deps.taskCutover
      ? deps.taskCutover.receipt()
      : readMigrationReceipt(deps.workspaceDir);
    if (!receipt) {
      reply.code(404).send({ error: "no-receipt" });
      return;
    }
    return receipt;
  });
}

/**
 * The pre-cutover hold: while the gate is active, every normal `/api/*` route
 * rejects 503 `migration-required`; the migration namespace and `/api/health`
 * stay reachable. Mounted before the route registrations, exactly as Fastify
 * applies hooks — after a route, a hook would not reach it.
 */
export function registerMigrationGate(app: FastifyInstance, gate: MigrationGate): void {
  app.addHook("preHandler", async (request, reply) => {
    if (!gate.isActive()) return;
    const pathname = request.url.split("?")[0] ?? request.url;
    if (!pathname.startsWith("/api/")) return;
    if (pathname === "/api/health") return;
    if (pathname === "/api/migration" || pathname.startsWith("/api/migration/")) return;
    /* The hermetic test seed's seam must stay reachable while the hold is on:
       a journey that fails mid-way still ends by disarming the shared server
       (Slice D's afterAll), and disarm cannot reach a seam the hold swallowed. */
    if (pathname === "/api/test/migration/arm" || pathname === "/api/test/migration/disarm") return;
    reply.code(503).send({ error: "migration-required" });
  });
}
