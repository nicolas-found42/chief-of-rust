import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import {
  RelayStateStore,
  environmentRelayBaseUrl,
  hashVerifier,
  seedRelayBaseUrlFromEnv,
} from "../../../apps/server/src/relay/state.js";
import { RelayClient } from "../../../apps/server/src/relay/client.js";
import { createRelayApp } from "../../../relay/src/app.js";
import { publicRelayBaseUrl, registerRelayRoutes } from "../../../apps/server/src/relay/routes.js";
import { RelayWakeUpPoller } from "../../../apps/server/src/relay/poller.js";

// Shell relay client, workspace persistence, Settings status — issue://80 + ADR-0031 + issue://81
// Tests: local generation, Workspace persistence, status without secrets, channel replacement ordering.

describe("RelayStateStore workspace persistence — issue://81", () => {
  it("requires public HTTPS except for explicit loopback development URLs", () => {
    expect(publicRelayBaseUrl("https://relay.example.com/")).toBe("https://relay.example.com");
    expect(publicRelayBaseUrl("http://127.0.0.1:4318")).toBe("http://127.0.0.1:4318");
    expect(() => publicRelayBaseUrl("http://relay:4318")).toThrow(/public HTTPS/);
  });

  it("generates installation identity+secret locally and persists secret in Workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-shell-"));
    const store = new RelayStateStore(join(dir, "relay.json"));
    const first = store.ensureInstallation();
    expect(first.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(first.verifier).toBe(createHash("sha256").update(first.secret, "utf8").digest("hex"));

    const second = store.ensureInstallation();
    expect(second.installationId).toBe(first.installationId);
    expect(second.secret).toBe(first.secret);
    expect(second.created).toBe(false);

    const file = JSON.parse(readFileSync(join(dir, "relay.json"), "utf8")) as { secret: string };
    expect(file.secret).toBe(first.secret);
  });

  it("persists channels and lastWakeUpAt, round-trips via file", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-shell-"));
    const store = new RelayStateStore(join(dir, "relay.json"));
    store.ensureInstallation();
    store.setRelayBaseUrl("http://127.0.0.1:4318");
    store.addChannel({
      channelId: "ch-1",
      token: "tok-1",
      resourceId: "res-1",
      expiration: new Date(Date.now() + 86400000).toISOString(),
    });
    store.setLastWakeUpAt("2026-08-27T12:00:00.000Z");

    const loaded = store.load();
    expect(loaded.relayBaseUrl).toBe("http://127.0.0.1:4318");
    expect(loaded.channels).toHaveLength(1);
    expect(loaded.channels[0]?.channelId).toBe("ch-1");
    expect(loaded.lastWakeUpAt).toBe("2026-08-27T12:00:00.000Z");
  });
});

describe("Settings status without exposing secrets — issue://81", () => {
  it("GET /api/relay/status reports installation/channel/lastWakeUp without secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-shell-"));
    const app = Fastify({ logger: false });
    registerRelayRoutes(app, { workspaceDir: dir, onInstalled: async () => undefined });

    // initially no installation
    const empty = await app.inject({ method: "GET", url: "/api/relay/status" });
    expect(empty.statusCode).toBe(200);
    const emptyBody = JSON.parse(empty.body) as {
      installationId: string | null;
      hasSecret: boolean;
    };
    expect(emptyBody.installationId).toBeNull();
    expect(emptyBody.hasSecret).toBe(false);

    // create installation
    await app.inject({ method: "POST", url: "/api/relay/install", payload: {} });

    // add channel via store directly to avoid needing relay
    const store = new RelayStateStore(join(dir, "relay.json"));
    store.addChannel({
      channelId: "ch-123",
      token: "secret-token-should-not-appear",
      resourceId: "res-123",
      expiration: null,
    });
    store.setLastWakeUpAt("2026-08-27T15:00:00.000Z");
    store.setRelayBaseUrl("http://127.0.0.1:9"); // unreachable, but status should still report

    const status = await app.inject({ method: "GET", url: "/api/relay/status" });
    expect(status.statusCode).toBe(200);
    const body = JSON.parse(status.body) as {
      installationId: string | null;
      hasSecret: boolean;
      channels: Array<{ channelId: string }>;
      lastWakeUpAt: string | null;
    };
    expect(body.installationId).toBeTruthy();
    expect(body.hasSecret).toBe(true);
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]?.channelId).toBe("ch-123");
    expect(body.lastWakeUpAt).toBe("2026-08-27T15:00:00.000Z");
    // prove secrets/tokens not exposed in status payload
    expect(status.body).not.toContain("secret-token-should-not-appear");
    expect(status.body).not.toContain("secret");
    // file holds secret, status hides it
    const fileContent = readFileSync(join(dir, "relay.json"), "utf8");
    expect(fileContent).toContain("secret-token-should-not-appear"); // stored locally
    expect(status.body).not.toContain("secret-token-should-not-appear");

    await app.close();
  });
});

