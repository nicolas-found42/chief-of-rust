import { describe, expect, it } from "vitest";
import {
  classifyPublicCommandFailure,
  publicCommandRunner,
} from "../../../apps/server/src/source-adapters/public-command";

describe("public command boundary", () => {
  it("preserves real execFile timeout metadata for adapter classification", async () => {
    const run = publicCommandRunner({
      executable: process.execPath,
      timeoutMs: 10,
      maxOutputBytes: 1024,
    });

    const result = await run(["-e", "setInterval(() => undefined, 1_000)"]);

    expect(result.timedOut).toBe(true);
    expect(classifyPublicCommandFailure(result.stderr, "TikTok", result.timedOut)).toMatchObject({
      outcome: "timeout",
      affectedCapabilities: ["items"],
    });
  });
});
