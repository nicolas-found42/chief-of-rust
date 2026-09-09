import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DurableClock } from "../../../apps/server/src/engine/durableClock";

let workspaceDir: string;
let clock: DurableClock;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "durable-clock-"));
  clock = new DurableClock(workspaceDir, () => new Date("2026-08-28T09:00:00.000Z"));
});

describe("Shell durable Intake schedules (ADR-0032)", () => {
  it("durably creates and lists a schedule", () => {
    clock.schedule({
      module: "meeting-brief-generator",
      key: "evt1::2026-08-28T15:00:00Z",
      dueAt: new Date("2026-08-28T11:00:00.000Z").toISOString(),
      input: { eventId: "evt1", occurrenceId: "2026-08-28T15:00:00Z" },
    });
    const listed = clock.list("meeting-brief-generator");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.key).toBe("evt1::2026-08-28T15:00:00Z");
  });

  it("atomically replaces on same Module+key", () => {
    const firstDue = new Date("2026-08-28T11:00:00.000Z").toISOString();
    const secondDue = new Date("2026-08-28T12:00:00.000Z").toISOString();
    clock.schedule({
      module: "meeting-brief-generator",
      key: "evt1::2026-08-28T15:00:00Z",
      dueAt: firstDue,
      input: { version: "v1" },
    });
    clock.schedule({
      module: "meeting-brief-generator",
      key: "evt1::2026-08-28T15:00:00Z",
      dueAt: secondDue,
      input: { version: "v2" },
    });
    const listed = clock.list("meeting-brief-generator");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.dueAt).toBe(secondDue);
    expect(listed[0]?.input).toEqual({ version: "v2" });
  });

  it("removes a schedule", () => {
    clock.schedule({
      module: "meeting-brief-generator",
      key: "k1",
      dueAt: new Date("2026-08-28T11:00:00.000Z").toISOString(),
      input: {},
    });
    clock.schedule({
      module: "meeting-brief-generator",
      key: "k2",
      dueAt: new Date("2026-08-28T11:00:00.000Z").toISOString(),
      input: {},
    });
    clock.remove("meeting-brief-generator", "k1");
    const listed = clock.list("meeting-brief-generator");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.key).toBe("k2");
  });

  it("due returns only schedules whose dueAt <= now", () => {
    const now = new Date("2026-08-28T10:00:00.000Z");
    clock.schedule({
      module: "meeting-brief-generator",
      key: "due",
      dueAt: new Date("2026-08-28T09:00:00.000Z").toISOString(),
      input: {},
    });
    clock.schedule({
      module: "meeting-brief-generator",
      key: "future",
      dueAt: new Date("2026-08-28T12:00:00.000Z").toISOString(),
      input: {},
    });
    expect(clock.due(now)).toHaveLength(1);
    expect(clock.due(now)[0]?.key).toBe("due");
  });

  it("recovers across restart (new instance reads same file)", () => {
    clock.schedule({
      module: "meeting-brief-generator",
      key: "evt1::2026-08-28T15:00:00Z",
      dueAt: new Date("2026-08-28T11:00:00.000Z").toISOString(),
      input: { version: "v1" },
    });
    // Simulate restart: new DurableClock with same workspaceDir.
    const restarted = new DurableClock(workspaceDir, () => new Date("2026-08-28T12:00:00.000Z"));
    const due = restarted.due();
    expect(due).toHaveLength(1);
    expect(due[0]?.key).toBe("evt1::2026-08-28T15:00:00Z");
    // Removal also persists.
    restarted.remove("meeting-brief-generator", "evt1::2026-08-28T15:00:00Z");
    const after = new DurableClock(workspaceDir).list("meeting-brief-generator");
    expect(after).toHaveLength(0);
  });

  it("keys by Module + occurrence identity, so same key under different Modules is distinct", () => {
    clock.schedule({
      module: "meeting-brief-generator",
      key: "evt::occ",
      dueAt: new Date("2026-08-28T11:00:00.000Z").toISOString(),
      input: { module: "a" },
    });
    clock.schedule({
      module: "other-module",
      key: "evt::occ",
      dueAt: new Date("2026-08-28T11:00:00.000Z").toISOString(),
      input: { module: "b" },
    });
    expect(clock.list("meeting-brief-generator")).toHaveLength(1);
    expect(clock.list("other-module")).toHaveLength(1);
    expect(clock.list()).toHaveLength(2);
  });
});