describe("Shell relay client channel replacement — issue://81", () => {
  it("activates new before revoking old (RelayClient.replaceChannel order)", async () => {
    const { app, store } = createRelayApp();
    // start in-process relay HTTP
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const installationId = "inst-replace-1";
    const secret = "replace-secret-" + Math.random().toString(16).slice(2);
    const verifier = hashVerifier(secret);
    store.createInstallation(installationId, verifier);

    const client = new RelayClient({ baseUrl, installationId, secret });
    await client.registerInstallation();

    const oldChannelId = "old-ch";
    const oldToken = "old-token-xyz";
    await client.registerChannel({ channelId: oldChannelId, token: oldToken });

    const newChannelId = "new-ch";
    const newToken = "new-token-abc";
    // replace: new activated before old revoked
    await client.replaceChannel(oldChannelId, { channelId: newChannelId, token: newToken });

    // old should be revoked
    expect(store.authenticateChannel(oldChannelId, oldToken)).toMatchObject({
      ok: false,
      error: "revoked channel",
    });
    expect(store.authenticateChannel(newChannelId, newToken)).toMatchObject({ ok: true });

    // new still accepts, old rejected
    const ok = await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": newChannelId,
        "x-goog-channel-token": newToken,
        "x-goog-resource-id": "res-1",
        "x-goog-message-number": "1",
      },
    });
    expect(ok.statusCode).toBe(204);

    const bad = await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": oldChannelId,
        "x-goog-channel-token": oldToken,
        "x-goog-resource-id": "res-1",
        "x-goog-message-number": "2",
      },
    });
    expect(bad.statusCode).toBe(404);

    await app.close();
  });
});

