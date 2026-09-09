import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Minimal opaque relay store — see issue://80 spec (Calendar push Intake / opaque relay)
 * and ADR-0031 (ADR-0031-calendar-push-uses-an-opaque-cloud-relay).
 * Stores only installation / channel / message / expiry / ack metadata.
 * No credentials, Calendar event data, enrichment evidence or Meeting Brief content.
 */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days bounded retention (ADR-0031: long enough to cover offline)

export interface InstallationRecord {
  installationId: string;
  verifier: string; // hex sha256(secret)
  createdAt: string;
}

export interface ChannelRecord {
  channelId: string;
  installationId: string;
  tokenVerifier: string; // hex sha256(channelToken)
  resourceId: string | null;
  expiration: string | null; // ISO string
  revokedAt: string | null;
  createdAt: string;
}

export interface MessageRecord {
  installationId: string;
  channelId: string;
  messageNumber: string; // as received (Google sends numeric string)
  resourceId: string;
  resourceState: string;
  resourceUri: string | null;
  channelExpiration: string | null;
  receivedAt: string;
  expiresAt: string;
  ack: boolean;
}

export type AuthenticationResult<T> =
  { ok: true; value: T } | { ok: false; statusCode: 401 | 404 | 410; error: string };

function hashHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  // Constant-time compare via timingSafeEqual on buffers (issue://81 / ADR-0031)
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function safeEqualHash(provided: string, storedHexVerifier: string): boolean {
  const providedHash = hashHex(provided);
  return safeEqualHex(providedHash, storedHexVerifier);
}

export class RelayStore {
  private installations = new Map<string, InstallationRecord>();
  private channels = new Map<string, ChannelRecord>(); // keyed by channelId globally
  private messages = new Map<string, MessageRecord>(); // keyed by `${channelId}:${messageNumber}`
  private messagesByInstallation = new Map<string, Set<string>>(); // installationId -> Set of keys

  constructor(private readonly now: () => Date = () => new Date()) {}

  // --- Installation ---

  createInstallation(installationId: string, verifier: string): InstallationRecord {
    const existing = this.installations.get(installationId);
    if (existing) {
      if (!safeEqualHex(existing.verifier, verifier)) {
        throw Object.assign(new Error("installation verifier mismatch"), { statusCode: 409 });
      }
      return existing;
    }
    const rec: InstallationRecord = {
      installationId,
      verifier: verifier.toLowerCase(),
      createdAt: this.now().toISOString(),
    };
    this.installations.set(installationId, rec);
    this.messagesByInstallation.set(installationId, new Set());
    return rec;
  }

  authenticateInstallation(
    installationId: string,
    secret: string,
  ): AuthenticationResult<InstallationRecord> {
    const inst = this.installations.get(installationId);
    if (!inst) return { ok: false, statusCode: 404, error: "unknown installation" };
    if (!safeEqualHash(secret, inst.verifier)) {
      return { ok: false, statusCode: 401, error: "invalid installation secret" };
    }
    return { ok: true, value: inst };
  }

  // --- Channel ---

  createChannel(args: {
    installationId: string;
    channelId: string;
    tokenVerifier: string;
    expiration?: string | null;
    resourceId?: string | null;
  }): ChannelRecord {
    const { installationId, channelId, tokenVerifier, expiration, resourceId } = args;
    if (!this.installations.has(installationId)) {
      throw Object.assign(new Error("unknown installation"), { statusCode: 404 });
    }
    const existing = this.channels.get(channelId);
    if (existing) {
      if (existing.installationId !== installationId) {
        throw Object.assign(new Error("channel id conflict"), { statusCode: 409 });
      }
      if (existing.revokedAt) {
        throw Object.assign(new Error("channel revoked"), { statusCode: 409 });
      }
      if (!safeEqualHex(existing.tokenVerifier, tokenVerifier)) {
        throw Object.assign(new Error("channel verifier mismatch"), { statusCode: 409 });
      }
      existing.resourceId = resourceId ?? existing.resourceId;
      existing.expiration = expiration ?? existing.expiration;
      return existing;
    }
    const rec: ChannelRecord = {
      channelId,
      installationId,
      tokenVerifier: tokenVerifier.toLowerCase(),
      resourceId: resourceId ?? null,
      expiration: expiration ?? null,
      revokedAt: null,
      createdAt: this.now().toISOString(),
    };
    this.channels.set(channelId, rec);
    return rec;
  }

