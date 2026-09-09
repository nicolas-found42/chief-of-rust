import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod/v3";
import { RelayStore, type MessageRecord } from "./store.js";

/**
 * Opaque relay HTTP contract — issue://80 (opaque relay) + ADR-0031.
 * Validates Google push headers, constant-time token compare, stores only
 * installation/channel/message/expiry/ack metadata, rejects bodies and unknown/revoked channels.
 */

const InstallationSchema = z
  .strictObject({
    installationId: z.string().min(1).max(128),
    verifier: z.string().regex(/^[a-f0-9]{64}$/i, "verifier must be sha256 hex"),
  })
  .strict();

const ChannelSchema = z
  .strictObject({
    channelId: z.string().min(1).max(256),
    channelTokenVerifier: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, "channelTokenVerifier must be sha256 hex"),
    expiration: z.string().optional(),
    resourceId: z.string().optional(),
  })
  .strict();

const AckSchema = z
  .strictObject({
    acks: z.array(
      z.strictObject({
        channelId: z.string().min(1),
        messageNumber: z.string().min(1),
      }),
    ),
  })
  .strict();

export interface RelayAppOptions {
  store?: RelayStore;
  now?: () => Date;
}

export function createRelayApp(options: RelayAppOptions = {}): {
  app: FastifyInstance;
  store: RelayStore;
} {
  const store = options.store ?? new RelayStore(options.now);
  const app = Fastify({ logger: false });

  const authenticateInstallation = (
    request: FastifyRequest,
    reply: FastifyReply,
    installationId: string,
  ): boolean => {
    const secret = extractBearer(request.headers.authorization);
    if (!secret) {
      void reply.code(401).send({ error: "missing authorization" });
      return false;
    }
    const result = store.authenticateInstallation(installationId, secret);
    if (!result.ok) {
      void reply.code(result.statusCode).send({ error: result.error });
      return false;
    }
    return true;
  };

  // Health — issue://81 production topology gate
  app.get("/health", async () => ({ ok: true, service: "relay" }));

  // Installation registration — hashed verifier only, no credentials stored
  app.post("/v1/installations", async (request, reply) => {
    const parsed = InstallationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid installation body", details: parsed.error.issues });
    }
    try {
      const rec = store.createInstallation(parsed.data.installationId, parsed.data.verifier);
      return reply.code(201).send({ installationId: rec.installationId, createdAt: rec.createdAt });
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      return reply.code(e.statusCode ?? 400).send({ error: e.message ?? "bad request" });
    }
  });

  // Channel registration — authenticated via installation secret bearer
  app.post("/v1/installations/:installationId/channels", async (request, reply) => {
    const { installationId } = request.params as { installationId: string };
    if (!authenticateInstallation(request, reply, installationId)) return reply;
    const parsed = ChannelSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid channel body", details: parsed.error.issues });
    }
    try {
      const rec = store.createChannel({
        installationId,
        channelId: parsed.data.channelId,
        tokenVerifier: parsed.data.channelTokenVerifier,
        expiration: parsed.data.expiration ?? null,
        resourceId: parsed.data.resourceId ?? null,
      });
      return reply
        .code(201)
        .send({ channelId: rec.channelId, expiration: rec.expiration, createdAt: rec.createdAt });
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      return reply.code(e.statusCode ?? 400).send({ error: e.message ?? "bad request" });
    }
  });

  app.delete("/v1/installations/:installationId/channels/:channelId", async (request, reply) => {
    const { installationId, channelId } = request.params as {
      installationId: string;
      channelId: string;
    };
    if (!authenticateInstallation(request, reply, installationId)) return reply;
    try {
      store.revokeChannel(installationId, channelId);
      return reply.code(204).send();
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      return reply.code(e.statusCode ?? 400).send({ error: e.message ?? "bad request" });
    }
  });

  // Long-poll — authenticated, installation-isolated, at-least-once, offline buffering
  app.get("/v1/installations/:installationId/messages", async (request, reply) => {
    const { installationId } = request.params as { installationId: string };
    if (!authenticateInstallation(request, reply, installationId)) return reply;
    const query = request.query as { wait?: string };
    const waitSec = query.wait ? Math.min(30, Math.max(0, Number(query.wait) || 0)) : 0;

    const pending = store.listPending(installationId);
    if (pending.length > 0 || waitSec === 0) {
      return reply.send({ messages: pending.map(toPublicMessage) });
    }
    // Long-poll wait: poll every 100ms up to waitSec
    const deadline = Date.now() + waitSec * 1000;
    while (Date.now() < deadline) {
      await sleep(100);
      const again = store.listPending(installationId);
      if (again.length > 0) return reply.send({ messages: again.map(toPublicMessage) });
    }
    return reply.send({ messages: [] });
  });

  // Ack — authenticated, idempotent
  app.post("/v1/installations/:installationId/ack", async (request, reply) => {
    const { installationId } = request.params as { installationId: string };
    if (!authenticateInstallation(request, reply, installationId)) return reply;
    const parsed = AckSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid ack body", details: parsed.error.issues });
    }
    const acked = store.ackMessages(installationId, parsed.data.acks);
    return reply.send({ acked });
  });

  // Google push — public callback, validates headers, rejects bodies, constant-time token, duplicate idempotent
  const pushHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    // Body rejection — opaque relay stores no payloads (issue://80 + ADR-0031)
    const hasBody = await hasRequestBody(request);
    if (hasBody) {
      return reply.code(400).send({ error: "body not allowed" });
    }

    const headers = request.headers as Record<string, string | undefined>;
    const channelId = headers["x-goog-channel-id"];
    const channelToken = headers["x-goog-channel-token"];
    const resourceId = headers["x-goog-resource-id"];
    const resourceState = headers["x-goog-resource-state"];
    const messageNumber = headers["x-goog-message-number"];
    const resourceUri = headers["x-goog-resource-uri"] ?? null;
    const channelExpiration = headers["x-goog-channel-expiration"] ?? null;

    if (!channelId || !channelToken || !resourceId || !messageNumber) {
      return reply.code(400).send({
        error: "missing required Google notification headers",
        required: [
          "x-goog-channel-id",
          "x-goog-channel-token",
          "x-goog-resource-id",
          "x-goog-message-number",
        ],
      });
    }
    if (!/^\d+$/.test(messageNumber)) {
      return reply.code(400).send({ error: "invalid message number" });
    }

    const channelAuthentication = store.authenticateChannel(channelId, channelToken);
    if (!channelAuthentication.ok) {
      return reply
        .code(channelAuthentication.statusCode)
        .send({ error: channelAuthentication.error });
    }

    try {
      store.appendMessage(channelAuthentication.value, {
        channelId,
        messageNumber,
        resourceId,
        resourceState: resourceState ?? "exists",
        resourceUri,
        channelExpiration,
      });
      return reply.code(204).send();
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      return reply.code(e.statusCode ?? 400).send({ error: e.message ?? "bad request" });
    }
  };

  app.post("/google/push", pushHandler);

  return { app, store };
}

function extractBearer(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return match[1]?.trim() ?? null;
}

function toPublicMessage(m: MessageRecord) {
  return {
    channelId: m.channelId,
    messageNumber: m.messageNumber,
    resourceId: m.resourceId,
    resourceState: m.resourceState,
    resourceUri: m.resourceUri,
    channelExpiration: m.channelExpiration,
    receivedAt: m.receivedAt,
    expiresAt: m.expiresAt,
  };
}

async function hasRequestBody(request: FastifyRequest): Promise<boolean> {
  const headers = request.headers as Record<string, string | undefined>;
  const length = headers["content-length"];
  if (length && Number(length) > 0) return true;
  const body = request.body;
  if (body !== undefined && body !== null) {
    if (typeof body === "string" && body.length > 0) return true;
    if (Buffer.isBuffer(body) && body.length > 0) return true;
    if (typeof body === "object" && Object.keys(body).length > 0) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
