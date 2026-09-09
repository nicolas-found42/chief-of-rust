import { hashVerifier, type RelayStateStore } from "./state.js";

/**
 * Shell relay client — issue://80 + ADR-0031 + issue://81.
 * Generates installation identity+secret locally, keeps secret in Workspace,
 * registers hashed verifier + channel identifiers with relay, polls + acks.
 */

export interface RelayClientOptions {
  baseUrl: string;
  installationId: string;
  secret: string;
}

export interface RegisterChannelArgs {
  channelId: string;
  token: string; // plaintext, will be hashed to verifier for relay
  expiration?: string | null;
  resourceId?: string | null;
}

export interface RelayMessage {
  channelId: string;
  messageNumber: string;
  resourceId: string;
  resourceState: string;
  resourceUri: string | null;
  channelExpiration: string | null;
  receivedAt: string;
  expiresAt: string;
}

export class RelayClient {
  constructor(private readonly opts: RelayClientOptions) {}

  private authHeader(): string {
    return `Bearer ${this.opts.secret}`;
  }

  private url(path: string): string {
    const base = this.opts.baseUrl.replace(/\/+$/, "");
    return `${base}${path}`;
  }

  async registerInstallation(): Promise<void> {
    const verifier = hashVerifier(this.opts.secret);
    const res = await fetch(this.url("/v1/installations"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId: this.opts.installationId, verifier }),
    });
    if (!res.ok && res.status !== 409) {
      const text = await res.text();
      throw new Error(`register installation failed ${res.status}: ${text}`);
    }
  }

  async registerChannel(args: RegisterChannelArgs): Promise<void> {
    const tokenVerifier = hashVerifier(args.token);
    const res = await fetch(
      this.url(`/v1/installations/${encodeURIComponent(this.opts.installationId)}/channels`),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: this.authHeader(),
        },
        body: JSON.stringify({
          channelId: args.channelId,
          channelTokenVerifier: tokenVerifier,
          expiration: args.expiration ?? undefined,
          resourceId: args.resourceId ?? undefined,
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`register channel failed ${res.status}: ${text}`);
    }
  }

  async revokeChannel(channelId: string): Promise<void> {
    const res = await fetch(
      this.url(
        `/v1/installations/${encodeURIComponent(this.opts.installationId)}/channels/${encodeURIComponent(channelId)}`,
      ),
      {
        method: "DELETE",
        headers: { authorization: this.authHeader() },
      },
    );
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new Error(`revoke channel failed ${res.status}: ${text}`);
    }
  }

  async pollMessages(waitSec = 0): Promise<RelayMessage[]> {
    const url = new URL(
      this.url(`/v1/installations/${encodeURIComponent(this.opts.installationId)}/messages`),
    );
    if (waitSec > 0) url.searchParams.set("wait", String(waitSec));
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { authorization: this.authHeader() },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`poll failed ${res.status}: ${text}`);
    }
    const data = (await res.json()) as { messages: RelayMessage[] };
    return data.messages;
  }

  async ackMessages(acks: Array<{ channelId: string; messageNumber: string }>): Promise<number> {
    if (acks.length === 0) return 0;
    const res = await fetch(
      this.url(`/v1/installations/${encodeURIComponent(this.opts.installationId)}/ack`),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: this.authHeader(),
        },
        body: JSON.stringify({ acks }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ack failed ${res.status}: ${text}`);
    }
    const data = (await res.json()) as { acked: number };
    return data.acked;
  }

  /**
   * Channel replacement — activates new before revoking old (issue://81).
   * Order matters: register new first, verify, then revoke old.
   */
  async replaceChannel(oldChannelId: string, newChannel: RegisterChannelArgs): Promise<void> {
    await this.registerChannel(newChannel);
    if (oldChannelId !== newChannel.channelId) {
      await this.revokeChannel(oldChannelId);
    }
  }
}

export function relayAccess(
  store: RelayStateStore,
  options: { ensureInstallation?: boolean } = {},
): { ok: true; client: RelayClient } | { ok: false; error: string } {
  const initial = store.load();
  if (!initial.relayBaseUrl) {
    return { ok: false, error: "relayBaseUrl not configured" };
  }
  if (options.ensureInstallation) store.ensureInstallation();
  const state = store.load();
  if (!state.relayBaseUrl) {
    return { ok: false, error: "relayBaseUrl not configured" };
  }
  if (!state.installationId || !state.secret) {
    return { ok: false, error: "installation not initialized" };
  }
  return {
    ok: true,
    client: new RelayClient({
      baseUrl: state.relayBaseUrl,
      installationId: state.installationId,
      secret: state.secret,
    }),
  };
}