describe("Shell relay wake-up processing — issue://81", () => {
  it("reports Calendar watch bootstrap failure when relay installation succeeds", async () => {
    const { app: relay } = createRelayApp();
    await relay.listen({ port: 0, host: "127.0.0.1" });
    const address = relay.server.address() as { port: number };
    const shell = Fastify({ logger: false });
    registerRelayRoutes(shell, {
      workspaceDir: mkdtempSync(join(tmpdir(), "relay-shell-bootstrap-")),
      onInstalled: async () => {
        throw new Error("Google Calendar watch refused");
      },
    });

    const response = await shell.inject({
      method: "POST",
      url: "/api/relay/install",
      payload: { relayBaseUrl: `http://127.0.0.1:${address.port}` },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: "Calendar watch bootstrap failed: Google Calendar watch refused",
    });
    await shell.close();
    await relay.close();
  });

  it("long-polls in the background and sends each wake-up through Intake before ack", async () => {
    const { app: relay } = createRelayApp();
    await relay.listen({ port: 0, host: "127.0.0.1" });
    const relayAddress = relay.server.address() as { port: number };
    const relayBaseUrl = `http://127.0.0.1:${relayAddress.port}`;
    const workspaceDir = mkdtempSync(join(tmpdir(), "relay-shell-background-"));
    const shell = Fastify({ logger: false });
    const onInstalled = vi.fn(async () => undefined);
    registerRelayRoutes(shell, { workspaceDir, onInstalled });
    await shell.inject({
      method: "POST",
      url: "/api/relay/install",
      payload: { relayBaseUrl },
    });
    expect(onInstalled).toHaveBeenCalledOnce();
    await shell.inject({
      method: "POST",
      url: "/api/relay/channels",
      payload: { channelId: "calendar-background", token: "background-token" },
    });
    await relay.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": "calendar-background",
        "x-goog-channel-token": "background-token",
        "x-goog-resource-id": "resource-background",
        "x-goog-resource-state": "exists",
        "x-goog-message-number": "1",
      },
    });
    const processed: unknown[][] = [];
    const poller = new RelayWakeUpPoller({
      store: new RelayStateStore(join(workspaceDir, "relay.json")),
      processWakeUps: async (messages) => {
        processed.push(messages);
      },
      waitSeconds: 0,
      idleDelayMs: 5,
    });

    poller.start();
    await vi.waitFor(() => expect(processed).toHaveLength(1));
    poller.stop();

    expect(processed[0]).toHaveLength(1);
    await shell.close();
    await relay.close();
  });

  it("processes buffered wake-ups before acknowledging them", async () => {
    const { app: relay, store: relayStore } = createRelayApp();
    await relay.listen({ port: 0, host: "127.0.0.1" });
    const relayAddress = relay.server.address() as { port: number };
    const relayBaseUrl = `http://127.0.0.1:${relayAddress.port}`;
    const workspaceDir = mkdtempSync(join(tmpdir(), "relay-shell-poll-"));
    const shell = Fastify({ logger: false });
    const processed: unknown[][] = [];
    registerRelayRoutes(shell, {
      workspaceDir,
      onInstalled: async () => undefined,
      processWakeUps: async (messages: unknown[]) => {
        processed.push(messages);
      },
    });

    expect(
      (
        await shell.inject({
          method: "POST",
          url: "/api/relay/install",
          payload: { relayBaseUrl },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await shell.inject({
          method: "POST",
          url: "/api/relay/channels",
          payload: { channelId: "calendar-1", token: "calendar-token" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await relay.inject({
          method: "POST",
          url: "/google/push",
          headers: {
            "x-goog-channel-id": "calendar-1",
            "x-goog-channel-token": "calendar-token",
            "x-goog-resource-id": "resource-1",
            "x-goog-resource-state": "exists",
            "x-goog-message-number": "1",
          },
        })
      ).statusCode,
    ).toBe(204);

    const polled = await shell.inject({ method: "POST", url: "/api/relay/poll" });

    expect(polled.statusCode).toBe(200);
    expect(processed).toHaveLength(1);
    expect(processed[0]).toHaveLength(1);
    expect(relayStore.listPending(processedInstallationId(workspaceDir))).toHaveLength(0);

    await shell.close();
    await relay.close();
  });

  it("leaves wake-ups unacknowledged when Intake processing fails", async () => {
    const { app: relay, store: relayStore } = createRelayApp();
    await relay.listen({ port: 0, host: "127.0.0.1" });
    const relayAddress = relay.server.address() as { port: number };
    const relayBaseUrl = `http://127.0.0.1:${relayAddress.port}`;
    const workspaceDir = mkdtempSync(join(tmpdir(), "relay-shell-retry-"));
    const shell = Fastify({ logger: false });
    registerRelayRoutes(shell, {
      workspaceDir,
      onInstalled: async () => undefined,
      processWakeUps: async () => {
        throw new Error("Calendar reconciliation unavailable");
      },
    });
    await shell.inject({
      method: "POST",
      url: "/api/relay/install",
      payload: { relayBaseUrl },
    });
    await shell.inject({
      method: "POST",
      url: "/api/relay/channels",
      payload: { channelId: "calendar-2", token: "calendar-token-2" },
    });
    await relay.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": "calendar-2",
        "x-goog-channel-token": "calendar-token-2",
        "x-goog-resource-id": "resource-2",
        "x-goog-resource-state": "exists",
        "x-goog-message-number": "1",
      },
    });

    const polled = await shell.inject({ method: "POST", url: "/api/relay/poll" });

    expect(polled.statusCode).toBe(502);
    expect(relayStore.listPending(processedInstallationId(workspaceDir))).toHaveLength(1);

    await shell.close();
    await relay.close();
  });
});

function processedInstallationId(workspaceDir: string): string {
  const state = new RelayStateStore(join(workspaceDir, "relay.json")).load();
  if (!state.installationId) throw new Error("expected relay installation");
  return state.installationId;
}

