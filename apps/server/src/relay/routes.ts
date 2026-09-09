import type { FastifyInstance } from "fastify";
import { RelayStateStore, relayBaseUrlShape } from "./state.js";
import { relayAccess, type RelayMessage } from "./client.js";

/**
 * Shell relay status routes — issue://80 Settings (relay/channel status + last wake-up)
 * and ADR-0031 (hashed verifier, channel replacement ordering).
 * No secret or token is ever exposed.
 */

export interface RelayRoutesContext {
  workspaceDir: string;
  processWakeUps?: (messages: RelayMessage[]) => Promise<void>;
  onInstalled: () => Promise<void>;
}

/**
 * Hold a URL a person typed into Settings to public HTTPS. Plain HTTP is a
 * loopback development affordance and nothing more; the environment's own
 * address obeys the looser rule in `environmentRelayBaseUrl` instead.
 */
export function publicRelayBaseUrl(value: string): string {
  const shape = relayBaseUrlShape(value);
  if (!shape.ok) {
    throw new Error(
      shape.reason === "unparseable"
        ? "Relay base URL must be a valid URL."
        : "Relay base URL must contain only scheme, host, and optional port.",
    );
  }
  const { trimmed, url } = shape;
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error(
      "Relay base URL must use public HTTPS (HTTP is allowed only for loopback tests).",
    );
  }
  return trimmed;
}

export function registerRelayRoutes(app: FastifyInstance, ctx: RelayRoutesContext): void {
  const store = new RelayStateStore(`${ctx.workspaceDir}/relay.json`);

  // GET /api/relay/status — reports relay/channel status + last wake-up without exposing secrets
  app.get("/api/relay/status", async () => {
    const state = store.load();
    let relayHealth: "ok" | "unreachable" | "not_configured" = "not_configured";
    if (state.relayBaseUrl) {
      try {
        const res = await fetch(`${state.relayBaseUrl.replace(/\/+$/, "")}/health`, {
          method: "GET",
          signal: AbortSignal.timeout(2000),
        });
        relayHealth = res.ok ? "ok" : "unreachable";
      } catch {
        relayHealth = "unreachable";
      }
    }
    return {
      installationId: state.installationId,
      relayBaseUrl: state.relayBaseUrl,
      relayHealth,
      channels: state.channels.map((c) => ({
        channelId: c.channelId,
        expiration: c.expiration,
        resourceId: c.resourceId,
      })),
      lastWakeUpAt: state.lastWakeUpAt,
      hasSecret: Boolean(state.secret),
    };
  });

  // POST /api/relay/install — ensures installation, registers with relay if baseUrl set
  app.post("/api/relay/install", async (request, reply) => {
    const body = (request.body as { relayBaseUrl?: string } | undefined) ?? {};
    if (body.relayBaseUrl !== undefined) {
      if (typeof body.relayBaseUrl !== "string")
        return reply.code(400).send({ error: "relayBaseUrl must be string" });
      try {
        store.setRelayBaseUrl(publicRelayBaseUrl(body.relayBaseUrl));
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    store.ensureInstallation();
    const state = store.load();
    if (state.relayBaseUrl) {
      const access = relayAccess(store);
      if (!access.ok) return reply.code(400).send({ error: access.error });
      try {
        await access.client.registerInstallation();
      } catch (err) {
        return reply.code(502).send({
          error: `relay registration failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      try {
        await ctx.onInstalled();
      } catch (err) {
        return reply.code(502).send({
          error: `Calendar watch bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    const updated = store.load();
    return {
      installationId: updated.installationId,
      relayBaseUrl: updated.relayBaseUrl,
      channels: updated.channels.map((c) => ({ channelId: c.channelId, expiration: c.expiration })),
      lastWakeUpAt: updated.lastWakeUpAt,
    };
  });

  // POST /api/relay/channels — register a channel (activates before revoking old per issue://81)
  app.post("/api/relay/channels", async (request, reply) => {
    const body = request.body as
      | {
          channelId?: string;
          token?: string;
          expiration?: string | null;
          resourceId?: string | null;
        }
      | undefined;
    if (!body || !body.channelId || !body.token)
      return reply.code(400).send({ error: "channelId and token required" });
    const access = relayAccess(store);
    if (!access.ok) return reply.code(400).send({ error: access.error });

    const channel = {
      channelId: body.channelId,
      token: body.token,
      expiration: body.expiration ?? null,
      resourceId: body.resourceId ?? null,
    };

    try {
      await access.client.registerChannel(channel);
    } catch (err) {
      return reply.code(502).send({
        error: `relay channel registration failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    store.addChannel(channel);
    return { ok: true, channelId: channel.channelId };
  });

  // DELETE /api/relay/channels/:channelId — revoke
  app.delete("/api/relay/channels/:channelId", async (request, reply) => {
    const { channelId } = request.params as { channelId: string };
    const access = relayAccess(store);
    if (!access.ok) return reply.code(400).send({ error: access.error });
    try {
      await access.client.revokeChannel(channelId);
    } catch (err) {
      return reply
        .code(502)
        .send({ error: `revoke failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    store.removeChannel(channelId);
    return { ok: true };
  });

  // POST /api/relay/replace-channel — atomic new-before-old (issue://81)
  app.post("/api/relay/replace-channel", async (request, reply) => {
    const body = request.body as
      | {
          oldChannelId?: string;
          newChannelId?: string;
          token?: string;
          expiration?: string | null;
          resourceId?: string | null;
        }
      | undefined;
    if (!body || !body.oldChannelId || !body.newChannelId || !body.token) {
      return reply.code(400).send({ error: "oldChannelId, newChannelId, token required" });
    }
    const access = relayAccess(store);
    if (!access.ok) return reply.code(400).send({ error: access.error });
    const newChannel = {
      channelId: body.newChannelId,
      token: body.token,
      expiration: body.expiration ?? null,
      resourceId: body.resourceId ?? null,
    };
    try {
      await access.client.replaceChannel(body.oldChannelId, newChannel);
    } catch (err) {
      return reply
        .code(502)
        .send({ error: `replace failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    store.removeChannel(body.oldChannelId);
    store.addChannel(newChannel);
    return { ok: true };
  });

  // POST /api/relay/poll — Shell polls relay, updates lastWakeUpAt (Settings shows last wake-up)
  app.post("/api/relay/poll", async (_request, reply) => {
    const access = relayAccess(store);
    if (!access.ok) return reply.code(400).send({ error: access.error });
    let messages: Array<{ channelId: string; messageNumber: string; receivedAt: string }>;
    try {
      messages = await access.client.pollMessages(0);
    } catch (err) {
      return reply
        .code(502)
        .send({ error: `poll failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    if (messages.length > 0) {
      try {
        await ctx.processWakeUps?.(messages as RelayMessage[]);
        await access.client.ackMessages(
          messages.map((m) => ({ channelId: m.channelId, messageNumber: m.messageNumber })),
        );
        const latest = messages[messages.length - 1];
        if (latest) store.setLastWakeUpAt(latest.receivedAt);
      } catch (error) {
        return reply.code(502).send({
          error: `wake-up processing failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const updated = store.load();
    return { messages, lastWakeUpAt: updated.lastWakeUpAt };
  });
}