  revokeChannel(installationId: string, channelId: string): void {
    const ch = this.channels.get(channelId);
    if (!ch || ch.installationId !== installationId) {
      throw Object.assign(new Error("unknown channel"), { statusCode: 404 });
    }
    if (ch.revokedAt) return;
    ch.revokedAt = this.now().toISOString();
  }

  private activeChannel(channelId: string): AuthenticationResult<ChannelRecord> {
    const ch = this.channels.get(channelId);
    if (!ch) return { ok: false, statusCode: 404, error: "unknown channel" };
    if (ch.revokedAt) return { ok: false, statusCode: 404, error: "revoked channel" };
    if (ch.expiration) {
      const exp = Date.parse(ch.expiration);
      if (!Number.isNaN(exp) && this.now().getTime() > exp) {
        return { ok: false, statusCode: 410, error: "channel expired" };
      }
    }
    return { ok: true, value: ch };
  }

  authenticateChannel(channelId: string, token: string): AuthenticationResult<ChannelRecord> {
    const active = this.activeChannel(channelId);
    if (!active.ok) return active;
    if (!safeEqualHash(token, active.value.tokenVerifier)) {
      return { ok: false, statusCode: 401, error: "invalid channel token" };
    }
    return active;
  }

  // --- Messages (wake-ups) ---

  isExpired(msg: MessageRecord): boolean {
    return Date.parse(msg.expiresAt) <= this.now().getTime();
  }

  pruneExpired(): void {
    for (const [key, msg] of this.messages) {
      if (this.isExpired(msg)) {
        this.messages.delete(key);
        this.messagesByInstallation.get(msg.installationId)?.delete(key);
      }
    }
    // also prune channels whose expiration passed? Not auto, but push will reject
  }

  appendMessage(
    channel: ChannelRecord,
    args: {
      channelId: string;
      messageNumber: string;
      resourceId: string;
      resourceState: string;
      resourceUri: string | null;
      channelExpiration: string | null;
    },
  ): { created: boolean; record: MessageRecord | null } {
    const key = `${args.channelId}:${args.messageNumber}`;
    const existing = this.messages.get(key);
    if (existing) {
      // Duplicate message number idempotent (issue://80 at-least-once, duplicate wake-ups harmless)
      return { created: false, record: existing };
    }
    const receivedAt = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + RETENTION_MS).toISOString();
    const rec: MessageRecord = {
      installationId: channel.installationId,
      channelId: args.channelId,
      messageNumber: args.messageNumber,
      resourceId: args.resourceId,
      resourceState: args.resourceState,
      resourceUri: args.resourceUri,
      channelExpiration: args.channelExpiration,
      receivedAt,
      expiresAt,
      ack: false,
    };
    this.messages.set(key, rec);
    if (!this.messagesByInstallation.has(channel.installationId)) {
      this.messagesByInstallation.set(channel.installationId, new Set());
    }
    this.messagesByInstallation.get(channel.installationId)!.add(key);
    return { created: true, record: rec };
  }

  listPending(installationId: string): MessageRecord[] {
    this.pruneExpired();
    const keys = this.messagesByInstallation.get(installationId);
    if (!keys) return [];
    const out: MessageRecord[] = [];
    for (const key of keys) {
      const msg = this.messages.get(key);
      if (msg && !msg.ack && !this.isExpired(msg)) out.push(msg);
    }
    // sort by receivedAt then messageNumber numeric
    out.sort((a, b) => {
      const ta = Date.parse(a.receivedAt);
      const tb = Date.parse(b.receivedAt);
      if (ta !== tb) return ta - tb;
      return Number(a.messageNumber) - Number(b.messageNumber);
    });
    return out;
  }

  ackMessages(
    installationId: string,
    acks: Array<{ channelId: string; messageNumber: string }>,
  ): number {
    this.pruneExpired();
    let count = 0;
    for (const { channelId, messageNumber } of acks) {
      const key = `${channelId}:${messageNumber}`;
      const msg = this.messages.get(key);
      if (!msg) continue;
      if (msg.installationId !== installationId) continue; // isolation: ignore cross-installation ack
      if (msg.ack) continue;
      if (this.isExpired(msg)) continue;
      msg.ack = true;
      count++;
    }
    return count;
  }

  // For testing: expose internal counts
  countMessages(): number {
    return this.messages.size;
  }

  // Utility to check forbidden storage: ensure no extra fields stored
  snapshot(): unknown {
    return {
      installations: [...this.installations.values()],
      channels: [...this.channels.values()],
      messages: [...this.messages.values()],
    };
  }
}
