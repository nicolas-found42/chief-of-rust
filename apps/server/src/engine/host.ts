import type { FastifyInstance } from "fastify";
import type { RunMeta } from "@chief-of-staff-demo/shared";

/**
 * One Module as the Shell holds it. The Shell keeps a collection of these and
 * nothing else: there is no "the" Module anywhere in the API, so a second
 * Module arrives as another entry rather than as a special case.
 *
 * This is not ADR-0002's registry. Nothing declares itself and nothing is
 * discovered — `main.ts` constructs each Module and hands the list over, which
 * is the seam a registry could slot behind later.
 */
export interface HostedModule {
  /** Stable identity. The same string every one of its Runs records. */
  readonly id: string;
  readonly version: number;
  /** Re-run one of this Module's failed Runs in place, the way it says to. */
  retryRun(id: string): Promise<RunMeta>;
  /** The Module's own endpoints, mounted under the Shell's API. */
  routes?(app: FastifyInstance): Promise<void> | void;
  /** Start or restart this Module's Intakes: at boot, and after a settings save. */
  start?(): void;
  stop?(): void;
  /**
   * Resolves when this Module's every enqueued Run has settled — the migration
   * gate's quiesce seam (issue #144): the reset must not delete runs/ under an
   * in-flight execute, so arming the gate waits on it first.
   */
  idle?(): Promise<void>;
}
