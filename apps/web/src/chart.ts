import type { TrendPoint } from "@chief-of-staff-demo/shared";

/**
 * The geometry of a single-series line, as pure arithmetic over measured days.
 *
 * The one rule that matters here is the gap. A day the machine was off has no
 * measurement and never will — no API returns a past day's view count — so the
 * line is broken across it rather than drawn through it. A straight segment
 * between Friday and Monday is a number nobody measured, and a chart that
 * invents one is worse than a chart with a hole in it.
 */
interface ChartPoint {
  x: number;
  y: number;
  day: string;
  views: number;
}

export interface ChartGeometry {
  /** One polyline per unbroken run of consecutive measured days. */
  segments: ChartPoint[][];
  /** Every point, in order, for the dots and the accessible description. */
  points: ChartPoint[];
  width: number;
  height: number;
  low: number;
  high: number;
}

const DAY_MS = 86_400_000;

/** Whole days from `from` to `to`; both are `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * Lay `points` out in a `width` × `height` box. Null when there is nothing to
 * draw: one measured day is a fact, not a trend, and a chart of it would be a
 * dot pretending to be a line.
 */
export function chartGeometry(
  points: TrendPoint[],
  width: number,
  height: number,
  padding = 4,
): ChartGeometry | null {
  if (points.length < 2) {
    return null;
  }
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const span = Math.max(daysBetween(first.day, last.day), 1);
  const values = points.map((point) => point.views);
  const low = Math.min(...values);
  const high = Math.max(...values);
  /* A flat series would divide by zero; drawing it down the middle says what
     it means — nothing changed. */
  const range = high - low;
  const inner = height - padding * 2;

  const placed: ChartPoint[] = points.map((point) => ({
    /* Spaced by real time, not by index: two days apart looks two days apart,
       so a gap is visible as distance even before the line breaks. */
    x: (daysBetween(first.day, point.day) / span) * width,
    y: range === 0 ? padding + inner / 2 : padding + inner - ((point.views - low) / range) * inner,
    day: point.day,
    views: point.views,
  }));

  const segments: ChartPoint[][] = [];
  let run: ChartPoint[] = [];
  for (let index = 0; index < placed.length; index += 1) {
    const point = placed[index]!;
    const previous = placed[index - 1];
    if (previous && daysBetween(previous.day, point.day) > 1) {
      /* The break. Whatever happened on the days in between, nobody measured
         it, and the chart says so. */
      segments.push(run);
      run = [];
    }
    run.push(point);
  }
  segments.push(run);

  return { segments, points: placed, width, height, low, high };
}
