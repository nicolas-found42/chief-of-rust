import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANARY_INTERVAL_MS,
  CANARY_MIN_TARGETS,
  canaryHealthForAdapter,
  isCanaryPromotionEligible,
  type SourceAdapterCanaryTarget,
  type SourceCanaryReceipt,
  type SourceCanaryHealth,
  type SourceCapability,
} from "@chief-of-staff-demo/shared";
import type { SourceAdapter } from "../../source-adapters/source-adapter.js";
import { sanitizeAdapterDiagnostic } from "../../source-adapters/diagnostics.js";

interface CanaryState {
  receipts: SourceCanaryReceipt[];
  lastRunAt: string | null;
}

const EMPTY: CanaryState = { receipts: [], lastRunAt: null };

function isReceipt(value: unknown): value is SourceCanaryReceipt {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SourceCanaryReceipt>;

  return (
    typeof candidate.adapterId === "string" &&
    typeof candidate.adapterVersion === "string" &&
    candidate.target != null &&
    typeof candidate.target.url === "string" &&
    typeof candidate.capability === "string" &&
    typeof candidate.route === "string" &&
    typeof candidate.outcome === "string" &&
    typeof candidate.checkedAt === "string" &&
    typeof candidate.durationMs === "number" &&
    typeof candidate.itemsFound === "number" &&
    candidate.diagnostic != null
  );
}

export class ContentScoutCanaryStore {
  private readonly file: string;

  constructor(
    private readonly workspaceDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = join(this.workspaceDir, "content-scout", "canary-state.json");
  }

  list(): SourceCanaryReceipt[] {
    return this.readState().receipts.slice();
  }

  lastRunAt(): string | null {
    return this.readState().lastRunAt;
  }

