import { describe, expect, it } from "vitest";
import type { RunEvent } from "@chief-of-staff-demo/shared";
import {
  buildTimeline,
  failurePresentation,
  relativeTime,
  runTitle,
} from "../../../apps/web/src/display";
/**
 * The runs list and Home's feed both name Runs through these helpers, so the
 * legacy-filename shapes they must survive are pinned here rather than trusted
 * to whatever the last Drive sync happened to drop (spec D4).
 */
describe("runTitle", () => {
  it("strips extensions, copy prefixes and ISO timestamp tails", () => {
    expect(runTitle("Stand-up - 2026-06-18T13-00-00.000Z.json")).toBe("Stand-up — Jun 18");
  });

  it("reads the colon-separated timestamp shape too", () => {
    expect(runTitle("Weekly review_2026-06-18T13:00-00.md")).toBe("Weekly review — Jun 18");
  });

  it("peels stacked Copy of prefixes", () => {
    expect(runTitle("Copy of Copy of standup meeting.txt")).toBe("standup meeting");
  });

  it("leaves a plain name alone, extension aside", () => {
    expect(runTitle("Board notes.pdf")).toBe("Board notes");
  });

  it("offers the date alone when the name was only a timestamp", () => {
    expect(runTitle("2026-06-18T13-00-00.000Z.json")).toBe("Jun 18");
  });

  it("falls back to Untitled run when there is nothing to show", () => {
    /* Not "Untitled transcript": these helpers name every Module's Runs now. */
    expect(runTitle("")).toBe("Untitled run");
    expect(runTitle("   ")).toBe("Untitled run");
    expect(runTitle(".json")).toBe("Untitled run");
  });
});

describe("failurePresentation", () => {
  it("presents an expired connection as an expected interruption", () => {
    expect(failurePresentation({ connectionState: "expired" })).toEqual({
      stageOutcome: "Stopped",
      bannerClass: "banner-warn",
      bannerRole: "status",
      timelineClass: "status-attention",
      expectedInterruption: true,
      showReconnect: true,
      showRetry: false,
    });
  });

  it("keeps genuine failures visibly distinct from an expiry", () => {
    expect(failurePresentation({})).toEqual({
      stageOutcome: "Failed",
      bannerClass: "banner-error",
      bannerRole: "alert",
      timelineClass: "status-failed",
      expectedInterruption: false,
      showReconnect: false,
      showRetry: true,
    });
  });

  it.each(["disconnected", "unconfigured"] as const)(
    "offers reconnect for a genuine %s connection failure",
    (connectionState) => {
      expect(failurePresentation({ connectionState })).toEqual({
        stageOutcome: "Failed",
        bannerClass: "banner-error",
        bannerRole: "alert",
        timelineClass: "status-failed",
        expectedInterruption: false,
        showReconnect: true,
        showRetry: false,
      });
    },
  );

  it("offers retry after an expired connection has been restored", () => {
    expect(failurePresentation({ connectionState: "expired" }, "connected")).toMatchObject({
      expectedInterruption: true,
      showReconnect: false,
      showRetry: true,
    });
  });

  it("offers retry after a genuine connection failure has been restored", () => {
    expect(failurePresentation({ connectionState: "disconnected" }, "connected")).toMatchObject({
      expectedInterruption: false,
      showReconnect: false,
      showRetry: true,
    });
  });
});

describe("relativeTime", () => {
  const NOW = new Date("2026-08-21T12:00:00Z").getTime();

  it("says just now inside a minute", () => {
    expect(relativeTime("2026-08-21T11:59:40Z", NOW)).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(relativeTime("2026-08-21T11:30:00Z", NOW)).toBe("30 min ago");
    expect(relativeTime("2026-08-21T06:00:00Z", NOW)).toBe("6 h ago");
    expect(relativeTime("2026-08-19T12:00:00Z", NOW)).toBe("2 d ago");
  });

  it("names the day beyond a week, adding the year when it differs", () => {
    expect(relativeTime("2026-08-04T12:00:00Z", NOW)).toBe("Aug 4");
    expect(relativeTime("2025-08-04T12:00:00Z", NOW)).toBe("Aug 4, 2025");
  });

  it("gives up and echoes an unparseable value", () => {
    expect(relativeTime("not-a-date", NOW)).toBe("not-a-date");
  });
});

