import type { GoogleConnectionState } from "@chief-of-staff-demo/shared";
import { googleFailureHint } from "../google/connection.js";
import { StageFailure, type RunContext } from "./module.js";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What an error a Google call threw proves about the connection, if anything.
 *
 * A rejected grant is not one bad call: every remaining one would fail the same
 * way, so the batch stops and the Run says reconnecting rather than retrying is
 * the fix (ADR-0008, classified at the failure site). Every Module that reaches
 * Google needs exactly this, so it lives here rather than once per Module.
 *
 * Returns null when the error says nothing about the connection — which is the
 * Module's cue to word the failure in its own terms.
 */
export function connectionFailure(
  ctx: RunContext,
  observe: (error: unknown) => GoogleConnectionState | null,
  error: unknown,
): StageFailure | null {
  const state = observe(error);
  if (!state) {
    return null;
  }
  ctx.event("google_unavailable", { state, error: errorMessage(error) });
  return new StageFailure(`google_${state}`, googleFailureHint(state), {
    connectionState: state,
  });
}

/** The same verdict for a connection that was already known to be unusable. */
export function connectionUnavailable(ctx: RunContext, state: GoogleConnectionState): StageFailure {
  ctx.event("google_unavailable", { state });
  return new StageFailure(`google_${state}`, googleFailureHint(state), {
    connectionState: state,
  });
}
