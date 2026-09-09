import { existsSync, readFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { atomicWriteJson } from "../engine/atomic.js";

/**
 * Shell-side relay workspace persistence — issue://80 (relay registration) + ADR-0031.
 * Installation identity+secret generated locally, secret never leaves Workspace except as verifier.
 * Channel identifiers, verifier, expiry persisted for restart recovery.
 */

export interface RelayChannelLocal {
  channelId: string;
  token: string; // plaintext channel token kept locally (not exposed via status)
  resourceId: string | null;
  expiration: string | null; // ISO string
}

export interface RelayWorkspace {
  installationId: string | null;
  secret: string | null; // plaintext installation secret — never exposed via API
  relayBaseUrl: string | null;
  channels: RelayChannelLocal[];
  lastWakeUpAt: string | null;
}

const EMPTY: RelayWorkspace = {
  installationId: null,
  secret: null,
  relayBaseUrl: null,
  channels: [],
  lastWakeUpAt: null,
};

export function hashVerifier(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * The shape every relay address must have, wherever it came from: scheme, host and
 * optional port, with trailing slashes trimmed. A value carrying credentials, a
 * path, a query or a fragment is not an origin and is refused here.
 *
 * The protocol rule is deliberately left to the caller, because Settings and the
 * deployment environment accept different protocols, and so is the failure mode:
 * one reports to a person, the other must never stop the Shell from booting.
 */
export type RelayBaseUrlShape =
  | { ok: true; trimmed: string; url: URL }
  | { ok: false; reason: "unparseable" | "not_bare_origin" };

export function relayBaseUrlShape(value: string): RelayBaseUrlShape {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return { ok: false, reason: "unparseable" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    return { ok: false, reason: "not_bare_origin" };
  }
  return { ok: true, trimmed, url };
}

/**
 * Accept a relay address declared by the operator in the deployment
 * environment. This is not the same input as a URL typed into Settings, which
 * `publicRelayBaseUrl` holds to public HTTPS: the environment value names a
 * service on the operator's own network — the bundled relay is
 * `http://relay:4318`, reachable only on the Compose network — so plain HTTP is
 * accepted here and nowhere else, and then only for an address that cannot be
 * public. Returns null for anything unusable; seeding is a convenience and must
 * never stop the Shell from booting.
 */
export function environmentRelayBaseUrl(value: string): string | null {
  const shape = relayBaseUrlShape(value);
  if (!shape.ok) return null;
  const { trimmed, url } = shape;
  if (url.protocol === "https:") return trimmed;
  if (url.protocol !== "http:") return null;
  // Plain HTTP only where the address cannot be a public one. The installation
  // secret travels as a bearer token, so anything resolvable on the internet
  // must be HTTPS even when the operator declared it: a dotless hostname is a
  // container/service name on the operator's own network (`relay`), and
  // loopback is the local development case.
  const host = url.hostname;
  const privateHost = host === "127.0.0.1" || host === "::1" || host === "localhost";
  return privateHost || !host.includes(".") ? trimmed : null;
}

export class RelayStateStore {
  constructor(private readonly filePath: string) {}

  load(): RelayWorkspace {
    if (!existsSync(this.filePath)) return { ...EMPTY, channels: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<RelayWorkspace>;
      return {
        installationId: typeof parsed.installationId === "string" ? parsed.installationId : null,
        secret: typeof parsed.secret === "string" ? parsed.secret : null,
        relayBaseUrl: typeof parsed.relayBaseUrl === "string" ? parsed.relayBaseUrl : null,
        channels: Array.isArray(parsed.channels)
          ? parsed.channels.filter((c: unknown): c is RelayChannelLocal => {
              if (typeof c !== "object" || c === null) return false;
              const rec = c as Record<string, unknown>;
              return typeof rec.channelId === "string" && typeof rec.token === "string";
            })
          : [],
        lastWakeUpAt: typeof parsed.lastWakeUpAt === "string" ? parsed.lastWakeUpAt : null,
      };
    } catch {
      return { ...EMPTY, channels: [] };
    }
  }

  save(state: RelayWorkspace): void {
    atomicWriteJson(this.filePath, state);
  }

  ensureInstallation(): {
    installationId: string;
    secret: string;
    verifier: string;
    created: boolean;
  } {
    const current = this.load();
    if (current.installationId && current.secret) {
      return {
        installationId: current.installationId,
        secret: current.secret,
        verifier: hashVerifier(current.secret),
        created: false,
      };
    }
    const installationId = randomUUID();
    const secret = randomBytes(32).toString("hex"); // 64 hex chars
    const next: RelayWorkspace = {
      ...current,
      installationId,
      secret,
    };
    this.save(next);
    return { installationId, secret, verifier: hashVerifier(secret), created: true };
  }

  setRelayBaseUrl(url: string): void {
    const current = this.load();
    this.save({ ...current, relayBaseUrl: url });
  }

  setLastWakeUpAt(iso: string | null): void {
    const current = this.load();
    this.save({ ...current, lastWakeUpAt: iso });
  }

  addChannel(channel: RelayChannelLocal): void {
    const current = this.load();
    const exists = current.channels.find((c) => c.channelId === channel.channelId);
    if (exists) {
      // idempotent update
      const nextChannels = current.channels.map((c) =>
        c.channelId === channel.channelId ? channel : c,
      );
      this.save({ ...current, channels: nextChannels });
      return;
    }
    this.save({ ...current, channels: [...current.channels, channel] });
  }

  removeChannel(channelId: string): void {
    const current = this.load();
    this.save({ ...current, channels: current.channels.filter((c) => c.channelId !== channelId) });
  }
}

/**
 * Seed the relay address from the deployment environment on a Workspace that
 * has none, so a fresh `docker compose up` reaches the bundled relay without
 * anyone opening Settings first (issue #109).
 *
 * A stored address always wins. The environment is a default for a Workspace
 * that never had one, never a correction to one an operator chose: overwriting
 * would silently undo that choice on every restart.
 */
export function seedRelayBaseUrlFromEnv(
  workspaceDir: string,
  envBaseUrl: string | undefined,
): string | null {
  if (!envBaseUrl) return null;
  const seeded = environmentRelayBaseUrl(envBaseUrl);
  if (!seeded) return null;
  const store = new RelayStateStore(`${workspaceDir}/relay.json`);
  if (store.load().relayBaseUrl) return null;
  store.setRelayBaseUrl(seeded);
  return seeded;
}