describe("buildTimeline", () => {
  const started = (stage: string, t: string): RunEvent => ({
    at: t,
    type: "stage_started",
    detail: { stage },
  });
  const failed = (stage: string, t: string, error: string): RunEvent => ({
    at: t,
    type: "stage_failed",
    detail: { stage, error },
  });
  const done = (t: string): RunEvent => ({
    at: t,
    type: "run_done",
    detail: { status: "done" },
  });

  it("renders one entry per stage with human labels, order and durations", () => {
    const timeline = buildTimeline([
      started("convert", "2026-08-21T10:00:00Z"),
      started("extract", "2026-08-21T10:00:05Z"),
      started("outputs", "2026-08-21T10:00:35Z"),
      done("2026-08-21T10:00:40Z"),
    ]);
    expect(timeline.map((entry) => [entry.label, entry.state])).toEqual([
      ["Read transcript", "done"],
      ["Find follow-ups", "done"],
      ["Create tasks & drafts", "done"],
    ]);
    expect(timeline.map((entry) => entry.durationMs)).toEqual([5000, 30000, 5000]);
  });

  it("names an unknown stage by its raw key instead of hiding it", () => {
    const timeline = buildTimeline([
      started("mystery", "2026-08-21T10:00:00Z"),
      done("2026-08-21T10:00:01Z"),
    ]);
    expect(timeline[0].label).toBe("mystery");
  });

  it("marks the open stage of a running run and leaves its duration unset", () => {
    const timeline = buildTimeline([
      started("convert", "2026-08-21T10:00:00Z"),
      started("extract", "2026-08-21T10:00:02Z"),
    ]);
    expect(timeline[0]).toMatchObject({ state: "done", durationMs: 2000 });
    expect(timeline[1]).toMatchObject({ state: "running", durationMs: null });
  });

  it("records the failing stage as failed", () => {
    const timeline = buildTimeline([
      started("convert", "2026-08-21T10:00:00Z"),
      started("extract", "2026-08-21T10:00:03Z"),
      {
        ...failed("extract", "2026-08-21T10:00:09Z", "boom"),
        detail: {
          stage: "extract",
          error: "boom",
          modelBoundary: {
            classification: "request_timeout",
            provider: "openrouter",
            model: "test-model",
          },
        },
      },
      { at: "2026-08-21T10:00:09Z", type: "run_failed", detail: {} },
    ]);
    expect(timeline[1]).toMatchObject({
      state: "failed",
      failureDetail: {
        error: "boom",
        modelBoundary: {
          classification: "request_timeout",
          provider: "openrouter",
          model: "test-model",
        },
      },
    });
  });

  /* What a Stage meant is the Module's own vocabulary and lives in the Module's
     half of the Run detail page. The timeline closes the open Stage on a skip
     and says nothing about why. */
  it("closes the open stage when a Module ends the Run early", () => {
    const timeline = buildTimeline([
      started("convert", "2026-08-21T10:00:00Z"),
      started("extract", "2026-08-21T10:00:01Z"),
      {
        at: "2026-08-21T10:00:07Z",
        type: "classify_skipped",
        detail: { skipReason: "agenda only" },
      },
      { at: "2026-08-21T10:00:07Z", type: "run_done", detail: { status: "skipped" } },
    ]);
    expect(timeline[1]).toMatchObject({ state: "done", durationMs: 6000 });
  });

  it("closes the open stage when the Run becomes blocked", () => {
    const timeline = buildTimeline([
      started("selection", "2026-08-21T10:00:00Z"),
      {
        at: "2026-08-21T10:00:05Z",
        type: "run_blocked",
        detail: { stage: "selection", reason: "Choose an opportunity." },
      },
    ]);
    expect(timeline[0]).toMatchObject({ state: "done", durationMs: 5000 });
  });
  it("sums durations across a retry's second attempt", () => {
    const timeline = buildTimeline([
      started("outputs", "2026-08-21T10:00:00Z"),
      failed("outputs", "2026-08-21T10:00:10Z", "google_expired"),
      { at: "2026-08-21T10:05:00Z", type: "run_reopened", detail: { fromStage: "outputs" } },
      started("outputs", "2026-08-21T10:05:05Z"),
      done("2026-08-21T10:05:20Z"),
    ]);
    expect(timeline[0]).toMatchObject({ state: "done", durationMs: 25000 });
  });
});