describe("relay base URL seeded from the deployment environment — issue #109", () => {
  it("seeds a Workspace that has no stored address, and reports what it stored", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-seed-"));
    const store = new RelayStateStore(join(dir, "relay.json"));
    expect(store.load().relayBaseUrl).toBeNull();

    expect(seedRelayBaseUrlFromEnv(dir, "http://relay:4318")).toBe("http://relay:4318");
    expect(store.load().relayBaseUrl).toBe("http://relay:4318");
  });

  it("never overwrites a stored address — an operator's choice survives restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-seed-"));
    const store = new RelayStateStore(join(dir, "relay.json"));
    store.setRelayBaseUrl("https://relay.example.com");

    // Every boot re-runs the seed; the stored value has to win each time.
    expect(seedRelayBaseUrlFromEnv(dir, "http://relay:4318")).toBeNull();
    expect(seedRelayBaseUrlFromEnv(dir, "http://relay:4318")).toBeNull();
    expect(store.load().relayBaseUrl).toBe("https://relay.example.com");
  });

  it("leaves the Workspace alone when the environment declares nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-seed-"));
    expect(seedRelayBaseUrlFromEnv(dir, undefined)).toBeNull();
    expect(seedRelayBaseUrlFromEnv(dir, "   ")).toBeNull();
    expect(new RelayStateStore(join(dir, "relay.json")).load().relayBaseUrl).toBeNull();
  });

  it("refuses an unusable environment value rather than storing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-seed-"));
    for (const value of [
      "not-a-url",
      "ftp://relay:4318",
      "http://user:pw@relay:4318",
      "http://relay:4318/base",
      "http://relay:4318/?x=1",
    ]) {
      expect(environmentRelayBaseUrl(value), value).toBeNull();
      expect(seedRelayBaseUrlFromEnv(dir, value), value).toBeNull();
    }
    expect(new RelayStateStore(join(dir, "relay.json")).load().relayBaseUrl).toBeNull();
  });

  it("accepts the Compose default's plain HTTP, which Settings input still refuses", () => {
    // The environment names a service on the operator's own network; a URL a
    // person types into Settings is held to public HTTPS. Both rules stand.
    expect(environmentRelayBaseUrl("http://relay:4318")).toBe("http://relay:4318");
    expect(() => publicRelayBaseUrl("http://relay:4318")).toThrow(/public HTTPS/);
  });

  it("refuses plain HTTP for an address that could be public, even from the environment", () => {
    // The installation secret travels as a bearer token, so being declared by
    // the operator does not buy a resolvable host the right to cleartext.
    expect(environmentRelayBaseUrl("http://relay.example.com")).toBeNull();
    expect(environmentRelayBaseUrl("http://203.0.113.7:4318")).toBeNull();
    // Same hosts over HTTPS are fine, as are the private forms over HTTP.
    expect(environmentRelayBaseUrl("https://relay.example.com")).toBe("https://relay.example.com");
    expect(environmentRelayBaseUrl("http://127.0.0.1:4318")).toBe("http://127.0.0.1:4318");
    expect(environmentRelayBaseUrl("http://localhost:4318")).toBe("http://localhost:4318");
  });

  it("a seeded address is what status probes, and status still exposes no secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-seed-"));
    const { app: relay } = createRelayApp();
    await relay.listen({ port: 0, host: "127.0.0.1" });
    const { port } = relay.server.address() as { port: number };

    seedRelayBaseUrlFromEnv(dir, `http://127.0.0.1:${port}`);
    const store = new RelayStateStore(join(dir, "relay.json"));
    store.ensureInstallation();

    const app = Fastify();
    registerRelayRoutes(app, { workspaceDir: dir, onInstalled: async () => {} });
    const res = await app.inject({ method: "GET", url: "/api/relay/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ relayBaseUrl: string; relayHealth: string }>();
    expect(body.relayBaseUrl).toBe(`http://127.0.0.1:${port}`);
    expect(body.relayHealth).toBe("ok");
    // There is a secret in the Workspace, and none of it reaches the status body.
    const secret = store.load().secret;
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body).not.toContain(secret);

    await app.close();
    await relay.close();
  });

  it("install registers against the seeded address with no body of its own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-seed-"));
    const { app: relay, store: relayStore } = createRelayApp();
    await relay.listen({ port: 0, host: "127.0.0.1" });
    const { port } = relay.server.address() as { port: number };

    seedRelayBaseUrlFromEnv(dir, `http://127.0.0.1:${port}`);

    let installed = 0;
    const app = Fastify();
    registerRelayRoutes(app, {
      workspaceDir: dir,
      onInstalled: async () => {
        installed += 1;
      },
    });
    // No relayBaseUrl in the body: the seeded address is the whole input.
    const res = await app.inject({ method: "POST", url: "/api/relay/install", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(installed).toBe(1);

    const state = new RelayStateStore(join(dir, "relay.json")).load();
    expect(state.relayBaseUrl).toBe(`http://127.0.0.1:${port}`);
    expect(state.installationId).not.toBeNull();
    // The relay itself holds the installation, so registration really happened.
    expect(relayStore.authenticateInstallation(state.installationId!, state.secret!).ok).toBe(true);

    await app.close();
    await relay.close();
  });
});
