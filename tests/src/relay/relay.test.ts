import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { createRelayApp } from "../../../relay/src/app.js";
import { RelayStore, RETENTION_MS } from "../../../relay/src/store.js";

// Contract tests at relay seam (in-process HTTP) — issue://80 (opaque relay / Calendar push Intake) + ADR-0031
// Covers: validation, buffering, ack, retention, replacement, isolation. References only, not duplicating spec body.

function verifier(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function token(): string {
  return randomBytes(16).toString("hex");
}

describe("relay health — issue://81", () => {
  it("GET /health returns ok", async () => {
    const { app } = createRelayApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
    await app.close();
  });
});

describe("validation — issue://81 + issue://80 Google headers + ADR-0031", () => {
  it("enriches a pending channel registration with Google resource metadata", () => {
    const store = new RelayStore();
    const installationId = randomUUID();
    const secret = token();
    const channelId = randomUUID();
    const channelToken = token();
    store.createInstallation(installationId, verifier(secret));
    store.createChannel({
      installationId,
      channelId,
      tokenVerifier: verifier(channelToken),
    });

    const updated = store.createChannel({
      installationId,
      channelId,
      tokenVerifier: verifier(channelToken),
      resourceId: "google-resource-1",
      expiration: "2026-09-04T10:00:00.000Z",
    });

    expect(updated).toMatchObject({
      resourceId: "google-resource-1",
      expiration: "2026-09-04T10:00:00.000Z",
    });
  });

  it("rejects missing required headers", async () => {
    const { app, store } = createRelayApp();
    const instId = randomUUID();
    const secret = token();
    store.createInstallation(instId, verifier(secret));
    const chId = randomUUID();
    const chToken = token();
    store.createChannel({
      installationId: instId,
      channelId: chId,
      tokenVerifier: verifier(chToken),
    });

    // missing X-Goog-Channel-Token
    const res = await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": chId,
        "x-goog-resource-id": "res-1",
        "x-goog-message-number": "1",
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects body (opaque relay stores no payloads — issue://80 + ADR-0031)", async () => {
    const { app, store } = createRelayApp();
    const instId = randomUUID();
    const secret = token();
    store.createInstallation(instId, verifier(secret));
    const chId = randomUUID();
    const chToken = token();
    store.createChannel({
      installationId: instId,
      channelId: chId,
      tokenVerifier: verifier(chToken),
    });

    const res = await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": chId,
        "x-goog-channel-token": chToken,
        "x-goog-resource-id": "res-1",
        "x-goog-message-number": "1",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ credentials: "secret", eventData: { summary: "meeting" } }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("body not allowed");
    // prove no message stored
    expect(store.countMessages()).toBe(0);
    await app.close();
  });

  it("rejects invalid channel token with constant-time compare (401)", async () => {
    const { app, store } = createRelayApp();
    const instId = randomUUID();
    const secret = token();
    store.createInstallation(instId, verifier(secret));
    const chId = randomUUID();
    const chToken = token();
    store.createChannel({
      installationId: instId,
      channelId: chId,
      tokenVerifier: verifier(chToken),
    });

    const res = await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": chId,
        "x-goog-channel-token": "wrong-token",
        "x-goog-resource-id": "res-1",
        "x-goog-message-number": "1",
      },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects unknown channel (404)", async () => {
    const { app } = createRelayApp();
    const res = await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": "unknown-channel-id",
        "x-goog-channel-token": "any",
        "x-goog-resource-id": "res-1",
        "x-goog-message-number": "1",
      },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("rejects revoked channel (404 after revoke — channel replacement ordering)", async () => {
    const { app, store } = createRelayApp();
    const instId = randomUUID();
    const secret = token();
    store.createInstallation(instId, verifier(secret));
    const chId = randomUUID();
    const chToken = token();
    store.createChannel({
      installationId: instId,
      channelId: chId,
      tokenVerifier: verifier(chToken),
    });
    store.revokeChannel(instId, chId);

    const res = await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": chId,
        "x-goog-channel-token": chToken,
        "x-goog-resource-id": "res-1",
        "x-goog-message-number": "1",
      },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("rejects extra fields on installation/channel registration (no credentials/event bodies)", async () => {
    const { app } = createRelayApp();
    const instId = randomUUID();
    const secret = token();
    // try to send extra forbidden field
    const res = await app.inject({
      method: "POST",
      url: "/v1/installations",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        installationId: instId,
        verifier: verifier(secret),
        credentials: "should-reject",
      }),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("accepts valid push and creates wake-up", async () => {
    const { app, store } = createRelayApp();
    const instId = randomUUID();
    const secret = token();
    store.createInstallation(instId, verifier(secret));
    const chId = randomUUID();
    const chToken = token();
    store.createChannel({
      installationId: instId,
      channelId: chId,
      tokenVerifier: verifier(chToken),
    });

    const res = await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": chId,
        "x-goog-channel-token": chToken,
        "x-goog-resource-id": "res-123",
        "x-goog-resource-state": "exists",
        "x-goog-message-number": "42",
        "x-goog-resource-uri":
          "https://www.googleapis.com/calendar/v3/calendars/primary/events/123",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(store.countMessages()).toBe(1);
    const pending = store.listPending(instId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.channelId).toBe(chId);
    expect(pending[0]?.messageNumber).toBe("42");
    expect(pending[0]?.resourceId).toBe("res-123");
    // prove no credential/event body stored
    const snap = store.snapshot() as { messages: Array<Record<string, unknown>> };
    for (const m of snap.messages) {
      expect(m).not.toHaveProperty("credentials");
      expect(m).not.toHaveProperty("eventData");
      expect(m).not.toHaveProperty("brief");
    }
    await app.close();
  });
});

describe("buffering, ack, at-least-once — issue://81", () => {
  it("buffers wake-ups and long-poll returns them", async () => {
    const { app, store } = createRelayApp();
    const instId = randomUUID();
    const secret = token();
    store.createInstallation(instId, verifier(secret));
    const chId = randomUUID();
    const chToken = token();
    store.createChannel({
      installationId: instId,
      channelId: chId,
      tokenVerifier: verifier(chToken),
    });

    // two pushes
    for (const n of ["1", "2"]) {
      await app.inject({
        method: "POST",
        url: "/google/push",
        headers: {
          "x-goog-channel-id": chId,
          "x-goog-channel-token": chToken,
          "x-goog-resource-id": `res-${n}`,
          "x-goog-message-number": n,
        },
      });
    }

    const poll = await app.inject({
      method: "GET",
      url: `/v1/installations/${instId}/messages`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(poll.statusCode).toBe(200);
    const data = JSON.parse(poll.body) as { messages: Array<{ messageNumber: string }> };
    expect(data.messages).toHaveLength(2);
    expect(data.messages.map((m) => m.messageNumber)).toEqual(["1", "2"]);

    // at-least-once: second poll without ack returns same
    const poll2 = await app.inject({
      method: "GET",
      url: `/v1/installations/${instId}/messages`,
      headers: { authorization: `Bearer ${secret}` },
    });
    const data2 = JSON.parse(poll2.body) as { messages: Array<unknown> };
    expect(data2.messages).toHaveLength(2);
    await app.close();
  });

  it("ack removes messages, second ack idempotent", async () => {
    const { app, store } = createRelayApp();
    const instId = randomUUID();
    const secret = token();
    store.createInstallation(instId, verifier(secret));
    const chId = randomUUID();
    const chToken = token();
    store.createChannel({
      installationId: instId,
      channelId: chId,
      tokenVerifier: verifier(chToken),
    });

    await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": chId,
        "x-goog-channel-token": chToken,
        "x-goog-resource-id": "res-1",
        "x-goog-message-number": "10",
      },
    });

    const ack = await app.inject({
      method: "POST",
      url: `/v1/installations/${instId}/ack`,
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      payload: JSON.stringify({ acks: [{ channelId: chId, messageNumber: "10" }] }),
    });
    expect(ack.statusCode).toBe(200);
    expect((JSON.parse(ack.body) as { acked: number }).acked).toBe(1);

    const poll = await app.inject({
      method: "GET",
      url: `/v1/installations/${instId}/messages`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect((JSON.parse(poll.body) as { messages: unknown[] }).messages).toHaveLength(0);

    // duplicate ack idempotent
    const ack2 = await app.inject({
      method: "POST",
      url: `/v1/installations/${instId}/ack`,
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      payload: JSON.stringify({ acks: [{ channelId: chId, messageNumber: "10" }] }),
    });
    expect((JSON.parse(ack2.body) as { acked: number }).acked).toBe(0);
    await app.close();
  });

  it("duplicate message numbers idempotent (no duplicate wake-up)", async () => {
    const { app, store } = createRelayApp();
    const instId = randomUUID();
    const secret = token();
    store.createInstallation(instId, verifier(secret));
    const chId = randomUUID();
    const chToken = token();
    store.createChannel({
      installationId: instId,
      channelId: chId,
      tokenVerifier: verifier(chToken),
    });

    const headers = {
      "x-goog-channel-id": chId,
      "x-goog-channel-token": chToken,
      "x-goog-resource-id": "res-dup",
      "x-goog-message-number": "99",
    };
    const r1 = await app.inject({ method: "POST", url: "/google/push", headers });
    const r2 = await app.inject({ method: "POST", url: "/google/push", headers });
    expect(r1.statusCode).toBe(204);
    expect(r2.statusCode).toBe(204);
    expect(store.countMessages()).toBe(1);
    expect(store.listPending(instId)).toHaveLength(1);
    await app.close();
  });

  it("offline buffering: messages remain until ack (bounded retention baseline)", async () => {
    const { app, store } = createRelayApp();
    const instId = randomUUID();
    const secret = token();
    store.createInstallation(instId, verifier(secret));
    const chId = randomUUID();
    const chToken = token();
    store.createChannel({
      installationId: instId,
      channelId: chId,
      tokenVerifier: verifier(chToken),
    });

    await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": chId,
        "x-goog-channel-token": chToken,
        "x-goog-resource-id": "res-offline",
        "x-goog-message-number": "5",
      },
    });
    // simulate offline: no poll/ack yet, message stays
    expect(store.listPending(instId)).toHaveLength(1);
    // after poll without ack, still buffered
    await app.inject({
      method: "GET",
      url: `/v1/installations/${instId}/messages`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(store.listPending(instId)).toHaveLength(1);
    await app.close();
  });
});

describe("retention — issue://81 bounded retention", () => {
  it("expires messages after RETENTION_MS", async () => {
    let now = new Date("2026-08-27T10:00:00.000Z");
    const store = new RelayStore(() => now);
    const { app } = createRelayApp({ store });
    const instId = randomUUID();
    const secret = token();
    store.createInstallation(instId, verifier(secret));
    const chId = randomUUID();
    const chToken = token();
    store.createChannel({
      installationId: instId,
      channelId: chId,
      tokenVerifier: verifier(chToken),
    });

    await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": chId,
        "x-goog-channel-token": chToken,
        "x-goog-resource-id": "res-ret",
        "x-goog-message-number": "1",
      },
    });
    expect(store.listPending(instId)).toHaveLength(1);
    // advance past retention
    now = new Date(now.getTime() + RETENTION_MS + 1000);
    // prune occurs on list
    expect(store.listPending(instId)).toHaveLength(0);
    expect(store.countMessages()).toBe(0);
    await app.close();
  });
});

describe("channel replacement — issue://81 activates new before revoking old", () => {
  it("allows two active channels then revoke old keeps new", async () => {
    const { app, store } = createRelayApp();
    const instId = randomUUID();
    const secret = token();
    store.createInstallation(instId, verifier(secret));

    const oldId = randomUUID();
    const oldToken = token();
    const newId = randomUUID();
    const newToken = token();

    // create old
    store.createChannel({
      installationId: instId,
      channelId: oldId,
      tokenVerifier: verifier(oldToken),
    });
    // create new before revoking old
    store.createChannel({
      installationId: instId,
      channelId: newId,
      tokenVerifier: verifier(newToken),
    });

    // both accept pushes
    const rOld = await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": oldId,
        "x-goog-channel-token": oldToken,
        "x-goog-resource-id": "res-old",
        "x-goog-message-number": "1",
      },
    });
    const rNew = await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": newId,
        "x-goog-channel-token": newToken,
        "x-goog-resource-id": "res-new",
        "x-goog-message-number": "1",
      },
    });
    expect(rOld.statusCode).toBe(204);
    expect(rNew.statusCode).toBe(204);
    expect(store.listPending(instId)).toHaveLength(2);

    // revoke old
    store.revokeChannel(instId, oldId);

    const rOldAfter = await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": oldId,
        "x-goog-channel-token": oldToken,
        "x-goog-resource-id": "res-old",
        "x-goog-message-number": "2",
      },
    });
    expect(rOldAfter.statusCode).toBe(404);

    const rNewAfter = await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": newId,
        "x-goog-channel-token": newToken,
        "x-goog-resource-id": "res-new",
        "x-goog-message-number": "2",
      },
    });
    expect(rNewAfter.statusCode).toBe(204);
    await app.close();
  });

  it("revokes via HTTP DELETE after registering new (Shell replacement flow)", async () => {
    const { app, store } = createRelayApp();
    const instId = randomUUID();
    const secret = token();
    store.createInstallation(instId, verifier(secret));

    const oldId = randomUUID();
    const oldToken = token();
    const newId = randomUUID();
    const newToken = token();

    // register old via HTTP
    const install = await app.inject({
      method: "POST",
      url: `/v1/installations/${instId}/channels`,
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      payload: JSON.stringify({ channelId: oldId, channelTokenVerifier: verifier(oldToken) }),
    });
    expect(install.statusCode).toBe(201);

    // register new
    const regNew = await app.inject({
      method: "POST",
      url: `/v1/installations/${instId}/channels`,
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      payload: JSON.stringify({ channelId: newId, channelTokenVerifier: verifier(newToken) }),
    });
    expect(regNew.statusCode).toBe(201);

    // revoke old
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/installations/${instId}/channels/${oldId}`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(del.statusCode).toBe(204);

    // old rejected, new accepted
    const rOld = await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": oldId,
        "x-goog-channel-token": oldToken,
        "x-goog-resource-id": "res-old",
        "x-goog-message-number": "1",
      },
    });
    expect(rOld.statusCode).toBe(404);

    const rNew = await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": newId,
        "x-goog-channel-token": newToken,
        "x-goog-resource-id": "res-new",
        "x-goog-message-number": "1",
      },
    });
    expect(rNew.statusCode).toBe(204);
    await app.close();
  });
});

describe("installation isolation — issue://81", () => {
  it("messages isolated per installation", async () => {
    const { app, store } = createRelayApp();
    const aId = randomUUID();
    const aSecret = token();
    const bId = randomUUID();
    const bSecret = token();
    store.createInstallation(aId, verifier(aSecret));
    store.createInstallation(bId, verifier(bSecret));

    const chA = randomUUID();
    const tokA = token();
    const chB = randomUUID();
    const tokB = token();
    store.createChannel({ installationId: aId, channelId: chA, tokenVerifier: verifier(tokA) });
    store.createChannel({ installationId: bId, channelId: chB, tokenVerifier: verifier(tokB) });

    await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": chA,
        "x-goog-channel-token": tokA,
        "x-goog-resource-id": "res-a",
        "x-goog-message-number": "1",
      },
    });
    await app.inject({
      method: "POST",
      url: "/google/push",
      headers: {
        "x-goog-channel-id": chB,
        "x-goog-channel-token": tokB,
        "x-goog-resource-id": "res-b",
        "x-goog-message-number": "1",
      },
    });

    const pollA = await app.inject({
      method: "GET",
      url: `/v1/installations/${aId}/messages`,
      headers: { authorization: `Bearer ${aSecret}` },
    });
    const pollB = await app.inject({
      method: "GET",
      url: `/v1/installations/${bId}/messages`,
      headers: { authorization: `Bearer ${bSecret}` },
    });
    const aMsgs = (JSON.parse(pollA.body) as { messages: Array<{ resourceId: string }> }).messages;
    const bMsgs = (JSON.parse(pollB.body) as { messages: Array<{ resourceId: string }> }).messages;
    expect(aMsgs).toHaveLength(1);
    expect(aMsgs[0]?.resourceId).toBe("res-a");
    expect(bMsgs).toHaveLength(1);
    expect(bMsgs[0]?.resourceId).toBe("res-b");

    // cross-installation poll fails with wrong secret
    const bad = await app.inject({
      method: "GET",
      url: `/v1/installations/${aId}/messages`,
      headers: { authorization: `Bearer ${bSecret}` },
    });
    expect(bad.statusCode).toBe(401);

    // cross-installation ack ignored
    const ackCross = await app.inject({
      method: "POST",
      url: `/v1/installations/${bId}/ack`,
      headers: { "content-type": "application/json", authorization: `Bearer ${bSecret}` },
      payload: JSON.stringify({ acks: [{ channelId: chA, messageNumber: "1" }] }),
    });
    expect(ackCross.statusCode).toBe(200);
    // A's message still pending
    expect(store.listPending(aId)).toHaveLength(1);
    await app.close();
  });
});
