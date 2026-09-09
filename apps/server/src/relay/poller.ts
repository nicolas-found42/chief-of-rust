import { relayAccess, type RelayMessage } from "./client.js";
import type { RelayStateStore } from "./state.js";

export interface RelayWakeUpPollerOptions {
  store: RelayStateStore;
  processWakeUps: (messages: RelayMessage[]) => Promise<void>;
  waitSeconds?: number;
  idleDelayMs?: number;
  log?: (message: string) => void;
}

/** Shell-owned outbound relay loop. Messages remain buffered until Intake succeeds. */
export class RelayWakeUpPoller {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly waitSeconds: number;
  private readonly idleDelayMs: number;

  constructor(private readonly options: RelayWakeUpPollerOptions) {
    this.waitSeconds = options.waitSeconds ?? 30;
    this.idleDelayMs = options.idleDelayMs ?? 1_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  stop(): void {
    this.running = false;
  }

  /**
   * Resolves when the loop's current poll — and any wake-up processing it
   * started — has settled. The migration gate's quiesce seam (issue #144):
   * arming the gate waits on it before the reset deletes runs/.
   */
  async drain(): Promise<void> {
    await this.loopPromise;
  }

  async pollOnce(waitSeconds = this.waitSeconds): Promise<RelayMessage[]> {
    const access = relayAccess(this.options.store);
    if (!access.ok) return [];
    const client = access.client;
    const messages = await client.pollMessages(waitSeconds);
    if (messages.length === 0) return messages;

    await this.options.processWakeUps(messages);
    await client.ackMessages(
      messages.map(({ channelId, messageNumber }) => ({ channelId, messageNumber })),
    );
    this.options.store.setLastWakeUpAt(messages[messages.length - 1]!.receivedAt);
    return messages;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const messages = await this.pollOnce();
        if (messages.length === 0) await this.delay();
      } catch (error) {
        this.options.log?.(
          `relay poll failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.delay();
      }
    }
  }

  private delay(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.idleDelayMs);
      timer.unref();
    });
  }
}
