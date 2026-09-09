import type { GoogleConnection } from "../../google/connection.js";
import type { DebriefDraft, DebriefOutputsDeps } from "./deps.js";

/**
 * The Debrief's outward surface, over the Workspace's shared Google adapters
 * (issue #141). It is deliberately thin: the Module has already decided the
 * recipients, the external-safe body, and which actions are the owner's. All
 * that happens here is the shape change and the connection check.
 *
 * The connection is asked per call, never cached — a token that expired
 * between approval and a Tasks retry must surface as a failure the Run can
 * retry, not as a stale client (ADR-0008).
 */
export function googleDebriefOutputs(google: GoogleConnection): DebriefOutputsDeps {
  const surface = () => {
    const access = google.outputs();
    if (!access.ok) {
      throw new Error(`google_unavailable: ${access.state}`);
    }
    return access.outputs;
  };

  return {
    async createDraft(draft: DebriefDraft): Promise<string> {
      /* One draft addressed to every confirmed recipient. The Gmail adapter
         takes a single header value, so the decided list is joined here
         rather than fanned out into a draft each. */
      return await surface().createDraft({
        to: draft.to.join(", "),
        subject: draft.subject,
        body: draft.body,
      });
    },
  };
}