  record(receipts: readonly SourceCanaryReceipt[]): void {
    if (receipts.length === 0) return;
    const state = this.readState();
    const merged = [...state.receipts, ...receipts];
    const byAdapter = new Map<string, SourceCanaryReceipt[]>();
    for (const receipt of merged) {
      const list = byAdapter.get(receipt.adapterId) ?? [];
      list.push(receipt);
      byAdapter.set(receipt.adapterId, list);
    }
    const capped: SourceCanaryReceipt[] = [];
    for (const [, list] of byAdapter) {
      list.sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
      const keep = list.slice(-500);
      capped.push(...keep);
    }
    capped.sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
    const latest = [...capped].sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0];
    state.receipts = capped;
    state.lastRunAt = latest?.checkedAt ?? this.now().toISOString();
    this.writeState(state);
  }

  clear(): void {
    this.writeState(structuredClone(EMPTY));
  }

  healthForAdapter(adapter: SourceAdapter): SourceCanaryHealth {
    return canaryHealthForAdapter({ adapter, receipts: this.list(), now: this.now() });
  }

  allHealth(adapters: readonly SourceAdapter[]): SourceCanaryHealth[] {
    return adapters.map((adapter) =>
      canaryHealthForAdapter({ adapter, receipts: this.list(), now: this.now() }),
    );
  }

  promotionEligible(adapter: SourceAdapter, now?: Date): boolean {
    return isCanaryPromotionEligible({ adapter, receipts: this.list(), now: now ?? this.now() });
  }

  private readState(): CanaryState {
    if (!existsSync(this.file)) return structuredClone(EMPTY);
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<CanaryState>;
      const receipts = Array.isArray(parsed.receipts) ? parsed.receipts.filter(isReceipt) : [];
      return {
        receipts,
        lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : null,
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private writeState(state: CanaryState): void {
    mkdirSync(join(this.workspaceDir, "content-scout"), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(temporary, this.file);
  }
}

export interface ContentScoutCanaryRunnerDeps {
  adapters: readonly SourceAdapter[];
  store: ContentScoutCanaryStore;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  /**
   * Called with the target count immediately before a batch reaches the network, so
   * the egress is announced rather than merely reported afterwards (issue #104).
   */
  announce?: (targetCount: number) => void;
  /** Overrides CANARY_INTERVAL_MS when the workspace has configured its own cadence. */
  intervalMs?: () => number;
  /** Adapter ids this workspace declines to contact at all (issue #104). */
  disabledAdapters?: () => readonly string[];
}

export class ContentScoutCanaryRunner {
  private readonly now: () => Date;

  constructor(private readonly deps: ContentScoutCanaryRunnerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async runOnce(): Promise<SourceCanaryReceipt[]> {
    const receipts: SourceCanaryReceipt[] = [];
    const declined = new Set(this.deps.disabledAdapters?.() ?? []);
    const eligible = this.deps.adapters.filter(
      (adapter) =>
        !declined.has(adapter.id) && (adapter.canaryTargets ?? []).length >= CANARY_MIN_TARGETS,
    );
    const targetCount = eligible.reduce(
      (total, adapter) => total + (adapter.canaryTargets ?? []).length,
      0,
    );
    if (targetCount > 0) this.deps.announce?.(targetCount);
    for (const adapter of eligible) {
      const targets = adapter.canaryTargets ?? [];
      for (const target of targets) {
        const receipt = await this.runTarget(adapter, target);
        receipts.push(receipt);
      }
    }
    if (receipts.length > 0) {
      this.deps.store.record(receipts);
    }
    return receipts;
  }

  /**
   * The scheduled batch, which reaches eight third-party services. A workspace that
   * has never run one does not get one from merely starting the Shell (issue #104):
   * the first batch is an explicit `runOnce`, and its timestamp is what puts the
   * workspace on the cadence. Nothing here asks a person, so nothing here starts.
   */
  async checkSchedule(): Promise<SourceCanaryReceipt[] | null> {
    const lastRunAt = this.deps.store.lastRunAt();
    if (!lastRunAt) return null;
    const elapsed = this.now().getTime() - Date.parse(lastRunAt);
    const interval = this.deps.intervalMs?.() ?? CANARY_INTERVAL_MS;
    if (!Number.isFinite(elapsed) || elapsed < interval) {
      return null;
    }
    return await this.runOnce();
  }

  private async runTarget(
    adapter: SourceAdapter,
    target: SourceAdapterCanaryTarget,
  ): Promise<SourceCanaryReceipt> {
    const checkedAt = this.now().toISOString();
    const canaryTarget = {
      id: `canary:${adapter.id}:${target.url}`,
      adapterId: adapter.id,
      label: target.label,
      url: target.url,
      state: "active" as const,
      createdAt: checkedAt,
      archivedAt: null,
      checkpoint: null,
      lastSuccessfulAt: null,
      conditional: null,
    };
    const since = new Date(this.now().getTime() - 24 * 60 * 60 * 1000).toISOString();
    const until = checkedAt;
    const wallStart = Date.now();
    let result;
    try {
      const request = {
        target: canaryTarget,
        since,
        until,
        checkpoint: null,
        conditional: null,
      };
      result = adapter.collectCanary
        ? await adapter.collectCanary(request)
        : await adapter.collect(request);
    } catch (error) {
      const diagnostic = sanitizeAdapterDiagnostic(
        {
          classification: "internal_failure",
          route: target.url,
          status: null,
          contentType: null,
          parserStage: "adapter_boundary",
          responseHash: "",
          adapterVersion: adapter.version,
          startedAt: checkedAt,
          finishedAt: this.now().toISOString(),
          retries: 0,
          affectedCapabilities: ["items"],
          causeChain: [error instanceof Error ? error.message : String(error)],
        },
        adapter.version,
      );
      return {
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        target,
        capability: "items",
        route: diagnostic.route,
        outcome: "internal_failure",
        diagnostic,
        checkedAt,
        durationMs: Date.now() - wallStart,
        itemsFound: 0,
      };
    }
    const diagnostic = sanitizeAdapterDiagnostic(result.diagnostic, adapter.version);
    const durationMs = (() => {
      const start = Date.parse(diagnostic.startedAt);
      const end = Date.parse(diagnostic.finishedAt);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
      return Math.max(0, Date.now() - wallStart);
    })();
    const capability: SourceCapability = diagnostic.affectedCapabilities[0] ?? "items";
    const route = diagnostic.route;
    return {
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      target,
      capability,
      route,
      outcome: result.outcome,
      diagnostic,
      checkedAt,
      durationMs,
      itemsFound: result.items.length,
    };
  }
}
