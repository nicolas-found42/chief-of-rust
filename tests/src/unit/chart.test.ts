import { describe, expect, it } from "vitest";
import type { TrendPoint } from "@chief-of-staff-demo/shared";
import { chartGeometry, daysBetween } from "../../../apps/web/src/chart";

const point = (day: string, views: number): TrendPoint => ({
  day,
  measuredAt: `${day}T12:00:00.000Z`,
  views,
});

describe("chartGeometry", () => {
  it("draws nothing until there are two measured days", () => {
    expect(chartGeometry([], 100, 20)).toBeNull();
    /* One day is a fact, not a trend. */
    expect(chartGeometry([point("2026-08-01", 10)], 100, 20)).toBeNull();
  });

  it("spans the box, oldest on the left and the largest value at the top", () => {
    const geometry = chartGeometry(
      [point("2026-08-01", 100), point("2026-08-02", 200), point("2026-08-03", 150)],
      120,
      20,
      0,
    )!;
    expect(geometry.points.map((p) => p.x)).toEqual([0, 60, 120]);
    expect(geometry.points.map((p) => p.y)).toEqual([20, 0, 10]);
    expect([geometry.low, geometry.high]).toEqual([100, 200]);
  });

  it("spaces points by real time, so a gap looks like a gap", () => {
    const geometry = chartGeometry(
      [point("2026-08-01", 100), point("2026-08-09", 200)],
      80,
      20,
      0,
    )!;
    /* Eight days apart across a box of eighty: ten units a day, not two points
       jammed to the ends. */
    expect(geometry.points.map((p) => p.x)).toEqual([0, 80]);
    expect(daysBetween("2026-08-01", "2026-08-09")).toBe(8);
  });

  it("breaks the line across a day nobody measured, rather than drawing through it", () => {
    const geometry = chartGeometry(
      [
        point("2026-08-01", 100),
        point("2026-08-02", 110),
        // 2026-08-03: the machine was off. No API returns that day's count.
        point("2026-08-04", 160),
        point("2026-08-05", 170),
      ],
      100,
      20,
    )!;
    expect(geometry.segments.map((segment) => segment.map((p) => p.day))).toEqual([
      ["2026-08-01", "2026-08-02"],
      ["2026-08-04", "2026-08-05"],
    ]);
  });

  it("keeps one line when every day was measured", () => {
    const geometry = chartGeometry(
      [point("2026-08-01", 1), point("2026-08-02", 2), point("2026-08-03", 3)],
      100,
      20,
    )!;
    expect(geometry.segments).toHaveLength(1);
  });

  it("draws a series that never moved down the middle, rather than dividing by zero", () => {
    const geometry = chartGeometry([point("2026-08-01", 500), point("2026-08-02", 500)], 100, 20)!;
    expect(geometry.points.map((p) => p.y)).toEqual([10, 10]);
    expect(geometry.segments).toHaveLength(1);
  });
});
