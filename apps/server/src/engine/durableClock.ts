import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic.js";

/**
 * Shell durable Intake schedule (ADR-0032).
 *
 * Module-owned scheduled wake-ups outside Runs: keyed by Module+occurrence
 * identity, holds due time + opaque Module input, atomically replace/remove,
 * invoked when due, recovery scans due records on boot (covers ADR-0032
 * without blocked Runs).
 *
 * Reference: issue://80 spec, docs/adr/0032.
 */

export interface DurableSchedule {
  module: string;
  key: string;
  dueAt: string;
  input: unknown;
}

function scheduleFile(workspaceDir: string): string {
  return join(workspaceDir, "intake-schedules.json");
}

function readSchedules(workspaceDir: string): DurableSchedule[] {
  const file = scheduleFile(workspaceDir);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is DurableSchedule => {
      if (!entry || typeof entry !== "object") return false;
      const rec = entry as Record<string, unknown>;
      return (
        typeof rec.module === "string" &&
        typeof rec.key === "string" &&
        typeof rec.dueAt === "string" &&
        "input" in rec
      );
    });
  } catch {
    return [];
  }
}

function writeSchedules(workspaceDir: string, schedules: DurableSchedule[]): void {
  const file = scheduleFile(workspaceDir);
  atomicWriteJson(file, schedules);
}

/**
 * Workspace-backed, atomically replaced Intake schedule store.
 *
 * Keyed by `module + key` (Module + occurrence identity). Holds dueAt + opaque
 * Module input. Invoked when due via `due()` scanning; recovery is caller-driven
 * (scan due records on boot).
 */
export class DurableClock {
  constructor(
    private readonly workspaceDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Durably create or atomically replace the schedule for module+key. */
  schedule(record: DurableSchedule): void {
    const schedules = readSchedules(this.workspaceDir);
    const idx = schedules.findIndex((s) => s.module === record.module && s.key === record.key);
    if (idx >= 0) schedules.splice(idx, 1);
    schedules.push({
      module: record.module,
      key: record.key,
      dueAt: record.dueAt,
      input: record.input,
    });
    writeSchedules(this.workspaceDir, schedules);
  }

  /** Atomically remove the schedule for module+key when an event moves/cancels. */
  remove(module: string, key: string): void {
    const schedules = readSchedules(this.workspaceDir);
    const filtered = schedules.filter((s) => !(s.module === module && s.key === key));
    if (filtered.length !== schedules.length) {
      writeSchedules(this.workspaceDir, filtered);
    }
  }

  /** List all schedules, or only for one Module. */
  list(module?: string): DurableSchedule[] {
    const schedules = readSchedules(this.workspaceDir);
    if (module === undefined) return [...schedules];
    return schedules.filter((s) => s.module === module);
  }

  /** All schedules whose dueAt <= now (injected clock). */
  due(now = this.now()): DurableSchedule[] {
    const at = now.getTime();
    return readSchedules(this.workspaceDir).filter((s) => Date.parse(s.dueAt) <= at);
  }
}
