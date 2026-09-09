import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../../apps/server/src/config.js";
import type { GoogleConnection } from "../../../apps/server/src/google/connection.js";
import { createMeetingBriefProductionRuntime } from "../../../apps/server/src/modules/meeting-brief-generator/production.js";
import { RelayStateStore } from "../../../apps/server/src/relay/state.js";
import { openRuns } from "../../../apps/server/src/runs.js";

describe("Meeting Brief production composition — issue #92", () => {
  it("preserves the person-configured public relay URL without probing Google", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "meeting-brief-production-"));
    const configStore = new ConfigStore(join(workspaceDir, "config.json"));
    configStore.load();
    new RelayStateStore(join(workspaceDir, "relay.json")).setRelayBaseUrl(
      "https://relay.example.com",
    );
    const google = fromPartial<GoogleConnection>({
      state: async () => {
        throw new Error("production composition must not automatically prove Google");
      },
      auth: () => ({ ok: false, state: "unconfigured" }),
    });

    createMeetingBriefProductionRuntime({
      runs: openRuns(workspaceDir),
      workspaceDir,
      configStore,
      google,
      getCompleteJson: () => async () => ({}),
    });

    expect(new RelayStateStore(join(workspaceDir, "relay.json")).load().relayBaseUrl).toBe(
      "https://relay.example.com",
    );
  });
});

describe("Meeting Brief production owner identity — ADR-0034, issue #112", () => {
  function runtimeFor(state: () => Promise<unknown>) {
    const workspaceDir = mkdtempSync(join(tmpdir(), "meeting-brief-owner-"));
    const configStore = new ConfigStore(join(workspaceDir, "config.json"));
    configStore.load();
    const google = fromPartial<GoogleConnection>({
      state,
      auth: () => ({ ok: false, state: "unconfigured" }),
    });
    return createMeetingBriefProductionRuntime({
      runs: openRuns(workspaceDir),
      workspaceDir,
      configStore,
      google,
      getCompleteJson: () => async () => ({}),
    });
  }

  it("takes the owner from the connected Google identity, normalized", async () => {
    const runtime = runtimeFor(async () => ({ state: "connected", email: "Owner@Example.COM" }));
    expect(await runtime.refreshOwnerIdentity()).toBe("owner@example.com");
    expect(runtime.host.getOwnerEmail()).toBe("owner@example.com");
  });

  it("has no owner until the identity is read, so event data can never become the source", () => {
    const runtime = runtimeFor(async () => ({ state: "connected", email: "owner@example.com" }));
    // Nothing but refreshOwnerIdentity can populate it: a Calendar read carrying
    // a `self` attendee no longer feeds this seam at all.
    expect(runtime.host.getOwnerEmail()).toBeNull();
  });

  it("leaves the owner unknown when the connection is not connected", async () => {
    for (const status of [
      { state: "unconfigured", email: null },
      { state: "expired", email: null },
      { state: "connected", email: null },
    ]) {
      const runtime = runtimeFor(async () => status);
      expect(await runtime.refreshOwnerIdentity()).toBeNull();
      expect(runtime.host.getOwnerEmail()).toBeNull();
    }
  });

  it("re-reads the identity after a reconnect rather than keeping the old owner", async () => {
    let email = "first@example.com";
    const runtime = runtimeFor(async () => ({ state: "connected", email }));
    await runtime.refreshOwnerIdentity();
    expect(runtime.host.getOwnerEmail()).toBe("first@example.com");

    email = "second@example.com";
    runtime.invalidateGoogleIdentity();
    expect(runtime.host.getOwnerEmail()).toBeNull();
    await runtime.refreshOwnerIdentity();
    expect(runtime.host.getOwnerEmail()).toBe("second@example.com");
  });
});
